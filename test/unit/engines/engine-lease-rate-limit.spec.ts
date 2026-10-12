import { DelayedError, type Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { CaptureFailureError } from "../../../src/lib/engines/failure-taxonomy.js";
import {
  DEFAULT_RATE_LIMIT_DEFER_MS,
  MAX_RATE_LIMIT_DEFERRALS,
  configForFromEnv,
  geminiPacingConfig,
  withEngineLease,
} from "../../../src/lib/engines/engine-lease.js";
import type { TokenBucket } from "../../../src/lib/engines/token-bucket.js";
import { z } from "zod";
import { envSchema } from "../../../src/config/env.schema.js";

// SCANFIX D3 — pacing against the vendor quota. Two halves: the bucket is wired
// with a rate that comes from GEMINI_REQUESTS_PER_MINUTE (default 10 = the
// free-tier gemini-2.5-flash limit), and a 429 that still gets through is
// DEFERRED by the vendor's Retry-After rather than spent as one of five attempts.

const granted = { tryAcquire: () => Promise.resolve({ granted: true, retryAfterMs: 0 }) } as unknown as TokenBucket;

function fakeJob(progress: unknown = 0) {
  return {
    progress,
    moveToDelayed: vi.fn(() => Promise.resolve()),
    updateProgress: vi.fn(() => Promise.resolve()),
  } as unknown as Job & { moveToDelayed: ReturnType<typeof vi.fn>; updateProgress: ReturnType<typeof vi.fn> };
}

function lease(inner: (job: Job) => Promise<unknown>, over: { defer?: boolean } = {}) {
  return withEngineLease(inner, {
    tokenBucket: granted,
    configFor: () => ({ capacity: 1, refillPerSecond: 1 }),
    resolveEngineKey: () => "gemini",
    clock: () => 1_000_000,
    ...(over.defer === false ? {} : { rateLimitDeferral: { maxDeferrals: MAX_RATE_LIMIT_DEFERRALS } }),
  });
}

describe("SCANFIX-D3 · a 429 defers by the vendor's Retry-After without spending an attempt", () => {
  it("SCANFIX-D3a · rate_limited with Retry-After -> moveToDelayed(now + retryAfter) and a DelayedError", async () => {
    const job = fakeJob();
    const processor = lease(() => Promise.reject(new CaptureFailureError("rate_limited", "gemini", undefined, { retryAfterMs: 17_000 })));

    await expect(processor(job, "tok")).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(1_017_000, "tok");
  });

  it("SCANFIX-D3b · rate_limited with no Retry-After defers by the default", async () => {
    const job = fakeJob();
    const processor = lease(() => Promise.reject(new CaptureFailureError("rate_limited", "gemini")));

    await expect(processor(job, "tok")).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(1_000_000 + DEFAULT_RATE_LIMIT_DEFER_MS, "tok");
  });

  it("SCANFIX-D3c · the deferral count lives in job.progress and is incremented", async () => {
    const job = fakeJob(3);
    const processor = lease(() => Promise.reject(new CaptureFailureError("rate_limited", "gemini")));

    await expect(processor(job, "tok")).rejects.toBeInstanceOf(DelayedError);
    expect(job.updateProgress).toHaveBeenCalledWith(4);
  });

  it("SCANFIX-D3d · past the cap the original error is rethrown, so the retry ladder (and then the terminal record) takes over", async () => {
    const job = fakeJob(MAX_RATE_LIMIT_DEFERRALS);
    const original = new CaptureFailureError("rate_limited", "gemini");
    const processor = lease(() => Promise.reject(original));

    await expect(processor(job, "tok")).rejects.toBe(original);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("SCANFIX-D3e · every other failure is untouched: terminal codes, timeouts and plain errors propagate", async () => {
    for (const error of [new CaptureFailureError("auth_failed", "gemini"), new CaptureFailureError("timeout", "gemini"), new Error("boom")]) {
      const job = fakeJob();
      await expect(lease(() => Promise.reject(error))(job, "tok")).rejects.toBe(error);
      expect(job.moveToDelayed).not.toHaveBeenCalled();
    }
  });

  it("SCANFIX-D3f · a non-numeric progress (BullMQ allows objects) counts as zero deferrals", async () => {
    const job = fakeJob({ pct: 10 });
    await expect(lease(() => Promise.reject(new CaptureFailureError("rate_limited", "gemini")))(job, "t")).rejects.toBeInstanceOf(DelayedError);
    expect(job.updateProgress).toHaveBeenCalledWith(1);
  });

  it("SCANFIX-D3g · deferral is opt-in: without the option a 429 propagates exactly as before", async () => {
    const job = fakeJob();
    const error = new CaptureFailureError("rate_limited", "gemini", undefined, { retryAfterMs: 5_000 });
    await expect(lease(() => Promise.reject(error), { defer: false })(job, "t")).rejects.toBe(error);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("SCANFIX-D3h · a success passes the result through", async () => {
    await expect(lease(() => Promise.resolve("ok"))(fakeJob(), "t")).resolves.toBe("ok");
  });
});

describe("SCANFIX-D3 · the gemini pace is configuration", () => {
  it("SCANFIX-D3i · requests-per-minute becomes a one-token bucket refilling at rpm/60 (no burst above the rate)", () => {
    expect(geminiPacingConfig(10)).toEqual({ capacity: 1, refillPerSecond: 10 / 60 });
    expect(geminiPacingConfig(60)).toEqual({ capacity: 1, refillPerSecond: 1 });
  });

  it("SCANFIX-D3j · gemini's bucket comes from GEMINI_REQUESTS_PER_MINUTE, overriding ENGINE_TOKEN_BUCKETS; other engines still come from the JSON", () => {
    const configFor = configForFromEnv({ gemini: { capacity: 10, refillPerSecond: 1 }, chatgpt: { capacity: 5, refillPerSecond: 2 } }, 10);
    expect(configFor("gemini")).toEqual({ capacity: 1, refillPerSecond: 10 / 60 });
    expect(configFor("chatgpt")).toEqual({ capacity: 5, refillPerSecond: 2 });
  });

  it("SCANFIX-D3k · without a rate, configForFromEnv is exactly what it was", () => {
    expect(configForFromEnv({ gemini: { capacity: 10, refillPerSecond: 1 } })("gemini")).toEqual({ capacity: 10, refillPerSecond: 1 });
  });

  it("SCANFIX-D3l · GEMINI_REQUESTS_PER_MINUTE defaults to 10 and rejects zero, negatives and junk", () => {
    const shape = (envSchema.shape as Record<string, z.ZodType | undefined>)["GEMINI_REQUESTS_PER_MINUTE"]!;
    expect(shape.parse(undefined)).toBe(10);
    expect(shape.parse("6")).toBe(6);
    expect(shape.parse("0.5")).toBe(0.5);
    for (const bad of ["0", "-3", "abc", ""]) expect(shape.safeParse(bad).success).toBe(false);
  });
});
