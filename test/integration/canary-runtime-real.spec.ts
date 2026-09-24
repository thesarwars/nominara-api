import { Client, Pool } from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { CanaryRuntime } from "../../src/lib/engines/canary-runtime.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { waitFor } from "../support/queue-test-harness.js";

// STORY-031 Phase F — the REAL end-to-end wiring (Postgres + cache Valkey),
// as opposed to canary-runtime.spec.ts's fake-object orchestration proof.
// A short pollIntervalMs (unlike production's 30s default) so the test
// doesn't need to wait a real half-minute for the first tick.

describe("STORY-031 · CanaryRuntime — real Postgres + real cache Valkey, end to end", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let cacheFixture: ValkeyFixture;
  let cacheRedis: Redis;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    // ⚠ NO `INSERT INTO engines` HERE ANY MORE. `engine_health.engine_key`
    // FK-references `engines(key)`, and migration 0027 seeds the catalog, so
    // the rows this needs already exist by the time `migrateUp` returns.
    // Re-inserting them is a duplicate-key error, and hand-seeding a row the
    // product ships is how the empty catalog stayed invisible for so long.
    await client.end();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    cacheFixture = await startValkeyFixture();
    cacheRedis = new Redis(cacheFixture.connectionString);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await cacheRedis.quit().catch(() => undefined);
    await cacheFixture.stop();
    await container.stop();
  });

  it("a running CanaryRuntime writes an engine_health row for a probed engine, with no customer job involved", async () => {
    const runtime = new CanaryRuntime({
      pool,
      cacheRedis,
      engines: ["chatgpt"],
      pollIntervalMs: 100,
    });

    runtime.start();
    try {
      await waitFor(
        async () => {
          const result = await pool.query("SELECT * FROM engine_health WHERE engine_key = 'chatgpt'");
          return (result.rowCount ?? 0) > 0;
        },
        { timeoutMs: 5_000, label: "an engine_health row for chatgpt written by the canary" },
      );

      const result = await pool.query("SELECT attempts, circuit_state FROM engine_health WHERE engine_key = 'chatgpt'");
      expect(Number(result.rows[0].attempts)).toBeGreaterThanOrEqual(1);
      expect(["closed", "open", "half_open"]).toContain(result.rows[0].circuit_state);
    } finally {
      runtime.stop();
    }
  }, 15_000);
});
