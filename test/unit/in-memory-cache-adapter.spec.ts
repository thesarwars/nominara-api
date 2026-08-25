import { describe, expect, it } from "vitest";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";

// STORY-025 T14 — the in-memory adapter stands in for Valkey in every test
// that does not need a container, so its behaviour is load-bearing for every
// assertion built on top of it. These are the properties the idempotency store
// and the token buckets actually depend on; if one of them is wrong, those
// suites go green against a fake that behaves differently from production.

function at(clock: { ms: number }): InMemoryCacheAdapter {
  return new InMemoryCacheAdapter(() => clock.ms);
}

describe("STORY-025 · InMemoryCacheAdapter", () => {
  it("returns undefined for a key that was never written", async () => {
    await expect(new InMemoryCacheAdapter().get("absent")).resolves.toBeUndefined();
  });

  it("expires a key once its ttl has elapsed", async () => {
    const clock = { ms: 1_000 };
    const cache = at(clock);
    await cache.set("k", "v", { ttlMs: 100 });

    clock.ms = 1_099;
    await expect(cache.get("k")).resolves.toBe("v");
    clock.ms = 1_100;
    await expect(cache.get("k")).resolves.toBeUndefined();
  });

  describe("onlyIfAbsent — the whole of the idempotency claim mechanism", () => {
    it("returns false when the key already exists, so the caller knows it LOST", async () => {
      const cache = new InMemoryCacheAdapter();
      await expect(cache.set("k", "first", { ttlMs: 1_000, onlyIfAbsent: true })).resolves.toBe(true);
      await expect(cache.set("k", "second", { ttlMs: 1_000, onlyIfAbsent: true })).resolves.toBe(false);
    });

    it("does not overwrite the winner's value", async () => {
      const cache = new InMemoryCacheAdapter();
      await cache.set("k", "first", { ttlMs: 1_000, onlyIfAbsent: true });
      await cache.set("k", "second", { ttlMs: 1_000, onlyIfAbsent: true });
      await expect(cache.get("k")).resolves.toBe("first");
    });

    it("lets a claim be re-taken once the previous one expired", async () => {
      const clock = { ms: 0 };
      const cache = at(clock);
      await cache.set("k", "first", { ttlMs: 100, onlyIfAbsent: true });
      clock.ms = 100;
      await expect(cache.set("k", "second", { ttlMs: 100, onlyIfAbsent: true })).resolves.toBe(true);
    });

    it("overwrites unconditionally when onlyIfAbsent is not requested", async () => {
      const cache = new InMemoryCacheAdapter();
      await cache.set("k", "first", { ttlMs: 1_000 });
      await cache.set("k", "second", { ttlMs: 1_000 });
      await expect(cache.get("k")).resolves.toBe("second");
    });
  });

  describe("increment — what makes a token bucket count correctly", () => {
    it("starts at one and counts up", async () => {
      const cache = new InMemoryCacheAdapter();
      await expect(cache.increment("b", 1_000)).resolves.toBe(1);
      await expect(cache.increment("b", 1_000)).resolves.toBe(2);
    });

    it("does NOT extend the window on a later increment", async () => {
      // The one that matters. A window sliding forward on every request never
      // closes while traffic continues, so a 60/minute bucket becomes a bucket
      // that never resets — a rate limit that stops working exactly when it is
      // being exercised.
      const clock = { ms: 0 };
      const cache = at(clock);
      await cache.increment("b", 100);
      clock.ms = 90;
      await cache.increment("b", 100);
      await expect(cache.timeToLiveMs("b")).resolves.toBe(10);

      clock.ms = 100;
      await expect(cache.get("b")).resolves.toBeUndefined();
    });

    it("restarts at one after the window closes", async () => {
      const clock = { ms: 0 };
      const cache = at(clock);
      await cache.increment("b", 100);
      await cache.increment("b", 100);
      clock.ms = 100;
      await expect(cache.increment("b", 100)).resolves.toBe(1);
    });

    it("counts two keys independently — one bucket never spends another's capacity", async () => {
      const cache = new InMemoryCacheAdapter();
      await cache.increment("a", 1_000);
      await cache.increment("a", 1_000);
      await expect(cache.increment("b", 1_000)).resolves.toBe(1);
    });
  });

  it("reports no time-to-live for an absent key", async () => {
    await expect(new InMemoryCacheAdapter().timeToLiveMs("absent")).resolves.toBeUndefined();
  });

  it("deletes a key", async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set("k", "v", { ttlMs: 1_000 });
    await cache.delete("k");
    await expect(cache.get("k")).resolves.toBeUndefined();
  });
});
