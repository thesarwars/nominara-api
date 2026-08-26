import { describe, expect, it } from "vitest";
import {
  HOST_RATE_LIMIT_MIN_INTERVAL_MS,
  HostRateLimiter,
  hostRateLimiterDecision,
} from "../../../src/lib/engines/host-rate-limiter.js";

// STORY-031 Phase C / D8 — aux-and-geo-analysis.md politeness section /
// FR-AUX-01c: ≤2 req/sec/host, a 500ms minimum interval, and `Crawl-delay`
// honored only to INCREASE the interval, never below the 500ms floor.
// These three numbers are reference constants, pinned exactly — not an
// interpolation.

describe("STORY-031 · hostRateLimiterDecision — pure algorithm (no I/O, no clock)", () => {
  it("D8 — the floor is exactly 500ms", () => {
    expect(HOST_RATE_LIMIT_MIN_INTERVAL_MS).toBe(500);
  });

  it("a fresh host (no prior state) is granted immediately", () => {
    const result = hostRateLimiterDecision(null, {}, 1_000);
    expect(result.granted).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it("a second request before the 500ms floor elapses is denied with the exact remaining wait", () => {
    const first = hostRateLimiterDecision(null, {}, 1_000);
    const second = hostRateLimiterDecision(first.nextAllowedAt, {}, 1_300);
    expect(second.granted).toBe(false);
    expect(second.retryAfterMs).toBe(200); // 1500 (gate) - 1300 (now)
  });

  it("a request exactly at the 500ms boundary is granted (>=, not >)", () => {
    const first = hostRateLimiterDecision(null, {}, 1_000);
    const second = hostRateLimiterDecision(first.nextAllowedAt, {}, 1_500);
    expect(second.granted).toBe(true);
  });

  it("a Crawl-delay LARGER than 500ms increases the effective interval", () => {
    const first = hostRateLimiterDecision(null, { crawlDelayMs: 2_000 }, 1_000);
    expect(first.nextAllowedAt).toBe(3_000);
    const second = hostRateLimiterDecision(first.nextAllowedAt, { crawlDelayMs: 2_000 }, 1_600);
    expect(second.granted).toBe(false);
    expect(second.retryAfterMs).toBe(1_400);
  });

  it("a Crawl-delay SMALLER than 500ms never decreases the interval below the floor", () => {
    const first = hostRateLimiterDecision(null, { crawlDelayMs: 100 }, 1_000);
    expect(first.nextAllowedAt).toBe(1_500); // floor wins, not 1100
  });

  it("≤2 req/sec/host — 10 consecutive requests spaced at exactly the floor never exceed 2/sec", () => {
    let nextAllowedAt: number | null = null;
    let now = 0;
    let grantedCount = 0;
    for (let i = 0; i < 10; i++) {
      const result = hostRateLimiterDecision(nextAllowedAt, {}, now);
      if (result.granted) grantedCount += 1;
      nextAllowedAt = result.nextAllowedAt;
      now += HOST_RATE_LIMIT_MIN_INTERVAL_MS;
    }
    expect(grantedCount).toBe(10); // exactly at the floor, every request lands right on the gate
  });
});

describe("STORY-031 · HostRateLimiter class — fails OPEN when the cache Valkey store is unavailable (same posture as the token bucket, D19's spirit extended to this limiter)", () => {
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

  it("never throws, and grants (fail-open) when the store errors", async () => {
    const limiter = new HostRateLimiter(fakeFailingRedis() as never);
    const result = await limiter.tryAcquire("example.com", {});
    expect(result.granted).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });
});
