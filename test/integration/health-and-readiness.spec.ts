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
import { configureApp } from "../../src/api/configure-app.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-022 — HealthModule against a real Postgres (testing-strategy.md §1:
// integration tests never mock the database). Each scenario builds its own
// Nest testing module scoped to DbModule + HealthModule, pointed at the
// shared container via DATABASE_URL/DATABASE_URL_POOLED, and tears it down
// afterward so no scenario's readiness state leaks into the next.
describe("STORY-022 · health/readiness against real Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let valkeyFixture: ValkeyFixture;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDatabaseUrlPooled = process.env.DATABASE_URL_POOLED;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    valkeyFixture = await startValkeyFixture();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
    await valkeyFixture.stop();
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
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";
    process.env.VALKEY_CACHE_URL = "redis://localhost:6379";
    // STORY-030 — DbModule/HealthModule's providers call loadEnv(), which
    // (since Phase B) also requires the queue-signing env vars even though
    // this file never signs a job payload itself.
    process.env.QUEUE_REDIS_URL = valkeyFixture.connectionString;
    process.env.QUEUE_JOB_SIGNING_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.QUEUE_JOB_SIGNING_KID = "test-queue-kid-1";
    // STORY-031 — the NEW second Valkey instance (cache tier). This file
    // never reads it (no token-bucket lease is exercised here) — loadEnv()
    // still requires it present to boot.
    process.env.ENGINE_TOKEN_BUCKETS =
      '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}';

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
    // STORY-030 Task 28 — no longer the reserved-empty array: one entry per
    // documented queue, each a non-negative depth.
    expect(after.queues).toHaveLength(QUEUE_TOPOLOGY.length);
    expect(after.queues.map((q) => q.name).sort()).toEqual(QUEUE_TOPOLOGY.map((e) => e.name).slice().sort());
    for (const queue of after.queues) {
      expect(Number.isInteger(queue.depth)).toBe(true);
      expect(queue.depth).toBeGreaterThanOrEqual(0);
    }
    // STORY-031 Phase I — no longer the reserved-empty array: one entry per
    // active engine. This file never seeds the `engines` table (unlike
    // test/integration/health-engines-summary.spec.ts, which does), so
    // status defaults to "active"; VALKEY_CACHE_URL here is a placeholder
    // address (no real cache fixture in this file), so circuitState falls
    // back to "closed" per D19 — both are the documented, honest defaults,
    // not reserved emptiness.
    expect(after.engines).toHaveLength(6);
    for (const engine of after.engines) {
      expect(engine.status).toBe("active");
      expect(engine.circuitState).toBe("closed");
      expect(engine.healthy).toBe(true);
    }

    await moduleRef.close();
  });

  it("STORY-030 · readiness's queues array reports each queue's real waiting+active depth", async () => {
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    await client.end();

    const prefix = queueKeyPrefix(process.env.NODE_ENV ?? "development");
    const entry = QUEUE_TOPOLOGY.find((candidate) => candidate.name === "credit.reconcile")!; // non-tenant-scoped — no signing envelope needed
    const producerConnection = createQueueWorkerConnection(valkeyFixture.connectionString);
    const queue = buildQueue(entry, { connection: producerConnection, prefix });

    try {
      await enqueueJob(queue, entry, { bucket: "b1" }, { idempotencyKey: "health-depth-test-1" });
      await enqueueJob(queue, entry, { bucket: "b2" }, { idempotencyKey: "health-depth-test-2" });

      const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
      const service = moduleRef.get(HealthService);

      const result = await service.readiness();
      const depth = result.queues.find((q) => q.name === entry.name);
      expect(depth?.depth).toBeGreaterThanOrEqual(2);

      const other = result.queues.find((q) => q.name === "deploy.cms");
      expect(other?.depth).toBe(0);

      await moduleRef.close();
    } finally {
      await queue.close();
      await producerConnection.quit().catch(() => undefined);
    }
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
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // D1 — the health probes are excluded from the /v1 global prefix so the
    // orchestrator keeps unversioned readiness. These stay unprefixed
    // deliberately; this is what proves the exclusion, not an oversight.
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

  // STORY-121 — the second of two independent layers, asserted here so each
  // can be shown to work on its own.
  //
  // realtime-fanout's sibling test proves the DEADLINE keeps the probe
  // answering. This proves the CONNECTION now fails fast, which is the actual
  // fix: point the queue at an unreachable address and readiness still
  // answers, degrading queue depth to the empty list its own documentation
  // promises. Before STORY-121 this hung forever — no rejection, no
  // resolution, nothing to time out — and the container sat unhealthy with no
  // HTTP response at all.
  it("STORY-121 · an unreachable QUEUE instance degrades readiness rather than hanging it", async () => {
    process.env.QUEUE_REDIS_URL = "redis://127.0.0.1:1";

    const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
    const service = moduleRef.get(HealthService);

    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    await client.end();

    try {
      const startedAt = process.hrtime.bigint();
      const result = await service.readiness();
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      expect(elapsedMs, "the probe must answer, not wait on an unreachable queue").toBeLessThan(10_000);
      // Queue depth is observability, never a readiness gate — the database
      // is fine, so the answer is ready with an empty queue list.
      expect(result.status).toBe("ready");
      expect(result.queues, "an unreachable queue reads as empty, exactly like a failing one").toEqual([]);
    } finally {
      await moduleRef.close();
    }
  }, 30_000);

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
