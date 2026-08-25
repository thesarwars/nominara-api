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
 * `{env}:{workspace_id}:ratelimit:{route_class}:{scope}:{id}`
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
  id: string,
): string {
  return tenantKey(env, workspaceId, "ratelimit", routeClass, scope, id);
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
  return createHash("sha256")
    .update([input.key, input.userId, input.route].join(" "))
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
