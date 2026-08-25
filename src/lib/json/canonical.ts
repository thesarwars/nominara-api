// STORY-025 T16 — canonical JSON, extracted from src/api/etag/entity-tag.ts
// when the idempotency fingerprint needed the identical rule.
//
// Two mechanisms now hash a JSON value and compare the digests across
// requests: an entity tag ("is this the representation I read?") and an
// idempotency fingerprint ("is this the request I already ran?"). Both are
// wrong if key order changes the answer, and two copies of the rule are two
// chances for one of them to drift.

/**
 * Object keys sorted at every depth, so two structurally equal values always
 * serialise identically regardless of the key order a driver, a `RETURNING`
 * clause or a caller's JSON body happened to produce.
 *
 * Array order is significant and preserved — it is part of the value, not an
 * artefact of how the value was built.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, inner]) => [key, canonicalize(inner)]));
}

/** The canonical string form. `undefined` serialises to `"null"` so an absent body is a stable, comparable value. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}
