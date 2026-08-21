import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DbModule } from "../../src/db/db.module.js";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { HealthModule } from "../../src/modules/health/health.module.js";
import { HealthService, MIGRATIONS_DIR_TOKEN } from "../../src/modules/health/health.service.js";

// STORY-022 — HealthModule against a real Postgres (testing-strategy.md §1:
// integration tests never mock the database). Each scenario builds its own
// Nest testing module scoped to DbModule + HealthModule, pointed at the
// shared container via DATABASE_URL/DATABASE_URL_POOLED, and tears it down
// afterward so no scenario's readiness state leaks into the next.
describe("STORY-022 · health/readiness against real Postgres", () => {
  let container: StartedPostgreSqlContainer;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDatabaseUrlPooled = process.env.DATABASE_URL_POOLED;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.DATABASE_URL_POOLED = originalDatabaseUrlPooled;
  });

  beforeEach(async () => {
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";
    // STORY-021 — DbModule's PG_POOL factory now calls loadEnv(), which
    // requires this even though this file never touches workspace DEKs.
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";

    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.end();
  });

  it("scenario 1 — liveness reports ok without ever needing a migrated database", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
    const service = moduleRef.get(HealthService);

    expect(service.liveness()).toEqual({ status: "ok" });

    await moduleRef.close();
  });

  it("scenario 2 — readiness is not_ready before migrating, and ready once migrated", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
    const service = moduleRef.get(HealthService);

    const before = await service.readiness();
    expect(before.status).toBe("not_ready");

    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    await client.end();

    const after = await service.readiness();
    expect(after.status).toBe("ready");
    expect(after.migrationVersion.matches).toBe(true);
    expect(after.dependencies).toEqual([{ name: "postgres", state: "closed", healthy: true }]);
    expect(after.queues).toEqual([]);

    await moduleRef.close();
  });

  // Rollback-superset boundary case — an older build instance (this
  // service, pointed at only 0001..0006) querying a database where a NEWER
  // build has already applied 0007 must still report ready: migrations are
  // expand/contract only (backward-compatible), so extra newer migrations
  // never invalidate an older build's own expectations.
  it("boundary — an older build's migration set is a strict subset of what's applied, and is still ready", async () => {
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    await client.end();

    const allFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".up.sql")).sort();
    const olderNames = allFiles.slice(0, -1).map((f) => f.replace(/\.up\.sql$/, ""));
    expect(olderNames.length).toBeGreaterThan(0);
    expect(olderNames.length).toBeLessThan(allFiles.length);

    const olderDir = await mkdtemp(path.join(tmpdir(), "nominara-story022-older-build-"));
    try {
      for (const name of olderNames) {
        for (const ext of ["up", "down"] as const) {
          const content = await readFile(path.join(MIGRATIONS_DIR, `${name}.${ext}.sql`), "utf8");
          await writeFile(path.join(olderDir, `${name}.${ext}.sql`), content);
        }
      }

      const moduleRef = await Test.createTestingModule({
        imports: [DbModule, HealthModule],
      })
        .overrideProvider(MIGRATIONS_DIR_TOKEN)
        .useValue(olderDir)
        .compile();
      const service = moduleRef.get(HealthService);

      const result = await service.readiness();
      expect(result.status).toBe("ready");
      expect(result.migrationVersion.matches).toBe(true);
      expect(result.migrationVersion.expected).toBe(olderNames[olderNames.length - 1]);

      await moduleRef.close();
    } finally {
      await rm(olderDir, { recursive: true, force: true });
    }
  });

  // HealthController.readiness() maps status -> HTTP code via a ternary
  // (503 for not_ready, 200 for ready) that every other test here bypasses
  // by calling HealthService directly. This goes through real HTTP.
  it("GET /health/ready returns HTTP 503 before migrating, and HTTP 200 once migrated", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const before = await app.inject({ method: "GET", url: "/health/ready" });
    expect(before.statusCode).toBe(503);
    expect(before.json().status).toBe("not_ready");

    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    await client.end();

    const after = await app.inject({ method: "GET", url: "/health/ready" });
    expect(after.statusCode).toBe(200);
    expect(after.json().status).toBe("ready");

    await app.close();
  });

  it("scenario 3 — an open circuit breaker is reported as an unhealthy, open postgres dependency", async () => {
    // A port nothing listens on — pool.connect() fails fast (ECONNREFUSED),
    // never hangs. Every one of the breaker's default 20-sample window
    // fails, so it opens deterministically on the 20th call.
    process.env.DATABASE_URL_POOLED = "postgres://nominara:nominara@127.0.0.1:1/nope";

    const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
    const service = moduleRef.get(HealthService);

    let last;
    for (let i = 0; i < 20; i += 1) {
      last = await service.readiness();
    }

    expect(last!.status).toBe("not_ready");
    expect(last!.dependencies).toEqual([{ name: "postgres", state: "open", healthy: false }]);

    await moduleRef.close();
  }, 30_000);
});
