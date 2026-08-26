import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostRateLimiter } from "../../src/lib/engines/host-rate-limiter.js";
import { TokenBucket } from "../../src/lib/engines/token-bucket.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-031 Phase C / Test scenario 2 — "Exceed a host's crawl limit →
// Crawl requests throttle independently of engines." Proves disjoint
// keyspaces against a REAL shared Valkey connection: exhausting one never
// throttles the other, in either direction.

describe("STORY-031 · host rate limiter is independent of the engine token bucket", () => {
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

  it("exhausting a host's crawl limit never throttles the engine bucket", async () => {
    const hostLimiter = new HostRateLimiter(redis);
    const tokenBucket = new TokenBucket(redis);

    const firstCrawl = await hostLimiter.tryAcquire("example.com", {});
    expect(firstCrawl.granted).toBe(true);
    const deniedCrawl = await hostLimiter.tryAcquire("example.com", {});
    expect(deniedCrawl.granted).toBe(false);

    // The engine bucket must be entirely unaffected by the host limiter's state.
    const engineLease = await tokenBucket.tryAcquire("chatgpt", { capacity: 5, refillPerSecond: 1 });
    expect(engineLease.granted).toBe(true);
  });

  it("exhausting an engine's token bucket never throttles a host's crawl limit", async () => {
    const hostLimiter = new HostRateLimiter(redis);
    const tokenBucket = new TokenBucket(redis);

    const engineConfig = { capacity: 1, refillPerSecond: 0.001 };
    const firstLease = await tokenBucket.tryAcquire("gemini", engineConfig);
    expect(firstLease.granted).toBe(true);
    const deniedLease = await tokenBucket.tryAcquire("gemini", engineConfig);
    expect(deniedLease.granted).toBe(false);

    // A DIFFERENT host (never touched above) must be entirely unaffected.
    const crawl = await hostLimiter.tryAcquire("another-example.org", {});
    expect(crawl.granted).toBe(true);
  });

  it("two different hosts never share a gate — exhausting one leaves the other's own limit fully available", async () => {
    const hostLimiter = new HostRateLimiter(redis);

    const a1 = await hostLimiter.tryAcquire("host-a.test", {});
    expect(a1.granted).toBe(true);
    const a2 = await hostLimiter.tryAcquire("host-a.test", {});
    expect(a2.granted).toBe(false);

    const b1 = await hostLimiter.tryAcquire("host-b.test", {});
    expect(b1.granted).toBe(true);
  });
});
