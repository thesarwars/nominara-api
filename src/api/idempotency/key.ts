import { canonicalUuid } from "../canonical-uuid.js";
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
  /** Fastify's matched route pattern (`request.routeOptions.url`), when the adapter supplies one. */
  readonly routePattern?: string | undefined;
  /** Fastify's extracted, percent-DECODED path params. */
  readonly params?: Readonly<Record<string, unknown>> | undefined;
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
/**
 * ⚠ THE ROUTE COMPONENT IS BUILT FROM WHAT THE ROUTER RESOLVED, NOT FROM THE
 * URL. STORY-150, corrected by its own review.
 *
 * The first attempt canonicalised uuid segments of `request.url` — and that
 * was still escapable, because `req.params` is PERCENT-DECODED by Fastify and
 * `req.url` is not. Reproduced end to end:
 *
 *     POST /v1/projects/a0eebc99-…/runs      param a0eebc99-…   url a0eebc99-…
 *     POST /v1/projects/%610eebc99-…/runs    param a0eebc99-…   url %610eebc99-…
 *
 * The second request is IDENTICAL everywhere it is observed — every guard, the
 * handler, the audit row — and differs only in the fingerprint. Three spellings
 * of one request therefore claimed three records and executed three times, on
 * `POST /v1/projects/:id/runs`, which is `@Idempotent()` AND `@Credits("deep_scan")`.
 * Three debits under one `Idempotency-Key`.
 *
 * ⚠ AND THE ACCIDENTAL CASE IS THE REASON THIS IS A BLOCKER RATHER THAN A
 * CURIOSITY. A caller escaping their own idempotency deliberately has an
 * easier way — send a different key. But HTTP clients disagree about which
 * path characters to percent-encode, so a retry through a different client,
 * proxy or SDK version can encode differently WITHOUT ANYONE INTENDING IT, and
 * §1's guarantee quietly does not hold for the retry it exists to protect.
 *
 * So the identity is the route PATTERN the router matched plus the DECODED
 * params it extracted — `POST /v1/projects/:id/runs` with `{id}` — which is
 * what "the same operation" actually means. No decoding, no re-encoding, and
 * no third place that has to agree with the other two about what a path is.
 *
 * A whole-path `decodeURIComponent` was the other candidate and is a trap: it
 * collapses `%2F` into `/`, merging two distinct routes into one identity,
 * which would be a worse bug than the one being fixed.
 *
 * For a request whose params are already canonical and unencoded this produces
 * the BYTE-IDENTICAL string the old implementation did, so idempotency records
 * in flight across the deploy stay reachable for every honest client.
 *
 * `request.url` is deliberately left alone everywhere else: it is what the
 * access log and the request id are threaded through, and a request should
 * stay greppable by the path the caller actually sent.
 */
/**
 * The fallback, for a caller that has no matched route to offer — every unit
 * caller, and any adapter that does not surface one. Per SEGMENT, so a uuid
 * inside the path is canonicalised while the path's shape is untouched. It
 * cannot fix percent-encoding (the url is still encoded here), which is
 * exactly why the route-pattern form above is preferred rather than optional.
 */
function canonicalPath(path: string): string {
  return path
    .split("/")
    .map((segment) => canonicalUuid(segment))
    .join("/");
}

function pathFromRoute(pattern: string, params: Readonly<Record<string, unknown>>): string | undefined {
  // A wildcard pattern carries no named param to substitute, so there is
  // nothing to rebuild from and the caller falls back to the url.
  if (pattern.includes("*")) return undefined;
  const segments = pattern.split("/");
  const rebuilt: string[] = [];
  for (const segment of segments) {
    if (!segment.startsWith(":")) {
      rebuilt.push(segment);
      continue;
    }
    const value = params[segment.slice(1)];
    // A pattern naming a param the router did not supply means the two
    // disagree; rebuilding from a guess would be worse than not rebuilding.
    if (typeof value !== "string") return undefined;
    rebuilt.push(canonicalUuid(value));
  }
  return rebuilt.join("/");
}

/**
 * ⚠ QUERY VALUES ARE LEFT VERBATIM, DELIBERATELY. Their NAMES are sorted so a
 * reordered query still replays, but a value is opaque here — we do not know
 * which are ids and which are free text, and lowercasing the wrong one would
 * merge two operations. Checked rather than assumed: no `@Idempotent()` route
 * takes a uuid query parameter today, and the only uuid query params in the
 * repo (`project_id`/`actor_id` on `GET /v1/billing/wallet/ledger`) go
 * straight into Postgres as `$n::uuid` bind parameters, where case never
 * mattered. A uuid query param on an idempotent route would need this
 * revisited.
 */
export function routeIdentity(
  method: string,
  url: string,
  /** Fastify's matched route pattern, e.g. `/v1/projects/:id/runs`. */
  routePattern?: string,
  /** Fastify's extracted, percent-DECODED params. */
  params?: Readonly<Record<string, unknown>>,
): string {
  const [rawPath, query] = url.split("?");
  const fromRoute = routePattern !== undefined && params !== undefined ? pathFromRoute(routePattern, params) : undefined;
  // `split` always yields at least one element, so `rawPath` is a string.
  const path = fromRoute ?? canonicalPath(rawPath!);
  const canonicalQuery =
    query === undefined || query.length === 0
      ? ""
      : `?${[...new URLSearchParams(query).entries()]
          .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
          .map(([name, value]) => `${name}=${value}`)
          .join("&")}`;
  return `${method.toUpperCase()} ${path}${canonicalQuery}`;
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
    route: routeIdentity(request.method, request.url, request.routePattern, request.params),
  });

  return {
    cacheKey: idempotencyRecordKey(request.env, request.workspaceId, scope),
    requestHash: requestBodyHash(canonicalJson(request.body)),
    keyHash: hashIdempotencyKey(key),
  };
}
