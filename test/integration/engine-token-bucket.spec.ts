import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenBucket, type TokenBucketConfig } from "../../src/lib/engines/token-bucket.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-031 Phase B / D6 — the token bucket's real, Lua-atomic path against
// a real Valkey (standing in for the NEW cache instance). Proves what a
// pure-function unit test cannot: that N concurrent tryAcquire calls,
// racing over the SAME network connection, never over-grant past capacity
// (Redis's single-threaded EVAL is the atomicity boundary).

describe("STORY-031 · TokenBucket — real Valkey, concurrency never over-grants", () => {
  let fixture: ValkeyFixture;
  let redis: Redis;

  beforeAll(async () => {
    fixture = await startValkeyFixture();
    redis = new Redis(fixture.connectionString);
  }, 60_000);

  afterAll(async () => {
    await redis.quit().catch(() => undefined);
    await fixture.stop();
  });

  it("50 concurrent tryAcquire calls against a capacity-10 bucket grant exactly 10", async () => {
    const config: TokenBucketConfig = { capacity: 10, refillPerSecond: 0.001 }; // near-zero refill: isolates the concurrency guarantee from any refill during the race
    const bucket = new TokenBucket(redis);

    const results = await Promise.all(Array.from({ length: 50 }, () => bucket.tryAcquire("perplexity", config)));
    const granted = results.filter((r) => r.granted).length;

    expect(granted).toBe(10);
    for (const result of results) {
      if (!result.granted) {
        expect(result.retryAfterMs).toBeGreaterThan(0);
      }
    }
  });

  it("a bucket at capacity ceiling accepts refill over real elapsed time, still never exceeding capacity", async () => {
    const config: TokenBucketConfig = { capacity: 3, refillPerSecond: 20 }; // fast refill (50ms/token) so a short real sleep proves it
    const bucket = new TokenBucket(redis);

    // Drain it.
    for (let i = 0; i < 3; i++) {
      const result = await bucket.tryAcquire("gemini", config);
      expect(result.granted).toBe(true);
    }
    const exhausted = await bucket.tryAcquire("gemini", config);
    expect(exhausted.granted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 200)); // ~4 tokens worth at 20/s — capped at capacity 3

    const results = await Promise.all(Array.from({ length: 10 }, () => bucket.tryAcquire("gemini", config)));
    const granted = results.filter((r) => r.granted).length;
    expect(granted).toBeLessThanOrEqual(config.capacity);
    expect(granted).toBeGreaterThan(0);
  });

  it("disjoint engine keys never share capacity — exhausting one engine's bucket leaves another's untouched", async () => {
    const config: TokenBucketConfig = { capacity: 1, refillPerSecond: 0.001 };
    const bucket = new TokenBucket(redis);

    const first = await bucket.tryAcquire("chatgpt", config);
    expect(first.granted).toBe(true);
    const exhausted = await bucket.tryAcquire("chatgpt", config);
    expect(exhausted.granted).toBe(false);

    const otherEngine = await bucket.tryAcquire("claude", config);
    expect(otherEngine.granted).toBe(true);
  });
});
