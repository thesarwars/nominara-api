import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from "testcontainers";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { DEFAULT_PASSWORDS, resolvePassword } from "../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";

// STORY-010 · shared fixture for test/integration/pgbouncer-transaction-mode.spec.ts
// — the most important test in EPIC-01. Starts a real Postgres (fully
// migrated, 0001-0005) and a real pgBouncer (edoburu/pgbouncer:v1.25.2-p0, the
// same image docker-compose.yml pins) on a private testcontainers Network,
// with pgBouncer loading the EXACT checked-in docker/pgbouncer/pgbouncer.ini
// and userlist.txt — the only two overrides applied are default_pool_size
// and the [databases] line's host/dbname, both necessary to point at this
// disposable per-test Postgres instead of the docker-compose one. Every other
// setting, in particular pool_mode and server_reset_query_always, is
// asserted (by the spec file, via `effectiveIniContent` and `SHOW CONFIG`) to
// have survived unchanged, so the interleaved-tenant test below is exercising
// the SHIPPED config, not a test-only stand-in for it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PGBOUNCER_DIR = path.join(__dirname, "..", "..", "docker", "pgbouncer");
export const PGBOUNCER_IMAGE = "edoburu/pgbouncer:v1.25.2-p0";

// The pgBouncer [databases] section's virtual database NAME (the key on the
// left of `=` in pgbouncer.ini) — what a CLIENT specifies as its `database`
// connection parameter when talking to pgBouncer. This is deliberately
// distinct from the PHYSICAL Postgres database name below: pgBouncer maps
// the former to the latter.
export const POOLER_VIRTUAL_DATABASE = "nominara";
// The physical Postgres database name inside the disposable test container —
// substituted into the [databases] line's `dbname=` value.
export const PHYSICAL_DATABASE_NAME = "nominara_test";
export const POSTGRES_NETWORK_ALIAS = "postgres";

export interface PgBouncerFixture {
  postgres: StartedPostgreSqlContainer;
  pgbouncerContainer: StartedTestContainer;
  /** The exact pgbouncer.ini content actually loaded into the running container. */
  effectiveIniContent: string;
  /** Connects a client THROUGH the pooler, authenticating as `role`. Caller must .connect()/.end(). */
  connectThroughPooler(role: string): Client;
  /** Connects to pgBouncer's virtual admin console. Use client.query(text) with NO params (simple protocol). */
  connectAdmin(): Client;
  stop(): Promise<void>;
}

export async function startPgBouncerFixture(
  options: { defaultPoolSize?: number } = {},
): Promise<PgBouncerFixture> {
  const { defaultPoolSize = 1 } = options;

  const network: StartedNetwork = await new Network().start();

  const postgres = await new PostgreSqlContainer("pgvector/pgvector:pg18")
    .withDatabase(PHYSICAL_DATABASE_NAME)
    .withUsername("nominara")
    .withPassword("nominara")
    .withNetwork(network)
    .withNetworkAliases(POSTGRES_NETWORK_ALIAS)
    .start();

  // Full migration chain (0001-0005) via the REAL, committed migrations —
  // this fixture is about pooling behavior, not migration-file lifecycle, so
  // there is no need to isolate a temp copy the way the DDL specs do.
  const adminClient = new Client({ connectionString: postgres.getConnectionUri() });
  await adminClient.connect();
  try {
    await migrateUp(adminClient, MIGRATIONS_DIR);

    // Migration 0005 deliberately sets NO passwords. Set them here (mirrors
    // src/db/dev-credentials.ts, same DEFAULT_PASSWORDS) so pgBouncer's
    // checked-in userlist.txt entries authenticate successfully both at the
    // client<->pgBouncer hop AND at pgBouncer's own server-side hop into
    // real Postgres.
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      const password = resolvePassword(role, {});
      // client.escapeLiteral, not hand-rolled quote-doubling — see
      // src/db/dev-credentials.ts's identical fix (post-review item 14).
      await adminClient.query(`ALTER ROLE ${role} PASSWORD ${adminClient.escapeLiteral(password)}`);
    }
  } finally {
    await adminClient.end();
  }

  const originalIni = await readFile(path.join(PGBOUNCER_DIR, "pgbouncer.ini"), "utf8");

  const databasesLinePattern = /^nominara = host=postgres port=5432 dbname=nominara$/m;
  const poolSizePattern = /^default_pool_size = \d+$/m;
  if (!databasesLinePattern.test(originalIni) || !poolSizePattern.test(originalIni)) {
    throw new Error(
      "pgbouncer-fixture: expected override pattern(s) not found in docker/pgbouncer/pgbouncer.ini — " +
        "the checked-in file changed shape and this fixture's overrides need updating too.",
    );
  }

  const overriddenIni = originalIni
    .replace(databasesLinePattern, `nominara = host=${POSTGRES_NETWORK_ALIAS} port=5432 dbname=${PHYSICAL_DATABASE_NAME}`)
    .replace(poolSizePattern, `default_pool_size = ${defaultPoolSize}`);

  const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-pgbouncer-fixture-"));
  const overriddenIniPath = path.join(tempDir, "pgbouncer.ini");
  await writeFile(overriddenIniPath, overriddenIni);

  const pgbouncerContainer = await new GenericContainer(PGBOUNCER_IMAGE)
    .withNetwork(network)
    .withNetworkAliases("pgbouncer")
    .withExposedPorts(5432)
    .withCopyFilesToContainer([
      { source: overriddenIniPath, target: "/etc/pgbouncer/pgbouncer.ini" },
      { source: path.join(PGBOUNCER_DIR, "userlist.txt"), target: "/etc/pgbouncer/userlist.txt" },
    ])
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  await rm(tempDir, { recursive: true, force: true });

  const host = pgbouncerContainer.getHost();
  const port = pgbouncerContainer.getMappedPort(5432);

  function connectThroughPooler(role: string): Client {
    const password = DEFAULT_PASSWORDS[role] ?? "nominara";
    return new Client({ host, port, user: role, password, database: POOLER_VIRTUAL_DATABASE });
  }

  function connectAdmin(): Client {
    // admin_users = nominara in the checked-in config; the virtual
    // "pgbouncer" database is always available regardless of [databases].
    return new Client({ host, port, user: "nominara", password: "nominara", database: "pgbouncer" });
  }

  return {
    postgres,
    pgbouncerContainer,
    effectiveIniContent: overriddenIni,
    connectThroughPooler,
    connectAdmin,
    async stop() {
      await pgbouncerContainer.stop();
      await postgres.stop();
      await network.stop();
    },
  };
}
