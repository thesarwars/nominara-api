import { Client } from "pg";
import { Redis } from "ioredis";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DbModule } from "../../src/db/db.module.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { HealthModule } from "../../src/modules/health/health.module.js";
import { HealthService } from "../../src/modules/health/health.service.js";
import { EngineBreakerRegistry } from "../../src/lib/engines/engine-breaker-registry.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { DEAD_VALKEY_URL } from "../support/test-valkey.js";

// STORY-031 Phase I — D16: readiness's `engines[]` array is wired with real
// data (per-engine `engines.status` + breaker `circuitState`). A read
// failure (Postgres OR the cache Valkey) degrades to an empty array,
// NEVER flips `ready` — same posture as STORY-030's D11 for queue depth.

describe("STORY-031 · readiness engines[] — real per-engine status + circuit state", () => {
  let container: StartedPostgreSqlContainer;
  let queueFixture: ValkeyFixture;
  let cacheFixture: ValkeyFixture;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    // No `INSERT INTO engines`: these six ARE the catalog's active engines,
    // and migration 0027 seeds them. This file used to hand-write the same
    // six, which meant the readiness surface was asserted against a world the
    // product did not have. The `status` UPDATE below still belongs here —
    // that is this test's own scenario, not catalog data.
    await client.query("UPDATE engines SET status = 'degraded' WHERE key = 'gemini'");
    await client.end();

    queueFixture = await startValkeyFixture();
    cacheFixture = await startValkeyFixture();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
    await queueFixture.stop();
    await cacheFixture.stop();
  });

  beforeEach(() => {
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";
    process.env.QUEUE_REDIS_URL = queueFixture.connectionString;
    process.env.QUEUE_JOB_SIGNING_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.QUEUE_JOB_SIGNING_KID = "test-queue-kid-1";
    process.env.VALKEY_CACHE_URL = cacheFixture.connectionString;
    process.env.ENGINE_TOKEN_BUCKETS =
      '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reflects real engines.status and a real open breaker for one engine, closed for the rest", async () => {
    const cacheRedis = new Redis(cacheFixture.connectionString);
    const breakers = new EngineBreakerRegistry(cacheRedis);
    await breakers.for("chatgpt").recordOutcome("quota_exhausted"); // forces chatgpt's breaker open

    const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
    try {
      const service = moduleRef.get(HealthService);
      const result = await service.readiness();

      expect(result.engines).toHaveLength(6);

      const chatgpt = result.engines.find((e) => e.engineKey === "chatgpt")!;
      expect(chatgpt.circuitState).toBe("open");
      expect(chatgpt.healthy).toBe(false);

      const gemini = result.engines.find((e) => e.engineKey === "gemini")!;
      expect(gemini.status).toBe("degraded");
      expect(gemini.healthy).toBe(false);

      const claude = result.engines.find((e) => e.engineKey === "claude")!;
      expect(claude.status).toBe("active");
      expect(claude.circuitState).toBe("closed");
      expect(claude.healthy).toBe(true);

      // A per-engine read failure never flips the overall readiness gate —
      // engines[] is observability, same posture as queues[].
      expect(result.status).toBe("ready");
    } finally {
      await moduleRef.close();
      await cacheRedis.quit().catch(() => undefined);
    }
  });

  it("a cache Valkey read failure does NOT blank engines[] — each engine still reports, circuitState falling back to closed (D19), never flips `ready`", async () => {
    process.env.VALKEY_CACHE_URL = DEAD_VALKEY_URL; // unreachable

    const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
    try {
      const service = moduleRef.get(HealthService);
      const result = await service.readiness();

      expect(result.engines).toHaveLength(6);
      for (const engine of result.engines) {
        expect(engine.circuitState).toBe("closed"); // D19's fail-closed-to-last-known default (never having read anything yet)
      }
      const gemini = result.engines.find((e) => e.engineKey === "gemini")!;
      expect(gemini.status).toBe("degraded"); // Postgres data is still valid and still reported
      expect(result.status).toBe("ready");
    } finally {
      await moduleRef.close();
    }
  }, 15_000);

  it("a Postgres read failure SPECIFIC to the engines query degrades engines[] to an empty array — same posture as queues[] (STORY-030 D11) — while the rest of readiness (migration state, unaffected) stays `ready`", async () => {
    // Breaks ONLY the engines-status query (not the whole pool/connection —
    // a genuine whole-pool outage would correctly also flip the overall
    // readiness gate, which is not what this posture is about) by making
    // the `engines` relation temporarily unresolvable.
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("ALTER TABLE engines RENAME TO engines_temporarily_renamed");

    try {
      const moduleRef = await Test.createTestingModule({ imports: [DbModule, HealthModule] }).compile();
      try {
        const service = moduleRef.get(HealthService);
        const result = await service.readiness();

        expect(result.engines).toEqual([]);
        expect(result.status).toBe("ready");
      } finally {
        await moduleRef.close();
      }
    } finally {
      await client.query("ALTER TABLE engines_temporarily_renamed RENAME TO engines");
      await client.end();
    }
  }, 15_000);
});
