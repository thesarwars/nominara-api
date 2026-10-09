import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapWorker, WorkerGroupError } from "./worker.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../test/support/test-valkey.js";

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
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";
    process.env.VALKEY_CACHE_URL = testCacheRedisUrl();
    process.env.QUEUE_REDIS_URL = testQueueRedisUrl();
    process.env.ENGINE_TOKEN_BUCKETS = '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}';
    process.env.QUEUE_JOB_SIGNING_KEY = Buffer.alloc(32, 1).toString("base64");
    process.env.QUEUE_JOB_SIGNING_KID = "test-queue-kid-1";
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

  // qa-reviewer finding — D13's "absent ceiling logs a boot warning"
  // (src/lib/engines/spend-meter.ts's warnMissingSpendCeilings) had no
  // production caller anywhere. The capture group is where every other
  // engine-scoped boot concern (the canary) is already wired.
  it("D13: logs a boot warning per active engine missing an ENGINE_SPEND_CEILINGS_USD entry, for the capture group", async () => {
    process.env.WORKER_GROUP = "capture";
    delete process.env.ENGINE_SPEND_CEILINGS_USD;
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const app = await bootstrapWorker();
    try {
      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes("no ENGINE_SPEND_CEILINGS_USD entry for engine 'chatgpt'"))).toBe(true);
    } finally {
      await app.close();
      warnSpy.mockRestore();
    }
  }, 15_000);

  it("E2E-B6d: gemini has a safe default spend ceiling, so no boot warning names it; other engines still warn", async () => {
    process.env.WORKER_GROUP = "capture";
    delete process.env.ENGINE_SPEND_CEILINGS_USD;
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const app = await bootstrapWorker();
    try {
      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes("no ENGINE_SPEND_CEILINGS_USD entry for engine 'gemini'"))).toBe(false);
      expect(messages.some((message) => message.includes("no ENGINE_SPEND_CEILINGS_USD entry for engine 'chatgpt'"))).toBe(true);
    } finally {
      await app.close();
      warnSpy.mockRestore();
    }
  }, 15_000);

  it("does not log a spend-ceiling boot warning for a non-capture group", async () => {
    process.env.WORKER_GROUP = "parse";
    delete process.env.ENGINE_SPEND_CEILINGS_USD;
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const app = await bootstrapWorker();
    try {
      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes("ENGINE_SPEND_CEILINGS_USD"))).toBe(false);
    } finally {
      await app.close();
      warnSpy.mockRestore();
    }
  }, 15_000);
});
