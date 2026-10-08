import { describe, expect, it, vi } from "vitest";
import { PORTAL_CACHE_TTL_MS, PortalCache, portalCacheKey } from "./portal-cache.js";

// NEW-E-099a — integrations-and-sharing.md NFR-AGY-03/04: a 60-second per-token cache whose key always includes token_id.
const ws = "0198f6a0-0000-7000-8000-000000000001";
const t1 = "0198f6a0-0000-7000-8000-0000000000a1";
const t2 = "0198f6a0-0000-7000-8000-0000000000a2";
const base = { workspaceId: ws, route: "growth-map", project: "0198f6a0-0000-7000-8000-0000000000b1", timeframe: "30d", policy: "hc0-hk0-lock0-theme0" } as const;

describe("NEW-E-099a · portalCacheKey", () => {
  it("STORY-098 s22 / STORY-099 s15 · the same path under two tokens yields two keys; the key contains the token id", () => {
    const a = portalCacheKey("test", { ...base, tokenId: t1 });
    const b = portalCacheKey("test", { ...base, tokenId: t2 });
    expect(a).not.toBe(b);
    expect(a).toContain(t1);
    expect(b).toContain(t2);
  });

  it("every dimension of the response is in the key: route, project, timeframe, the token's policy", () => {
    const k = (over: Partial<typeof base>) => portalCacheKey("test", { ...base, tokenId: t1, ...over });
    const keys = new Set([k({}), k({ route: "matrix" }), k({ project: "0198f6a0-0000-7000-8000-0000000000b2" }), k({ timeframe: "7d" }), k({ policy: "hc1-hk0-lock0-theme0" })]);
    expect(keys.size).toBe(5);
  });

  it("is tenant-keyed: it begins with the env and the workspace id", () => {
    expect(portalCacheKey("test", { ...base, tokenId: t1 }).startsWith(`test:${ws}:`)).toBe(true);
  });
});

describe("NEW-E-099a · PortalCache", () => {
  it("NFR-AGY-03 · computes once inside the 60 s window, and again after it", async () => {
    const cache = new PortalCache();
    const compute = vi.fn(async () => ({ n: 1 }));
    expect(PORTAL_CACHE_TTL_MS).toBe(60_000);
    await cache.getOrCompute("k", compute, 0);
    await cache.getOrCompute("k", compute, PORTAL_CACHE_TTL_MS - 1);
    expect(compute).toHaveBeenCalledTimes(1);
    await cache.getOrCompute("k", compute, PORTAL_CACHE_TTL_MS);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("STORY-098 s22 · two tokens on the same path each compute; neither is served the other's value", async () => {
    const cache = new PortalCache();
    const k1 = portalCacheKey("test", { ...base, tokenId: t1 });
    const k2 = portalCacheKey("test", { ...base, tokenId: t2 });
    expect(await cache.getOrCompute(k1, async () => "for-t1", 0)).toBe("for-t1");
    expect(await cache.getOrCompute(k2, async () => "for-t2", 1)).toBe("for-t2");
    expect(await cache.getOrCompute(k1, async () => "recomputed", 2)).toBe("for-t1");
  });

  it("a failed computation is not cached: the next call computes again", async () => {
    const cache = new PortalCache();
    await expect(cache.getOrCompute("k", async () => Promise.reject(new Error("boom")), 0)).rejects.toThrow("boom");
    expect(await cache.getOrCompute("k", async () => "ok", 1)).toBe("ok");
  });

  it("the store is bounded: it never holds more than its capacity", async () => {
    const cache = new PortalCache(3);
    for (let i = 0; i < 10; i++) await cache.getOrCompute(`k${i}`, async () => i, i);
    expect(cache.size()).toBeLessThanOrEqual(3);
  });
});
