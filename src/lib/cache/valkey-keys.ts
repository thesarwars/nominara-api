import { createHash } from "node:crypto";

// STORY-025 T14 — every Valkey key this service writes is built HERE.
//
// system-architecture.md §11 mandates two Valkey instances: a QUEUE instance
// (`noeviction`, persistence on) holding BullMQ's queues, which is
// STORY-030's, and a CACHE instance (`allkeys-lru`, persistence off) holding
// "L1 answer cache, token buckets, locks, idempotency keys, membership and
// entitlement memoisation, pub/sub". This file addresses the CACHE instance.
//
// *** THE KEY IS THE TENANT BOUNDARY. ***
// Postgres has row-level security; Valkey has nothing of the kind. A key
// missing its `{workspace_id}` segment is a cross-tenant read or write with
// no second line of defence — one workspace reading another's cached response
// envelope, or exhausting another's rate-limit capacity. That is why the
// construction lives in one file with its own tests rather than being spelled
// out at each call site, and why the segment checks below are assertions
// rather than comments.
//
// Two key forms, fixed by the execution plan (project-structure.md §8):
//
//   {env}:global:...            platform-wide data that is NOT tenant data —
//                               e.g. the bucket configuration document.
//   {env}:{workspace_id}:...    everything else.
//
// The `{env}` segment is equally load-bearing and less obvious: a staging
// deployment pointed at a shared cache must not read production's idempotency
// records, and without the prefix it silently would.

const SEGMENT_SEPARATOR = ":";

/**
 * A segment may not contain the separator.
 *
 * Without this a crafted value could shift every following segment — a
 * `workspace_id` of `a:idem` would make `{env}:a:idem:{hash}` mean something
 * entirely different from what the caller intended. Today every segment comes
 * from a validated uuid or a closed enum, so this can never fire; it is here
 * because "can never fire" is a property of today's callers, not of the
 * function.
 */
function assertSegment(name: string, value: string): string {
  if (value.length === 0) {
    throw new Error(`valkey key segment "${name}" must not be empty — an empty segment collapses the key boundary`);
  }
  if (value.includes(SEGMENT_SEPARATOR)) {
    throw new Error(
      `valkey key segment "${name}" must not contain "${SEGMENT_SEPARATOR}" (got ${JSON.stringify(value)}) — ` +
        "a separator inside a segment shifts every segment after it",
    );
  }
  return value;
}

/** Platform-wide, never tenant data. */
export function globalKey(env: string, ...parts: readonly string[]): string {
  return [
    assertSegment("env", env),
    "global",
    ...parts.map((part, index) => assertSegment(`part[${index}]`, part)),
  ].join(SEGMENT_SEPARATOR);
}

/** Tenant-scoped. Every key holding anything derived from a workspace's data goes through here. */
export function tenantKey(env: string, workspaceId: string, ...parts: readonly string[]): string {
  return [
    assertSegment("env", env),
    assertSegment("workspace_id", workspaceId),
    ...parts.map((part, index) => assertSegment(`part[${index}]`, part)),
  ].join(SEGMENT_SEPARATOR);
}

/** `{env}:global:ratelimit:config` — the bucket configuration document (STORY-025 AC "bucket configuration is data"). */
export function rateLimitConfigKey(env: string): string {
  return globalKey(env, "ratelimit", "config");
}

/**
 * `{env}:{workspace_id}:ratelimit:{route_class}:{scope}:{window}:{id}`
 *
 * THE `{window}` SEGMENT IS NOT DECORATION. §12 gives some route classes TWO
 * buckets of the same scope — capture-backed tools carry a user bucket at
 * 5/min AND one at 40/day. Without a segment distinguishing them the two
 * produce an identical key, so they share one token-bucket state and clobber
 * each other: the daily allowance effectively ceases to exist, and the
 * per-minute bucket is read with the daily one's refill rate half the time.
 * Found by the dangerous-area audit of this story, and missed here because the
 * behavioural tests used a synthetic config with one bucket per scope.
 *
 * Tenant-scoped even for an IP-scoped bucket. An IP counter shared across
 * workspaces would let one tenant's traffic exhaust another's capacity from
 * the same egress address — a shared office, a corporate VPN, a CI runner —
 * which is a denial of service between tenants rather than an abuse control.
 */
export function rateLimitCounterKey(
  env: string,
  workspaceId: string,
  routeClass: string,
  scope: string,
  window: string,
  id: string,
  ...extra: readonly string[]
): string {
  return tenantKey(env, workspaceId, "ratelimit", routeClass, scope, window, id, ...extra);
}

/** `{env}:{workspace_id}:idem:{fingerprint}` — see idempotencyFingerprint for what the fingerprint covers. */
export function idempotencyRecordKey(env: string, workspaceId: string, fingerprint: string): string {
  return tenantKey(env, workspaceId, "idem", fingerprint);
}

