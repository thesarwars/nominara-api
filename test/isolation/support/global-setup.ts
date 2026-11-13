import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../../src/db/conventions.js";
import { resolvePassword } from "../../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp, appliedMigrationNames } from "../../../src/db/migrate-runner.js";
import { seedThreeTenantFixture, type ThreeTenantFixture } from "./three-tenant-fixture.js";
import type { IsolationProvidedContext } from "./context.js";
import { assertRecognizedStagingDatabase, parseStagingTarget } from "./staging-target.js";
import { assertWithinBudget } from "./budget.js";

// STORY-012 T2 — ONE shared container, ONE migration chain, ONE fixture
// seed, for the WHOLE `pnpm test:isolation` (or `:breakers`) run — per-file
// containers would blow the D-5 runtime budget. Every non-breaker spec file
// connects to the SAME `nominara_iso_seed` database; every breaker test
// templates its own disposable copy off `nominara_iso_breaker_template`
// (built once here, then never connected to again) so a breaker can never
// contaminate the shared fixture.
//
// T24/D-6 — ISOLATION_TARGET switches between three shapes:
//   local   — the default: this file starts its own disposable container.
//   pooled  — same container/seed as `local`; the POOLING topology itself is
//             exercised by test/isolation/pgbouncer.spec.ts (T23) rather than
//             duplicated for the whole suite a second time (declared here
//             purely so a future story has the env switch to route through
//             instead of inventing a new one).
//   staging — no container, no migration, NO SEEDING AT ALL. Connects to
//             `ISOLATION_STAGING_DATABASE_URL`, refuses to proceed unless
//             `_migrations.applied` proves this suite's own chain created
//             it, and provides an EMPTY fixture — registry.ts's
//             selectAssertionsForTarget filters the runnable set down to
//             read-only, fixture-independent assertions only.

const SUPERUSER = { user: "nominara", password: "nominara" };
const SEED_DATABASE = "nominara_iso_seed";
const BREAKER_TEMPLATE_DATABASE = "nominara_iso_breaker_template";

const EMPTY_TENANT = {
  label: "",
  workspaceId: "",
  ownerUserId: "",
  userIds: [],
  projectIds: [],
  competitorIds: [],
  promptIds: [],
  runIds: [],
  resultIds: [],
  result2Ids: [],
  taskIds: [],
  auditIds: [],
  sourceDomainIds: [],
  shareTokenIds: [],
  subscriptionIds: [],
};
const EMPTY_FIXTURE: ThreeTenantFixture = { a: EMPTY_TENANT, b: EMPTY_TENANT, c: EMPTY_TENANT };

async function ensureGlobalCatalogAndRoles(client: Client): Promise<void> {
  await migrateUp(client, MIGRATIONS_DIR);
  for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
    const password = resolvePassword(role, {});
    await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(password)}`);
  }
}

let container: StartedPostgreSqlContainer | undefined;

async function setupStaging(setupStartedAt: number, project: TestProject): Promise<() => Promise<void>> {
  const url = process.env.ISOLATION_STAGING_DATABASE_URL;
  if (!url) {
    throw new Error("ISOLATION_TARGET=staging requires ISOLATION_STAGING_DATABASE_URL to be set — refusing to guess a target.");
  }
  // Credentials come from the URL itself, never the local-development
  // SUPERUSER pair — a real staging database has real credentials.
  const staging = parseStagingTarget(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  let applied: Set<string>;
  try {
    applied = await appliedMigrationNames(client);
  } finally {
    await client.end();
  }
  assertRecognizedStagingDatabase(applied); // throws loudly if this isn't a database our own chain created

  const provided: IsolationProvidedContext = {
    host: staging.host,
    port: staging.port,
    maintenanceDatabase: staging.database,
    seedDatabase: staging.database,
    breakerTemplateDatabase: "", // staging never runs breakers
    superuser: staging.superuser,
    fixture: EMPTY_FIXTURE, // no seeding against staging, ever
    setupStartedAt,
    target: "staging",
  };
  project.provide("isolation", provided);

  return async () => {
    try {
      assertWithinBudget(Date.now() - setupStartedAt);
    } catch (error) {
      // vitest 4.1.10 does not turn a globalSetup teardown throw into a
      // non-zero process exit code on its own — set it explicitly so a
      // budget overrun actually fails CI.
      process.exitCode = 1;
      throw error;
    }
  };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const target = (process.env.ISOLATION_TARGET as IsolationProvidedContext["target"] | undefined) ?? "local";
  const setupStartedAt = Date.now();

  if (target === "staging") {
    return setupStaging(setupStartedAt, project);
  }

  container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
    .withDatabase("nominara_test")
    .withUsername(SUPERUSER.user)
    .withPassword(SUPERUSER.password)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const maintenanceDatabase = container.getDatabase();

  const maintenance = new Client({ host, port, database: maintenanceDatabase, ...SUPERUSER });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE ${SEED_DATABASE}`);
  } finally {
    await maintenance.end();
  }

  const seed = new Client({ host, port, database: SEED_DATABASE, ...SUPERUSER });
  await seed.connect();
  await ensureGlobalCatalogAndRoles(seed);
  const fixture = await seedThreeTenantFixture(seed);
  await seed.end(); // MUST be fully closed before this database can be used as a TEMPLATE.

  const maintenance2 = new Client({ host, port, database: maintenanceDatabase, ...SUPERUSER });
  await maintenance2.connect();
  try {
    await maintenance2.query(`CREATE DATABASE ${BREAKER_TEMPLATE_DATABASE} TEMPLATE ${SEED_DATABASE}`);
  } finally {
    await maintenance2.end();
  }

  const provided: IsolationProvidedContext = {
    host,
    port,
    maintenanceDatabase,
    seedDatabase: SEED_DATABASE,
    breakerTemplateDatabase: BREAKER_TEMPLATE_DATABASE,
    superuser: SUPERUSER,
    fixture,
    setupStartedAt,
    target,
  };
  project.provide("isolation", provided);

  return async () => {
    // D-5/T25 — the runtime budget assertion. Each of `pnpm test:isolation`
    // and `pnpm test:isolation:breakers` is its own `vitest run` invocation,
    // hence its own fresh global-setup process — measuring wall-clock here,
    // from this SAME setup's start, approximates that invocation's total
    // runtime end to end.
    const elapsedMs = Date.now() - setupStartedAt;
    await container?.stop();
    try {
      assertWithinBudget(elapsedMs);
    } catch (error) {
      // See the staging branch above — vitest 4.1.10 does not set a
      // non-zero exit code from a teardown throw on its own.
      process.exitCode = 1;
      throw error;
    }
  };
}
