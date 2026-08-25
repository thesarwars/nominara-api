import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Cache } from "../../src/lib/cache/cache.port.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { ValkeyCacheAdapter } from "../../src/lib/cache/valkey-cache.adapter.js";
import { startValkey, type StartedValkey } from "../support/valkey-fixture.js";

// STORY-025 T14 — ONE suite, run against BOTH adapters.
//
// Every idempotency assertion in the repository is written against the
// in-memory adapter, so every one of them is only as sound as the claim that
// the two adapters behave alike. That claim is checked here rather than
// assumed. It is not a hypothetical concern: this repository has already
// shipped a fake more permissive than the real thing it stood in for — a
// FastifyReply without `removeHeader`, which made production throw while the
// suite stayed green (STORY-024 T12).
//
// The properties below are the ones the idempotency store and the token
// buckets actually depend on. If Valkey and the map disagree on any of them,
// this file says so before a deployment does.

let valkey: StartedValkey;
let valkeyAdapter: ValkeyCacheAdapter;

beforeAll(async () => {
  valkey = await startValkey();
  valkeyAdapter = new ValkeyCacheAdapter(valkey.url);
  await valkeyAdapter.connect();
}, 120_000);

afterAll(async () => {
  await valkeyAdapter.onModuleDestroy();
  await valkey.stop();
});

const adapters: readonly [string, () => Cache][] = [
  ["InMemoryCacheAdapter", (): Cache => new InMemoryCacheAdapter()],
  ["ValkeyCacheAdapter", (): Cache => valkeyAdapter],
];

describe.each(adapters)("STORY-025 · the cache port, as implemented by %s", (name, build) => {
  let cache: Cache;
  let prefix: string;
  let counter = 0;

  beforeEach(() => {
    cache = build();
    // The Valkey adapter is shared across cases (one container), so keys are
    // namespaced per case rather than flushed — a FLUSHALL between tests would
    // also be a behaviour the in-memory adapter does not have.
    counter += 1;
    prefix = `${name}:${String(counter)}`;
  });

  const key = (suffix: string): string => `${prefix}:${suffix}`;

  it("returns undefined for a key that was never written", async () => {
    await expect(cache.get(key("absent"))).resolves.toBeUndefined();
  });

  it("round-trips a value", async () => {
    await cache.set(key("k"), "v", { ttlMs: 10_000 });
    await expect(cache.get(key("k"))).resolves.toBe("v");
  });

  it("reports a time-to-live for a key that has one, and none for a key that does not exist", async () => {
    await cache.set(key("k"), "v", { ttlMs: 10_000 });
    const ttl = await cache.timeToLiveMs(key("k"));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
    await expect(cache.timeToLiveMs(key("absent"))).resolves.toBeUndefined();
  });

  it("expires a key when its ttl elapses", async () => {
    await cache.set(key("k"), "v", { ttlMs: 60 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(cache.get(key("k"))).resolves.toBeUndefined();
  });

  describe("onlyIfAbsent — the idempotency claim", () => {
    it("returns true for the winner and false for the loser", async () => {
      await expect(cache.set(key("c"), "first", { ttlMs: 10_000, onlyIfAbsent: true })).resolves.toBe(true);
      await expect(cache.set(key("c"), "second", { ttlMs: 10_000, onlyIfAbsent: true })).resolves.toBe(false);
    });

    it("leaves the winner's value in place", async () => {
      await cache.set(key("c"), "first", { ttlMs: 10_000, onlyIfAbsent: true });
      await cache.set(key("c"), "second", { ttlMs: 10_000, onlyIfAbsent: true });
      await expect(cache.get(key("c"))).resolves.toBe("first");
    });

    it("has exactly one winner among many concurrent claimants", async () => {
      // The property the whole mechanism rests on. Against a read-then-write
      // implementation this is where more than one would win.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_unused, index) =>
          cache.set(key("race"), `claimant-${String(index)}`, { ttlMs: 10_000, onlyIfAbsent: true }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("allows a fresh claim once the previous one expired", async () => {
      await cache.set(key("c"), "first", { ttlMs: 60, onlyIfAbsent: true });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await expect(cache.set(key("c"), "second", { ttlMs: 10_000, onlyIfAbsent: true })).resolves.toBe(true);
    });

    it("overwrites unconditionally when onlyIfAbsent is not requested", async () => {
      await cache.set(key("c"), "first", { ttlMs: 10_000 });
      await cache.set(key("c"), "second", { ttlMs: 10_000 });
      await expect(cache.get(key("c"))).resolves.toBe("second");
    });
  });

  describe("increment — the token bucket", () => {
    it("starts at one and counts up", async () => {
      await expect(cache.increment(key("b"), 10_000)).resolves.toBe(1);
      await expect(cache.increment(key("b"), 10_000)).resolves.toBe(2);
    });

    it("counts every one of many concurrent increments", async () => {
      const results = await Promise.all(
        Array.from({ length: 25 }, () => cache.increment(key("bc"), 10_000)),
      );
      expect(new Set(results).size, "two callers must never receive the same count").toBe(25);
      expect(Math.max(...results)).toBe(25);
    });

    it("does NOT extend the window on a later increment", async () => {
      // A window that slid forward on every request would never close while
      // traffic continued, so a bucket under load would stop limiting exactly
      // when it mattered. Valkey and the map must agree on this or every
      // bucket assertion written against the map is worthless.
      await cache.increment(key("w"), 400);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await cache.increment(key("w"), 400);
      const ttl = await cache.timeToLiveMs(key("w"));
      expect(ttl).toBeLessThanOrEqual(260);
    });

    it("restarts at one after the window closes", async () => {
      await cache.increment(key("r"), 60);
      await cache.increment(key("r"), 60);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await expect(cache.increment(key("r"), 60)).resolves.toBe(1);
    });

    it("counts two keys independently", async () => {
      await cache.increment(key("i1"), 10_000);
      await cache.increment(key("i1"), 10_000);
      await expect(cache.increment(key("i2"), 10_000)).resolves.toBe(1);
    });
  });

  it("deletes a key", async () => {
    await cache.set(key("d"), "v", { ttlMs: 10_000 });
    await cache.delete(key("d"));
    await expect(cache.get(key("d"))).resolves.toBeUndefined();
  });

  it("tolerates deleting a key that does not exist", async () => {
    await expect(cache.delete(key("never"))).resolves.toBeUndefined();
  });
});
