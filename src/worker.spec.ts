import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapWorker, WorkerGroupError } from "./worker.js";

// STORY-022 — NFR-ARCH-06 cold start (<=8s) plus the worker's own
// acceptance criterion: refuses to boot without a valid WORKER_GROUP.
describe("STORY-022 · worker.ts cold start and group selection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("refuses to boot when WORKER_GROUP is unset", async () => {
    delete process.env.WORKER_GROUP;

    await expect(bootstrapWorker()).rejects.toThrow(WorkerGroupError);
  });

  it("boots the application context for a valid WORKER_GROUP in under 8s", async () => {
    process.env.WORKER_GROUP = "capture";

    const start = performance.now();
    const app = await bootstrapWorker();
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(8000);

    await app.close();
  }, 15_000);
});
