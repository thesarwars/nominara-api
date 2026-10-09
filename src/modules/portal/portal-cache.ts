import { tenantKey } from "../../lib/cache/valkey-keys.js";

// NEW-E-099a — NFR-AGY-03: "a 60-second per-token cache"; NFR-AGY-04: "a portal cache key always includes
// token_id". Same precedent as membership-cache.ts: an in-process TTL map behind the get/set surface a Valkey
// implementation will have, so only this file changes when the cache moves. In-process means one copy per replica and a
// worst-case 60 s of staleness per replica, which is the bound the spec states.
//
// The cache sits INSIDE the handler, after PortalContextInterceptor has re-checked the token on this very request, so
// a revoked token never reaches it; and the policy fingerprint is part of the key, so editing a token's hiding rules
// takes effect on the next request rather than after the window.

export const PORTAL_CACHE_TTL_MS = 60_000;
const DEFAULT_CAPACITY = 500;

export interface PortalCacheKeyParts {
  readonly workspaceId: string;
  readonly tokenId: string;
  readonly route: string;
  readonly project: string;
  readonly timeframe: string;
  /** A fingerprint of the token's hiding rules, lock and theme: a setting change must never be served stale. */
  readonly policy: string;
}

export function portalCacheKey(env: string, parts: PortalCacheKeyParts): string {
  return tenantKey(env, parts.workspaceId, "portal", parts.tokenId, parts.route, parts.project, parts.timeframe, parts.policy);
}

export class PortalCache {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  async getOrCompute<T>(key: string, compute: () => Promise<T>, now: number = Date.now()): Promise<T> {
    const hit = this.store.get(key);
    if (hit !== undefined && hit.expiresAt > now) return hit.value as T;
    // A failed computation throws before anything is stored, so an error is never cached.
    const value = await compute();
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: now + PORTAL_CACHE_TTL_MS });
    // Bounded: the oldest entry (Map iterates in insertion order) goes first.
    while (this.store.size > this.capacity) this.store.delete(this.store.keys().next().value as string);
    return value;
  }

  size(): number {
    return this.store.size;
  }
}