/**
 * sha256 over key, user and route — what identifies the RECORD.
 *
 * The body is deliberately NOT in here, and that is the whole mechanism.
 * api-specification.md §1: "identical key + identical body returns the cached
 * response; identical key + DIFFERENT body is `409 idempotency_conflict`."
 * If the body were part of this hash, two bodies under one key would land on
 * two different records, both would be claimed, and both would execute — the
 * conflict case would be structurally undetectable and the double effect it
 * exists to prevent would happen silently. The body is hashed separately,
 * stored INSIDE the record, and compared on read.
 *
 * The three that ARE here:
 *
 *   key    the caller's `Idempotency-Key`, which is the point.
 *   user   two users of the same workspace presenting the same key are two
 *          requests, not a replay. Without this a shared or guessable key
 *          would hand one user another's response body.
 *   route  the same key on a different endpoint is a different operation, and
 *          a client reusing a key across endpoints deserves a conflict rather
 *          than another endpoint's cached body.
 *
 * The workspace is NOT here because it is already a key segment. Putting it in
 * both would make the tenant boundary look like it lives in the hash, where it
 * cannot be inspected, instead of in the key, where it can.
 */
export function idempotencyScopeFingerprint(input: {
  readonly key: string;
  readonly userId: string;
  readonly route: string;
}): string {
  // LENGTH-PREFIXED, not space-joined. A space delimiter is not injective when
  // the caller controls one field: `key` may contain spaces (§1 caps length,
  // not charset) and `route` contains one, so two different triples can
  // serialise identically. It is not exploitable today — `sub` is a
  // server-assigned uuid, so the attacker's own 36 characters would have to
  // land at an exact offset inside the victim's — but that is a property of
  // the CLAIMS SCHEMA, not of this function, and `assertSegment` exists a few
  // lines up precisely because "today's callers make it safe" is not the
  // standard here. Found by the dangerous-area audit.
  const parts = [input.key, input.userId, input.route];
  return createHash("sha256")
    .update(parts.map((part) => `${String(part.length)}:${part}`).join(""))
    .digest("hex");
}

/**
 * sha256 of the canonical request body — stored in the record and compared on
 * every replay. This is the half that tells a replay from a conflict.
 */
export function requestBodyHash(canonicalBody: string): string {
  return createHash("sha256").update(canonicalBody).digest("hex");
}

/** The hash recorded in a 409's detail, so a conflict is auditable without echoing the key itself. */
export function hashIdempotencyKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * `{env}:{workspace_id}:ent:{entitlement_version}` — resolved entitlements
 * (STORY-069 AC4).
 *
 * plans-and-entitlements.md §8 writes it `ent:{workspace_id}:{entitlement_version}`;
 * the `{env}` prefix and the workspace-first ordering are this file's, for the
 * reasons at the top — the reference is naming the shape, not the full key, and
 * §11 lists "entitlement memoisation" among what the CACHE instance holds.
 *
 * THE VERSION SEGMENT IS THE INVALIDATION. `workspaces.entitlement_version`
 * bumps on any plan, add-on, or override change, so a bump moves every
 * subsequent read to a key nothing has written. There is no invalidate() to
 * call and therefore none to forget — which matters most for a DOWNGRADE,
 * where an entry that outlived its plan is a customer using a tier they no
 * longer pay for, for as long as the TTL happens to be.
 */
export function entitlementsKey(env: string, workspaceId: string, entitlementVersion: number): string {
  return tenantKey(env, workspaceId, "ent", String(entitlementVersion));
}

/**
 * `{env}:global:refresh-grace:{session_id}` — the refresh-token reuse grace
 * slot (STORY-170, security-and-tenancy.md §5 "Session model").
 *
 * `global`, not tenant-scoped, and deliberately so: `sessions` is a global
 * table (session identity state, not tenant data — src/db/conventions.ts), a
 * session has no workspace of its own (`ws` is only the ACTIVE one and changes
 * on a switch), and the session id is what identifies the slot. The id is the
 * only thing that can select it, and the value inside is sealed under a key
 * derived from the predecessor token (src/lib/auth/refresh-token.ts), so
 * guessing or reading a key yields nothing without that token.
 */
export function refreshGraceSlotKey(env: string, sessionId: string): string {
  return globalKey(env, "refresh-grace", sessionId);
}

/**
 * `{env}:global:rollup_dirty` — STORY-042 AC6 / EC-12: the set of `workspace|project|date` triples whose `metric_daily`
 * rows a late fact has made stale. Platform-wide work list holding identifiers only (no tenant content), so it is a
 * `global` key; it is read by one sweep across every workspace, which a per-workspace key could not serve without a SCAN.
 *
 * ⚠ IT LIVES ON THE QUEUE INSTANCE (`QUEUE_REDIS_URL`: noeviction, persistent), NOT THE CACHE ONE. This key is a work
 * list, and `allkeys-lru` with no persistence would drop a mark under memory pressure or a restart: a late fact would
 * then never be reprocessed, with nothing to say so. Only the key NAME is built here.
 */
export function rollupDirtyKey(env: string): string {
  return globalKey(env, "rollup_dirty");
}
