import { describe, expect, it } from "vitest";
import { TokenBucket, tokenBucketDecision, type TokenBucketConfig } from "../../../src/lib/engines/token-bucket.js";

// STORY-031 Phase B / D7 — per-engine token-bucket capacity/refill is
// injected config (ENGINE_TOKEN_BUCKETS), never a baked-in default number
// here. These fixture numbers (capacity 5, refill 1/s) are test-only
// choices, not derived from any reference.
const CONFIG: TokenBucketConfig = { capacity: 5, refillPerSecond: 1 };

describe("STORY-031 · tokenBucketDecision — pure algorithm (no I/O, no clock)", () => {
  it("a fresh bucket (no prior state) starts at full capacity and grants", () => {
    const result = tokenBucketDecision(null, CONFIG, 0);
    expect(result.granted).toBe(true);
    expect(result.tokens).toBe(CONFIG.capacity - 1);
    expect(result.retryAfterMs).toBe(0);
  });

  it("exhausting the bucket returns granted:false with a positive retryAfterMs — never throws", () => {
    let state = null as ReturnType<typeof tokenBucketDecision> | null;
    for (let i = 0; i < CONFIG.capacity; i++) {
      state = tokenBucketDecision(state, CONFIG, 0);
      expect(state.granted).toBe(true);
    }
    const exhausted = tokenBucketDecision(state, CONFIG, 0);
    expect(exhausted.granted).toBe(false);
    expect(exhausted.retryAfterMs).toBeGreaterThan(0);
  });

  it("retryAfterMs is exactly the time needed to refill one token, given refillPerSecond", () => {
    const drained = tokenBucketDecision({ tokens: 0, lastRefillMs: 0 }, CONFIG, 0);
    // refillPerSecond=1 → 1 full second to produce the next token.
    expect(drained.retryAfterMs).toBe(1000);
  });

  it("refills over elapsed (fake-clock) time, capped at capacity — never exceeds the ceiling", () => {
    const drained = { tokens: 0, lastRefillMs: 0 };
    // 3 seconds at 1/s should refill 3 tokens, well under capacity 5.
    const partial = tokenBucketDecision(drained, CONFIG, 3000);
    expect(partial.granted).toBe(true);
    expect(partial.tokens).toBeCloseTo(2, 5); // 3 refilled - 1 consumed = 2

    // A huge elapsed gap must cap at capacity, never overflow past it.
    const longGap = tokenBucketDecision(drained, CONFIG, 1_000_000);
    expect(longGap.tokens).toBeCloseTo(CONFIG.capacity - 1, 5);
  });

  it("never grants more than capacity tokens across a burst of instantaneous calls (no elapsed time)", () => {
    let state = null as ReturnType<typeof tokenBucketDecision> | null;
    let grants = 0;
    for (let i = 0; i < CONFIG.capacity + 10; i++) {
      state = tokenBucketDecision(state, CONFIG, 0);
      if (state.granted) grants += 1;
    }
    expect(grants).toBe(CONFIG.capacity);
  });
});

describe("STORY-031 · TokenBucket class — D19 fail-OPEN when the cache Valkey store is unavailable", () => {
  function fakeFailingRedis(): { defineCommand: (name: string, opts: unknown) => void; [key: string]: unknown } {
    const redis: Record<string, unknown> = {
      defineCommand(name: string) {
        redis[name] = async () => {
          throw new Error("ECONNREFUSED: cache instance unreachable");
        };
      },
    };
    return redis as { defineCommand: (name: string, opts: unknown) => void; [key: string]: unknown };
  }

  it("never throws, and grants (fail-open) when the store errors — a rate limiter outage must never hard-fail a capture", async () => {
    const bucket = new TokenBucket(fakeFailingRedis() as never);
    const result = await bucket.tryAcquire("chatgpt", CONFIG);
    expect(result.granted).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });
});
