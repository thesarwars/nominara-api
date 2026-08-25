import {
  hashIdempotencyKey,
  idempotencyRecordKey,
  idempotencyScopeFingerprint,
  requestBodyHash,
} from "../../lib/cache/valkey-keys.js";
import { canonicalJson } from "../../lib/json/canonical.js";

// STORY-025 T16 — turning a request into the key its record lives under.
//
// The pieces are in src/lib/cache/valkey-keys.ts, which owns the tenant
// boundary and is tested as such. This file owns the one decision that is
// about HTTP rather than about keys: what counts as "the same request".

export interface IdempotencyRequestIdentity {
  readonly env: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

export interface IdempotencyIdentity {
  readonly cacheKey: string;
  readonly requestHash: string;
  readonly keyHash: string;
}

/**
 * The route component of the fingerprint.
 *
 * The PATH **and the query**, not the route pattern. Two different resources
 * served by one handler (`/things/1` and `/things/2`) are different requests
 * and must not share a record, which a pattern-based identity would collapse.
 *
 * THE QUERY USED TO BE DROPPED, AND THAT WAS A WRONG-ANSWER BUG. The reasoning
 * was "a POST's identity is its body"; the counter-example is
 * `POST /exports?format=csv&notify=false` against
 * `POST /exports?format=pdf&notify=true` with the same key and the same body —
 * two different operations, and the second received the first's response.
 * Found by the dangerous-area audit of STORY-025.
 *
 * Parameters are SORTED before hashing, so a client that reorders them between
 * a request and its retry still gets a replay rather than a second execution.
 * That is the same reasoning that canonicalises the body: two encodings of one
 * request are one request, and deciding otherwise would make the safety of a
 * retry depend on how the other end serialises a URL.
 */
export function routeIdentity(method: string, url: string): string {
  const [path, query] = url.split("?");
  const canonicalQuery =
    query === undefined || query.length === 0
      ? ""
      : `?${[...new URLSearchParams(query).entries()]
          .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
          .map(([name, value]) => `${name}=${value}`)
          .join("&")}`;
  return `${method.toUpperCase()} ${path ?? url}${canonicalQuery}`;
}

/**
 * Everything needed to store, compare and report on one idempotent request.
 *
 * The body is canonicalised before hashing, so a client that reorders its
 * JSON keys between a request and its retry gets a REPLAY rather than a `409
 * idempotency_conflict`. §1 says "identical body"; two encodings of one value
 * are the same body, and treating them otherwise would make the safety of a
 * retry depend on the serialiser at the other end.
 */
export function identifyIdempotentRequest(request: IdempotencyRequestIdentity, key: string): IdempotencyIdentity {
  // Two hashes, and the split is load-bearing. The SCOPE fingerprint locates
  // the record and excludes the body; the BODY hash lives inside the record.
  // Merge them and two bodies under one key become two records, both claimed,
  // both executed — the 409 case would be structurally unreachable.
  const scope = idempotencyScopeFingerprint({
    key,
    userId: request.userId,
    route: routeIdentity(request.method, request.url),
  });

  return {
    cacheKey: idempotencyRecordKey(request.env, request.workspaceId, scope),
    requestHash: requestBodyHash(canonicalJson(request.body)),
    keyHash: hashIdempotencyKey(key),
  };
}
