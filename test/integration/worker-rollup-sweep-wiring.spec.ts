import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-042 AC2/AC6 — the rollup group owns the closed-day and dirty-date sweep, and no other group does.

describe("STORY-042 · bootstrapWorker wires the rollup sweep ONLY for WORKER_GROUP=rollup", () => {
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

  it("STORY-042 AC2 · WORKER_GROUP=rollup starts the sweep and its timer is ARMED", async () => {
    process.env.WORKER_GROUP = "rollup";
    const { bootstrapWorker, ROLLUP_SWEEP_RUNTIME } = await import("../../src/worker.js");
    const app = await bootstrapWorker();
    try {
      const holder = app.get(ROLLUP_SWEEP_RUNTIME) as { runtime: { armed: boolean } };
      expect(holder.runtime.armed).toBe(true);
    } finally {
      await app.close();
    }
  }, 30_000);

  it.each(["capture", "parse", "crawl", "embed", "report", "deploy"])("STORY-042 AC2 · WORKER_GROUP=%s never starts the rollup sweep", async (group) => {
    process.env.WORKER_GROUP = group;
    const { bootstrapWorker, ROLLUP_SWEEP_RUNTIME } = await import("../../src/worker.js");
    const app = await bootstrapWorker();
    try {
      expect(() => app.get(ROLLUP_SWEEP_RUNTIME)).toThrow();
    } finally {
      await app.close();
    }
  }, 30_000);
});
