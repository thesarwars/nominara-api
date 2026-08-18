import { describe, expect, it } from "vitest";
import { MembershipCacheService } from "./membership-cache.js";

// STORY-018 second-engineer review, finding 1 (BLOCKS MERGE) — stale-
// read-after-invalidate race. Pins the hazard directly at the cache
// primitive: a read snapshots the key's generation via beginRead() BEFORE
// its DB round trip, a concurrent mutation invalidates the key (bumping the
// generation) in between, and the read's late set() must not resurrect the
// stale value it fetched before the mutation committed.

describe("STORY-018 · MembershipCacheService generation guard", () => {
  it("a set() carrying a generation older than the key's current generation is a no-op, not a resurrection", () => {
    const cache = new MembershipCacheService();
    const userId = "user-1";
    const workspaceId = "workspace-1";

    // Simulates getLiveMembership: cache miss, snapshot generation, THEN
    // (conceptually) go do the SELECT.
    const generation = cache.beginRead(userId, workspaceId);

    // Concurrently, removeMember commits and invalidates — bumping the
    // generation past what the in-flight read observed.
    cache.invalidate(userId, workspaceId);

    // The in-flight read's SELECT finishes with the pre-mutation (stale,
    // still-active-looking) row and tries to cache it.
    cache.set(userId, workspaceId, { role: "admin", status: "active", projectScope: null }, generation);

    expect(cache.has(userId, workspaceId)).toBe(false);
    expect(cache.get(userId, workspaceId)).toBeUndefined();
  });

  it("a set() carrying the current generation still writes normally (no regression on the common, non-racing path)", () => {
    const cache = new MembershipCacheService();
    const userId = "user-2";
    const workspaceId = "workspace-2";

    const generation = cache.beginRead(userId, workspaceId);
    cache.set(userId, workspaceId, { role: "owner", status: "active", projectScope: null }, generation);

    expect(cache.get(userId, workspaceId)).toEqual({ role: "owner", status: "active", projectScope: null });
  });

  it("invalidate() bumps the generation even when no entry is cached yet, so a read already in flight still loses the race", () => {
    const cache = new MembershipCacheService();
    const userId = "user-3";
    const workspaceId = "workspace-3";

    const generation = cache.beginRead(userId, workspaceId); // nothing cached yet
    cache.invalidate(userId, workspaceId); // e.g. updateRole fires before the read's SELECT even returns
    cache.set(userId, workspaceId, { role: "viewer", status: "active", projectScope: null }, generation);

    expect(cache.has(userId, workspaceId)).toBe(false);
  });
});
