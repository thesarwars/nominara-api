import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DbModule } from "../../src/db/db.module.js";
import {
  MIGRATION_LEDGER_READERS,
  MIGRATION_LEDGER_SCHEMA,
  MIGRATION_LEDGER_TABLE,
  RUNTIME_ROLES,
} from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { HealthModule } from "../../src/modules/health/health.module.js";
import { MIGRATIONS_DIR_TOKEN } from "../../src/modules/health/health.service.js";
import { configureApp } from "../../src/api/configure-app.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { DEAD_VALKEY_URL } from "../support/test-valkey.js";

// STORY-120 — readiness, exercised AS THE ROLE THAT ACTUALLY RUNS IT.
//
// *** WHY THIS FILE EXISTS, AND WHY test/integration/health-and-readiness.spec.ts
// *** CANNOT STAND IN FOR IT
//
// That file points DATABASE_URL_POOLED at `container.getConnectionUri()` —
// the container SUPERUSER, which owns `_migrations` and can read the ledger
// freely. Every readiness assertion in this repository has been made as a
// role that cannot fail the check. In production the pooled connection is
// `nominara_app` (docker-compose.yml, .env.example), which had no grant on
// the `_migrations` schema at all, so `/health/ready` answered 503 in every
// environment and always had — while the suite stayed green.
//
// The defect's shape is the one this epic keeps producing: a check whose
// SUBJECT differs from the thing that runs in production. So the single
// non-negotiable property of this file is that its pooled connection is
// opened as `nominara_app` and never as the owner — asserted below before
// anything else is, so the file cannot quietly regress into testing the
// owner again.
describe("STORY-120 · readiness as the runtime role", () => {
  let container: StartedPostgreSqlContainer;
  let valkeyFixture: ValkeyFixture;
  const originalEnv = { ...process.env };

  /** The pooled connection as it is deployed: nominara_app, never the owner. */
  function runtimeRoleUri(): string {
    const password = encodeURIComponent(resolvePassword("nominara_app", {}));
    return `postgres://nominara_app:${password}@${container.getHost()}:${container.getMappedPort(5432)}/${container.getDatabase()}`;
  }

  async function ownerClient(): Promise<Client> {
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    return client;
  }

  async function runtimeRoleClient(): Promise<Client> {
    const client = new Client({ connectionString: runtimeRoleUri() });
    await client.connect();
    return client;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    valkeyFixture = await startValkeyFixture();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    await valkeyFixture.stop();
  });

  beforeEach(async () => {
    applyFakeApiEnv();
    // DATABASE_URL stays the OWNER: migrations are DDL and never run as a
    // runtime role. Only the POOLED connection — the one readiness checks
    // out of — becomes nominara_app, exactly as deployed.
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.QUEUE_REDIS_URL = valkeyFixture.connectionString;

    const client = await ownerClient();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client);
    // Migration 0005 deliberately sets no passwords (see its header); mirror
    // src/db/dev-credentials.ts so this file can connect AS nominara_app.
    const password = resolvePassword("nominara_app", {});
    await client.query(`ALTER ROLE nominara_app PASSWORD ${client.escapeLiteral(password)}`);
    await client.end();

    process.env.DATABASE_URL_POOLED = runtimeRoleUri();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // The guard on every other assertion in this file. If DATABASE_URL_POOLED
  // ever drifts back to the owner, this fails first and says why, rather
  // than letting the rest of the file go green for the wrong reason.
  it("the pooled connection this file exercises is nominara_app, not the migration owner", async () => {
    // Deliberately opened from DATABASE_URL_POOLED itself — the variable
    // DbModule's PG_POOL factory reads — and NOT from this file's own
    // runtimeRoleUri() helper. Asserting the helper would only prove the
    // helper, leaving the env var free to drift back to the owner while
    // this guard stayed green: the exact defect shape this file exists to
    // close.
    const pooledUrl = process.env.DATABASE_URL_POOLED;
    expect(pooledUrl, "DATABASE_URL_POOLED must be set for readiness to check anything out").toBeDefined();

    const client = new Client({ connectionString: pooledUrl });
    await client.connect();
    try {
      const result = await client.query<{ current_user: string }>("SELECT current_user");
      expect(result.rows[0]!.current_user, "readiness must be exercised as the role that actually serves").toBe(
        "nominara_app",
      );
    } finally {
      await client.end();
    }
  });

  it("scenario 1 — the migration ledger is readable as the runtime role", async () => {
    const client = await runtimeRoleClient();
    try {
      const result = await client.query<{ name: string }>(`SELECT name FROM ${MIGRATION_LEDGER_TABLE} ORDER BY name`);
      expect(result.rows.length).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  it("scenario 2 — GET /health/ready returns 200 against a fully migrated database", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode, "readiness must succeed for the role that actually serves").toBe(200);
      const body = response.json<{ status: string; migrationVersion: { applied: string | null; matches: boolean } }>();
      expect(body.status).toBe("ready");
      expect(body.migrationVersion.matches).toBe(true);
      // The specific failure this story fixes: the read returned nothing, so
      // `applied` was null and the comparison could never match.
      expect(body.migrationVersion.applied, "the runtime role must be able to SEE the applied set").not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // AC2. A fix that makes readiness always succeed is worse than the bug —
  // it deletes the check instead of repairing it. The build here expects a
  // migration the database has never applied, and readiness must still fail.
  it("scenario 3 — readiness still returns 503 when a migration the build expects is unapplied", async () => {
    const buildDir = await mkdtemp(path.join(tmpdir(), "nominara-story120-expects-more-"));
    try {
      for (const entry of await readdir(MIGRATIONS_DIR)) {
        await writeFile(path.join(buildDir, entry), await readFile(path.join(MIGRATIONS_DIR, entry), "utf8"));
      }
      // A migration this build knows about and the database has never seen.
      await writeFile(path.join(buildDir, "9999_never_applied.up.sql"), "SELECT 1;\n");
      await writeFile(path.join(buildDir, "9999_never_applied.down.sql"), "SELECT 1;\n");

      const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] })
        .overrideProvider(MIGRATIONS_DIR_TOKEN)
        .useValue(buildDir)
        .compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      await configureApp(app);
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      try {
        const response = await app.inject({ method: "GET", url: "/health/ready" });
        expect(response.statusCode, "the probe must still be able to say no").toBe(503);
        const body = response.json<{
          status: string;
          migrationVersion: { applied: string | null; expected: string | null };
        }>();
        expect(body.status).toBe("not_ready");
        // Pin the 503 to the MISMATCH rather than to a failed read. Without
        // these two lines this scenario passes with migration 0015 deleted,
        // so it could not tell the condition it exists to prove from the
        // original bug.
        expect(
          body.migrationVersion.applied,
          "the ledger must have been read for the comparison to mean anything",
        ).not.toBeNull();
        expect(body.migrationVersion.expected).toBe("9999_never_applied");
      } finally {
        await app.close();
      }
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
  });

  // AC3. The runtime role has no business rewriting the record of its own
  // schema, so the grant stops at SELECT.
  //
  // The regex says "permission denied FOR TABLE" deliberately. A bare
  // /permission denied/ also matches "permission denied for schema
  // _migrations", which is the state BEFORE this story's grant — so the
  // loose version passed with migration 0015 deleted, proving only that
  // something was refused rather than that SELECT was granted and writes
  // were not.
  it("scenario 4 — the runtime role cannot write the migration ledger", async () => {
    const client = await runtimeRoleClient();
    try {
      await expect(
        client.query(`INSERT INTO ${MIGRATION_LEDGER_TABLE} (name) VALUES ('0000_forged')`),
        "insert into the ledger",
      ).rejects.toThrow(/permission denied for table/i);
      await expect(
        client.query(`UPDATE ${MIGRATION_LEDGER_TABLE} SET name = '0000_forged'`),
        "update the ledger",
      ).rejects.toThrow(/permission denied for table/i);
      await expect(client.query(`DELETE FROM ${MIGRATION_LEDGER_TABLE}`), "delete from the ledger").rejects.toThrow(
        /permission denied for table/i,
      );
    } finally {
      await client.end();
    }
  });

  // AC3/scenario 5. The grant, inspected rather than inferred from the fact
  // that a read happened to work: USAGE on the schema and SELECT on the
  // ledger, and not one privilege more. Widening the grant is the easy way
  // to make readiness pass and the wrong one.
  it("scenario 5 — the grant is USAGE on the schema and SELECT on the ledger, and nothing more", async () => {
    const client = await ownerClient();
    try {
      const schemaPrivileges = await client.query<{ usage: boolean; create: boolean }>(
        `SELECT has_schema_privilege('nominara_app', $1, 'USAGE') AS usage,
                has_schema_privilege('nominara_app', $1, 'CREATE') AS create`,
        [MIGRATION_LEDGER_SCHEMA],
      );
      expect(schemaPrivileges.rows[0]!.usage, "USAGE on the ledger schema").toBe(true);
      expect(schemaPrivileges.rows[0]!.create, "CREATE on the ledger schema").toBe(false);

      // MAINTAIN is Postgres 17+'s own table privilege; omitting it would let
      // a future VACUUM/REINDEX grant slip past a test whose title is "and
      // nothing more".
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ]) {
        const held = await client.query<{ held: boolean }>(
          "SELECT has_table_privilege('nominara_app', $1, $2) AS held",
          [MIGRATION_LEDGER_TABLE, privilege],
        );
        expect(held.rows[0]!.held, `nominara_app ${privilege} on the ledger`).toBe(privilege === "SELECT");
      }

      // Reading is granted; handing the read on to someone else is not.
      const grantOption = await client.query<{ held: boolean }>(
        "SELECT has_table_privilege('nominara_app', $1, 'SELECT WITH GRANT OPTION') AS held",
        [MIGRATION_LEDGER_TABLE],
      );
      expect(grantOption.rows[0]!.held, "nominara_app must not be able to re-grant its read").toBe(false);
    } finally {
      await client.end();
    }
  });

  // AC4/scenario 7. Every runtime role, decided rather than defaulted —
  // driven by MIGRATION_LEDGER_READERS so the migration and this assertion
  // cannot drift apart: adding a role to that list without a matching grant
  // (or granting one that is not on the list) fails here instead of
  // shipping.
  it("scenario 7 — every runtime role has exactly the ledger access its own row decided", async () => {
    const client = await ownerClient();
    try {
      for (const role of RUNTIME_ROLES) {
        const shouldRead = MIGRATION_LEDGER_READERS.includes(role);

        const usage = await client.query<{ held: boolean }>("SELECT has_schema_privilege($1, $2, 'USAGE') AS held", [
          role,
          MIGRATION_LEDGER_SCHEMA,
        ]);
        expect(usage.rows[0]!.held, `${role} USAGE on ${MIGRATION_LEDGER_SCHEMA}`).toBe(shouldRead);

        const select = await client.query<{ held: boolean }>("SELECT has_table_privilege($1, $2, 'SELECT') AS held", [
          role,
          MIGRATION_LEDGER_TABLE,
        ]);
        expect(select.rows[0]!.held, `${role} SELECT on ${MIGRATION_LEDGER_TABLE}`).toBe(shouldRead);

        // No runtime role writes the ledger — not even the one that reads it.
        for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          const held = await client.query<{ held: boolean }>("SELECT has_table_privilege($1, $2, $3) AS held", [
            role,
            MIGRATION_LEDGER_TABLE,
            privilege,
          ]);
          expect(held.rows[0]!.held, `${role} ${privilege} on the ledger`).toBe(false);
        }
      }
    } finally {
      await client.end();
    }
  });

  // The convergence claim in 0015's own header, executed rather than
  // asserted in prose. `REVOKE ... FROM <named roles>` does not reach a
  // privilege held via the PUBLIC pseudo-role, so this re-runs the migration
  // over the obvious operator quick-fix and proves the wide grant does not
  // survive it. The second-engineer review found this hole by hand; this is
  // the assertion that keeps it closed.
  it("re-applying the migration converges away a hand-widened PUBLIC grant", async () => {
    const client = await ownerClient();
    try {
      await client.query(`GRANT USAGE, CREATE ON SCHEMA ${MIGRATION_LEDGER_SCHEMA} TO PUBLIC`);
      await client.query(`GRANT INSERT, UPDATE, DELETE ON ${MIGRATION_LEDGER_TABLE} TO PUBLIC`);

      // Every runtime role now holds what PUBLIC holds — the state this
      // migration claims it cannot be left in.
      const widened = await client.query<{ held: boolean }>(
        "SELECT has_table_privilege('nominara_portal', $1, 'INSERT') AS held",
        [MIGRATION_LEDGER_TABLE],
      );
      expect(widened.rows[0]!.held, "the setup must actually widen the grant, or this test proves nothing").toBe(true);

      const sql = await readFile(path.join(MIGRATIONS_DIR, "0015_migration_ledger_read_grant.up.sql"), "utf8");
      await client.query(sql);

      for (const role of RUNTIME_ROLES) {
        const create = await client.query<{ held: boolean }>(
          "SELECT has_schema_privilege($1, $2, 'CREATE') AS held",
          [role, MIGRATION_LEDGER_SCHEMA],
        );
        expect(create.rows[0]!.held, `${role} CREATE on the ledger schema after re-apply`).toBe(false);

        for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
          const held = await client.query<{ held: boolean }>("SELECT has_table_privilege($1, $2, $3) AS held", [
            role,
            MIGRATION_LEDGER_TABLE,
            privilege,
          ]);
          expect(held.rows[0]!.held, `${role} ${privilege} on the ledger after re-apply`).toBe(false);
        }
      }

      // ...and the grant the migration exists to make is still in place.
      const select = await client.query<{ held: boolean }>(
        "SELECT has_table_privilege('nominara_app', $1, 'SELECT') AS held",
        [MIGRATION_LEDGER_TABLE],
      );
      expect(select.rows[0]!.held, "convergence must not revoke the grant this migration makes").toBe(true);
    } finally {
      await client.end();
    }
  });

  // A build that ships no migration files at all must not report ready.
  // `expected.every(...)` over an empty list is vacuously true, so readiness
  // would answer 200 against ANY database while expecting nothing — a probe
  // that has stopped comparing. Not reachable through this repository's own
  // Dockerfile (which copies the SQL explicitly), and asserted here so it
  // stays that way.
  it("a build with no migration files is not_ready, never ready-with-no-expectation", async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), "nominara-story120-empty-build-"));
    try {
      const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] })
        .overrideProvider(MIGRATIONS_DIR_TOKEN)
        .useValue(emptyDir)
        .compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      await configureApp(app);
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      try {
        const response = await app.inject({ method: "GET", url: "/health/ready" });
        const body = response.json<{ status: string; migrationVersion: { expected: string | null } }>();
        expect(body.migrationVersion.expected, "the setup must genuinely expect nothing").toBeNull();
        expect(response.statusCode, "a build that expects nothing cannot certify anything").toBe(503);
        expect(body.status).toBe("not_ready");
      } finally {
        await app.close();
      }
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  // STORY-120 review — an UNREACHABLE queue instance must degrade readiness,
  // not silence it. BullMQ requires `maxRetriesPerRequest: null`, so
  // getJobCounts() against a dead address never settles and never throws:
  // before this fix /health/ready produced NO ANSWER AT ALL, which is worse
  // than a 503 because nothing can report it. Confirmed in real compose,
  // where the api container sat unhealthy with no response.
  //
  // The elapsed-time assertion is the point of the test. Without the
  // deadline in queueDepths(), this does not fail with a wrong answer — it
  // hangs until vitest kills it.
  it("an unreachable queue instance degrades readiness instead of hanging it", async () => {
    // A port nothing listens on, chosen the same way the STORY-022 breaker
    // scenario picks one: a connection refused fast, never a black hole.
    process.env.QUEUE_REDIS_URL = DEAD_VALKEY_URL;

    const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    try {
      const startedAt = process.hrtime.bigint();
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      expect(elapsedMs, "readiness must answer, not wait on an unreachable queue").toBeLessThan(10_000);
      // Queue depth is observability, never a readiness gate — so the probe
      // still says ready, with the empty list its own documentation promises.
      expect(response.statusCode).toBe(200);
      const body = response.json<{ status: string; queues: unknown[] }>();
      expect(body.status).toBe("ready");
      expect(body.queues, "an unreachable queue reads as empty, exactly like a failing one").toEqual([]);
    } finally {
      await app.close();
    }
  }, 30_000);

  // AC6/scenario 6. Rollback is clean, and readiness returns to 503 — proven
  // by the ledger read failing for the runtime role, not merely by the
  // version comparison failing (which rolling any migration back would
  // cause anyway, and would therefore prove nothing about the grant).
  it("scenario 6 — rolling the grant migration back revokes the read and returns readiness to 503", async () => {
    // ROLLS BACK UNTIL IT REACHES THE GRANT, rather than assuming the grant
    // is the newest migration. It was when this was written, and STORY-032's
    // 0016 displaced it — the assertion then failed for a reason that had
    // nothing to do with what it tests. A test coupled to "my migration is
    // last" breaks for the next person to add one, and the breakage looks
    // like a readiness defect rather than like ordinary drift.
    const owner = await ownerClient();
    const rolledBack: string[] = [];
    try {
      for (let step = 0; step < 20; step += 1) {
        const name = await rollbackLast(owner);
        if (name === null) break;
        rolledBack.push(name);
        if (/migration_ledger/.test(name)) break;
      }
    } finally {
      await owner.end();
    }
    expect(
      rolledBack.some((name) => /migration_ledger/.test(name)),
      `the ledger grant must have been rolled back; reached ${JSON.stringify(rolledBack)}`,
    ).toBe(true);

    const client = await runtimeRoleClient();
    try {
      await expect(
        client.query(`SELECT name FROM ${MIGRATION_LEDGER_TABLE}`),
        "the read the grant enabled must be gone again",
      ).rejects.toThrow(/permission denied for schema/i);
    } finally {
      await client.end();
    }

    const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      // THE ASSERTION THAT MAKES THIS FILE MEAN ANYTHING. The 503 above is
      // ambiguous on its own: rolling 0015 back also removes it from the
      // applied set, so the version comparison fails for ANY connection, the
      // owner included. `applied` is null only when the READ ITSELF was
      // refused — true for nominara_app, false for the owner.
      //
      // Without this line, moving checkMigrationState onto the direct owner
      // connection — the one change this story forbids by name, and the one
      // that would make migration 0015 dead code — passes all eight tests.
      // The second-engineer review proved exactly that.
      const body = response.json<{ migrationVersion: { applied: string | null } }>();
      expect(
        body.migrationVersion.applied,
        "the probe must read as the RUNTIME role, whose read is now denied",
      ).toBeNull();
    } finally {
      await app.close();
    }
  });
});
