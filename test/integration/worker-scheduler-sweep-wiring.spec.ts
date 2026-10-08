import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-A-13 AC1 (Option A: in-process runtime in the capture worker) — the sweep
// is wired for WORKER_GROUP=capture and for no other group. Wiring presence only;
// the sweep itself is capture-scheduler-sweep.spec.ts and the :05 UTC timing is
// test/unit/capture-scheduler-sweep.spec.ts. A fake DATABASE_URL is safe: the
// first tick is armed for the next :05 UTC and the app is closed before then.

describe("NEW-A-13 · bootstrapWorker wires the scheduler sweep ONLY for WORKER_GROUP=capture", () => {
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

  it("NEW-A-13 AC1 · WORKER_GROUP=capture starts the sweep, exposed via CAPTURE_SCHEDULER_SWEEP", async () => {
    process.env.WORKER_GROUP = "capture";
    const { bootstrapWorker, CAPTURE_SCHEDULER_SWEEP } = await import("../../src/worker.js");

    const app = await bootstrapWorker();
    try {
      expect(app.get(CAPTURE_SCHEDULER_SWEEP)).toBeDefined();
    } finally {
      await app.close();
    }
  }, 20_000);

  it.each(["parse", "crawl", "embed", "rollup", "report", "deploy"])(
    "NEW-A-13 AC1 · WORKER_GROUP=%s never starts a scheduler sweep",
    async (group) => {
      process.env.WORKER_GROUP = group;
      const { bootstrapWorker, CAPTURE_SCHEDULER_SWEEP } = await import("../../src/worker.js");

      const app = await bootstrapWorker();
      try {
        expect(() => app.get(CAPTURE_SCHEDULER_SWEEP)).toThrow();
      } finally {
        await app.close();
      }
    },
    20_000,
  );
});
