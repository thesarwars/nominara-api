import { Injectable } from "@nestjs/common";

// STORY-018 — security-and-tenancy.md §7 layer 1: "WorkspaceGuard reads
// workspace_members, cached ... for 30 s keyed mem:{user}:{ws} and
// invalidated synchronously on any membership mutation."
//
// Pre-Valkey placeholder, same precedent as STORY-014's webauthn_challenges
// and STORY-017's DB-backed deny list: Valkey is not wired into this repo
// until STORY-030, so this is an in-process TTL map behind the exact
// get/set/invalidate surface a real Valkey-backed implementation will have
// — STORY-030 swaps the body of this class, not its callers. Because it is
// in-process, it does not survive a restart and is not shared across
// replicas; the 30 s worst-case bound this story proves therefore only
// holds per-process until STORY-030 lands. Recorded as a disclosed gap
// (STORY-018-E-1, see the story file), not a silent shortcut.

export const MEMBERSHIP_CACHE_TTL_MS = 30_000;

export interface CachedMembership {
  readonly role: string;
  readonly status: string;
  readonly projectScope: readonly string[] | null;
}

function membershipCacheKey(userId: string, workspaceId: string): string {
  return `mem:${userId}:${workspaceId}`;
}

// Second-engineer review finding 1 (STORY-018) — stale-read-after-invalidate
// race: getLiveMembership does cache-miss -> SELECT -> set() (after the DB
// round trip), while removeMember/updateRole do UPDATE -> commit ->
// invalidate(). A read that snapshots the pre-mutation row can have its
// set() land AFTER a concurrent mutation's invalidate() already ran,
// resurrecting the stale value for a fresh TTL window. Fixed with a
// monotonic per-key generation counter: invalidate() bumps it synchronously
// (in addition to deleting the entry), and set() takes the generation the
// caller observed via beginRead() *before* it started its DB round trip —
// if the generation has moved on by the time set() runs, the write is a
// silent no-op instead of resurrecting stale data.
@Injectable()
export class MembershipCacheService {
  // A primitive-typed constructor parameter is not resolvable by Nest's
  // DI (no injection token for `number`), so the TTL is a plain class
  // field rather than a constructor injection point.
  private readonly store = new Map<string, { value: CachedMembership; expiresAt: number }>();
  private readonly generations = new Map<string, number>();
  private readonly ttlMs: number = MEMBERSHIP_CACHE_TTL_MS;

  private currentGeneration(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  get(userId: string, workspaceId: string, now: number = Date.now()): CachedMembership | undefined {
    const key = membershipCacheKey(userId, workspaceId);
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Snapshot to take BEFORE starting the DB read that will feed `set()` — see the class-level comment. */
  beginRead(userId: string, workspaceId: string): number {
    return this.currentGeneration(membershipCacheKey(userId, workspaceId));
  }

  /** No-ops if `generation` (from `beginRead`) is behind the key's current generation — a stale read must not resurrect an invalidated entry. */
  set(userId: string, workspaceId: string, value: CachedMembership, generation: number, now: number = Date.now()): void {
    const key = membershipCacheKey(userId, workspaceId);
    if (generation !== this.currentGeneration(key)) {
      return;
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
  }

  /** Called synchronously, in the same service method as the membership mutation that invalidates it — never left to expiry alone. Bumps the generation counter so a read already in flight cannot resurrect what it saw before this call. */
  invalidate(userId: string, workspaceId: string): void {
    const key = membershipCacheKey(userId, workspaceId);
    this.generations.set(key, this.currentGeneration(key) + 1);
    this.store.delete(key);
  }

  /** Test/introspection seam only (scenario 5: "inspect the cache and see it was invalidated synchronously"). */
  has(userId: string, workspaceId: string, now: number = Date.now()): boolean {
    return this.get(userId, workspaceId, now) !== undefined;
  }
}
