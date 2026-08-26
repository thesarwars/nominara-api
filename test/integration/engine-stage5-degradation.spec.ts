import { Client, Pool } from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { CoalescingEngineDegradedEmitter } from "../../src/lib/engines/degraded-emitter-coalescing.js";
import { resolveDegradationStage } from "../../src/lib/engines/degradation.js";
import { EngineStatusService } from "../../src/modules/health/engine-status.service.js";
import type { EngineDegradedEmitter } from "../../src/lib/engines/ports.js";

// STORY-031 Phase G — the AC10/stage-5 integration test (EC-06 stage 5,
// labeled "stage 4" in the task brief but matching stage 5's own described
// behavior exactly): "circuit open > 30 min → mark the engine `degraded`;
// emit the degradation event" — written to Postgres, emitted, and the
// emission coalesced to at most 1/minute/engine.

describe("STORY-031 · stage 5 — circuit open > 30 min degrades the engine and emits, coalesced <=1/min", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: EngineStatusService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    await client.end();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    service = new EngineStatusService(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM engines");
    await pool.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key)
       VALUES ('chatgpt', 'chatgpt', 'vendor', 'api', 'v1', 3600, 'medium', 'free')`,
    );
  });

  function fakeEmitter() {
    const calls: string[] = [];
    const emitter: EngineDegradedEmitter = { emit: (engineKey) => calls.push(engineKey) };
    return { emitter, calls };
  }

  it("circuit open for 31 minutes → resolveDegradationStage returns 5 → engines.status becomes 'degraded' and the emitter fires once", async () => {
    const nowRef = { now: 0 };
    const { emitter, calls } = fakeEmitter();
    const coalescing = new CoalescingEngineDegradedEmitter(emitter, 60_000, () => nowRef.now);

    const stage = resolveDegradationStage({
      failureCode: undefined,
      blockRatio: 0,
      circuitOpenDurationMs: 31 * 60 * 1000,
      blackoutDurationMs: null,
    });
    expect(stage).toBe(5);

    if (stage === 5) {
      await service.markDegraded("chatgpt");
      coalescing.emit("chatgpt");
    }

    const result = await pool.query("SELECT status FROM engines WHERE key = 'chatgpt'");
    expect(result.rows[0].status).toBe("degraded");
    expect(calls).toEqual(["chatgpt"]);
  });

  it("re-detecting stage 5 repeatedly within the same minute writes idempotently and emits only once", async () => {
    const nowRef = { now: 0 };
    const { emitter, calls } = fakeEmitter();
    const coalescing = new CoalescingEngineDegradedEmitter(emitter, 60_000, () => nowRef.now);

    for (let i = 0; i < 5; i++) {
      nowRef.now += 5_000;
      await service.markDegraded("chatgpt");
      coalescing.emit("chatgpt");
    }

    const result = await pool.query("SELECT status FROM engines WHERE key = 'chatgpt'");
    expect(result.rows[0].status).toBe("degraded");
    expect(calls).toEqual(["chatgpt"]);
  });

  it("a circuit open for only 29 minutes never degrades — resolveDegradationStage returns null, engines.status stays untouched", async () => {
    const stage = resolveDegradationStage({
      failureCode: undefined,
      blockRatio: 0,
      circuitOpenDurationMs: 29 * 60 * 1000,
      blackoutDurationMs: null,
    });
    expect(stage).toBeNull();

    const result = await pool.query("SELECT status FROM engines WHERE key = 'chatgpt'");
    expect(result.rows[0].status).toBe("active");
  });
});
