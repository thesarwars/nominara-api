import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-031 Phase F — "wire into src/worker.ts bootstrapWorker for the
// capture group only." Fake Postgres/cache-Valkey addresses are safe here:
// pg.Pool/ioredis (lazyConnect) never attempt a connection merely from
// construction, and CanaryRuntime's own poll interval (30s default) never
// fires within this test's lifetime — this test is about WIRING presence,
// not a real tick (see canary-runtime-real.spec.ts for that).

describe("STORY-031 · bootstrapWorker wires a capture canary ONLY for WORKER_GROUP=capture", () => {
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

  it("WORKER_GROUP=capture constructs and starts a CanaryRuntime, exposed via CAPTURE_CANARY_RUNTIME", async () => {
    process.env.WORKER_GROUP = "capture";
    const { bootstrapWorker, CAPTURE_CANARY_RUNTIME } = await import("../../src/worker.js");

    const app = await bootstrapWorker();
    try {
      const runtime = app.get(CAPTURE_CANARY_RUNTIME);
      expect(runtime).toBeDefined();
    } finally {
      await app.close();
    }
  }, 20_000);

  it.each(["parse", "crawl", "embed", "rollup", "report", "deploy"])(
    "WORKER_GROUP=%s never constructs a capture canary at all",
    async (group) => {
      process.env.WORKER_GROUP = group;
      const { bootstrapWorker, CAPTURE_CANARY_RUNTIME } = await import("../../src/worker.js");

      const app = await bootstrapWorker();
      try {
        expect(() => app.get(CAPTURE_CANARY_RUNTIME)).toThrow();
      } finally {
        await app.close();
      }
    },
    20_000,
  );
});
