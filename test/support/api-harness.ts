import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { applyFakeApiEnv } from "./fake-env.js";

// STORY-024 T8 — one boot of the REAL, deployed ApiModule against a real
// Postgres, shared by this story's integration specs.
//
// Extracted rather than copied a sixth time for a measured reason: on
// 2026-08-24 STORY-016 added two required env vars, and the ONE spec file
// that had hand-copied applyFakeApiEnv()'s block died inside DbModule's
// PG_POOL factory with an EnvValidationError — which then masked a genuine
// contract-coverage failure behind an unrelated error. Five more copies of
// that block is five more of the same failure waiting for the next required
// variable. Nothing here stubs a guard, interceptor, pipe or filter: the
// point of these specs is the real composition root.
export const HARNESS_PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
export const HARNESS_PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
export const HARNESS_KID = "test-kid-1";
export const HARNESS_CSRF_SECRET = "test-csrf-secret";

export interface ApiHarness {
  /** The live pg client, reconnected per test. */
  db(): Client;
  /** The booted application, rebuilt per test. */
  app(): NestFastifyApplication;
}

/** Call inside a `describe`. Registers the container/app lifecycle hooks and returns accessors. */
export function useApiHarness(): ApiHarness {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    process.env = { ...originalEnv };
  });

  beforeEach(async () => {
    // Every REQUIRED key from the one shared helper first; this file's own
    // deliberate values after, so they win.
    applyFakeApiEnv();
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = HARNESS_PRIVATE_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = HARNESS_PUBLIC_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_KID = HARNESS_KID;
    process.env.CSRF_SECRET = HARNESS_CSRF_SECRET;
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  afterEach(async () => {
    await app.close();
    await db.end();
  });

  return { db: () => db, app: () => app };
}
