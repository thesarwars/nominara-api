import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-179 — the monitors are driven by the ROLLUP group only. As in worker-canary-wiring.spec.ts the fake Postgres
// address is safe: the pool is lazy and the first tick is a full interval away; this is about wiring, not a tick.

describe("STORY-179 · bootstrapWorker wires the monitor driver ONLY for WORKER_GROUP=rollup", () => {
  let fixture: ValkeyFixture;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    fixture = await startValkeyFixture();
    applyFakeApiEnv();
    process.env.QUEUE_REDIS_URL = fixture.connectionString;
  }, 60_000);

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fixture.stop();
  });

  it("WORKER_GROUP=rollup constructs and starts a MonitorRuntime, exposed via ROLLUP_MONITOR_RUNTIME", async () => {
    process.env.WORKER_GROUP = "rollup";
    const { bootstrapWorker, ROLLUP_MONITOR_RUNTIME } = await import("../../src/worker.js");
    const app = await bootstrapWorker();
    try {
      expect(app.get(ROLLUP_MONITOR_RUNTIME)).toBeDefined();
    } finally {
      await app.close();
    }
  }, 20_000);

  it.each(["capture", "parse", "crawl", "embed", "report", "deploy"])(
    "WORKER_GROUP=%s never constructs the monitor driver",
    async (group) => {
      process.env.WORKER_GROUP = group;
      const { bootstrapWorker, ROLLUP_MONITOR_RUNTIME } = await import("../../src/worker.js");
      const app = await bootstrapWorker();
      try {
        expect(() => app.get(ROLLUP_MONITOR_RUNTIME)).toThrow();
      } finally {
        await app.close();
      }
    },
    20_000,
  );
});
