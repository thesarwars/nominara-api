import { DelayedError, type Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { EngineRedelayError, ENGINE_BREAKER_REQUEUE_DELAY_MS } from "../../../src/lib/engines/capture-engine-gate.js";
import { withEngineLease } from "../../../src/lib/engines/engine-lease.js";
import { applyRefillReduction } from "../../../src/lib/engines/refill-reduction.js";
import type { TokenBucket, TokenBucketConfig } from "../../../src/lib/engines/token-bucket.js";

// STORY-031 AC3 (EC-06 stage 4) and AC6 (EC-06 stage 2) at the lease, the one wrapper that holds the job token.
//
// Stage 4: a cell whose engine's breaker is open is RE-QUEUED with a delay, not failed: the handler throws EngineRedelayError
// and the lease moves the job to `delayed` through the same DelayedError path a denied lease takes - no attempt spent, no
// dead-letter entry. It must hold with or without the 429 deferral option.
//
// Stage 2: while a `rate_limited` reduction is active the lease spends from a bucket refilling at half the rate.

function fakeJob() {
  return { progress: 0, moveToDelayed: vi.fn(() => Promise.resolve()), updateProgress: vi.fn(() => Promise.resolve()) } as unknown as Job & {
    moveToDelayed: ReturnType<typeof vi.fn>;
  };
}

const granted = { tryAcquire: vi.fn(() => Promise.resolve({ granted: true, retryAfterMs: 0 })) };

describe("STORY-031 AC3 · an open breaker re-delays the cell instead of failing it", () => {
  for (const deferral of [true, false]) {
    it(`moves the job to delayed by the redelay's own delay and throws DelayedError (429 deferral ${deferral ? "on" : "off"})`, async () => {
      const job = fakeJob();
      const processor = withEngineLease(() => Promise.reject(new EngineRedelayError("gemini", ENGINE_BREAKER_REQUEUE_DELAY_MS)), {
        tokenBucket: granted as unknown as TokenBucket,
        configFor: () => ({ capacity: 1, refillPerSecond: 1 }),
        resolveEngineKey: () => "gemini",
        clock: () => 5_000,
        ...(deferral ? { rateLimitDeferral: { maxDeferrals: 20 } } : {}),
      });
      await expect(processor(job, "tok")).rejects.toBeInstanceOf(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledWith(5_000 + ENGINE_BREAKER_REQUEUE_DELAY_MS, "tok");
    });
  }

  it("does not count as a 429 deferral (job.progress untouched)", async () => {
    const job = fakeJob();
    const processor = withEngineLease(() => Promise.reject(new EngineRedelayError("gemini", 1_000)), {
      tokenBucket: granted as unknown as TokenBucket,
      configFor: () => ({ capacity: 1, refillPerSecond: 1 }),
      resolveEngineKey: () => "gemini",
      rateLimitDeferral: { maxDeferrals: 20 },
    });
    await expect(processor(job, "tok")).rejects.toBeInstanceOf(DelayedError);
    expect((job as unknown as { updateProgress: ReturnType<typeof vi.fn> }).updateProgress).not.toHaveBeenCalled();
  });
});

describe("STORY-031 AC6 · EC-06 stage 2 reaches the bucket the lease spends from", () => {
  it("spends from the reduced config while the reduction is active", async () => {
    const base: TokenBucketConfig = { capacity: 1, refillPerSecond: 0.2 };
    const tryAcquire = vi.fn((_key: string, _config: TokenBucketConfig) => Promise.resolve({ granted: true, retryAfterMs: 0 }));
    const processor = withEngineLease(() => Promise.resolve("ok"), {
      tokenBucket: { tryAcquire } as unknown as TokenBucket,
      configFor: () => base,
      resolveEngineKey: () => "gemini",
      refillReduction: { effectiveConfig: (_key, config) => Promise.resolve(applyRefillReduction(config, 2_000, 1_000)) },
    });
    await expect(processor(fakeJob(), "tok")).resolves.toBe("ok");
    expect(tryAcquire).toHaveBeenCalledWith("gemini", { capacity: 1, refillPerSecond: 0.1 });
  });
});
