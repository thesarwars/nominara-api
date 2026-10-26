import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-100 AC5 — the report group owns the sweep over `scheduled_reports.next_send_at`, and no other group does.

describe("STORY-100 · bootstrapWorker wires the report sweep ONLY for WORKER_GROUP=report", () => {
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

  it("STORY-100 AC5 · WORKER_GROUP=report starts the sweep, its timer is ARMED, and it stops with the app", async () => {
    process.env.WORKER_GROUP = "report";
    const { bootstrapWorker, REPORT_SWEEP_RUNTIME } = await import("../../src/worker.js");
    const app = await bootstrapWorker();
    let runtime: { armed: boolean } | undefined;
    try {
      const holder = app.get(REPORT_SWEEP_RUNTIME) as { runtime: { armed: boolean } };
      runtime = holder.runtime;
      expect(runtime.armed).toBe(true);
    } finally {
      await app.close();
    }
    expect(runtime?.armed).toBe(false);
  }, 30_000);

  it.each(["capture", "parse", "crawl", "embed", "rollup", "deploy"])("STORY-100 AC5 · WORKER_GROUP=%s never starts the report sweep", async (group) => {
    process.env.WORKER_GROUP = group;
    const { bootstrapWorker, REPORT_SWEEP_RUNTIME } = await import("../../src/worker.js");
    const app = await bootstrapWorker();
    try {
      expect(() => app.get(REPORT_SWEEP_RUNTIME)).toThrow();
    } finally {
      await app.close();
    }
  }, 30_000);
});
