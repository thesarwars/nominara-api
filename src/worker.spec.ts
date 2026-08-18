import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapWorker, WorkerGroupError } from "./worker.js";

// STORY-022 — NFR-ARCH-06 cold start (<=8s) plus the worker's own
// acceptance criterion: refuses to boot without a valid WORKER_GROUP.
describe("STORY-022 · worker.ts cold start and group selection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
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
