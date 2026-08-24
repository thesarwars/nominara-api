import { createHash } from "node:crypto";

// STORY-024 T11 — AC8: "Mutable configuration endpoints emit a concurrency
// tag and require it on modification, refusing a stale one with a conflict."
//
// The tag is a STRONG validator derived from the representation itself — a
// SHA-256 over a canonical serialisation — rather than from a row version.
// Three alternatives were considered and rejected against this codebase:
//
//   `updated_at`   The touch_updated_at trigger sets it from `now()`, which
//                  in Postgres is TRANSACTION-START time, not statement time.
//                  Two updates inside one transaction produce an identical
//                  `updated_at`, so a tag built on it cannot distinguish
//                  them — precisely the lost update it is meant to catch.
//   `xmin`         A real row version, but VACUUM FREEZE rewrites it to
//                  FrozenTransactionId without the row changing, turning
//                  every outstanding tag on a cold row into a spurious 409.
//   a version col  Correct, and what a schema change would add — but this
//                  epic ships no migration, and inventing one for the single
//                  demonstrator route is a data change without a story.
//
// What a representation hash means is exactly what RFC 9110 §13.1.1 asks of
// `If-Match`: "the representation is the one I read". Its known weakness —
// an A→B→A sequence yielding the tag again — is not a lost update here,
// because the precondition it lets through is LITERALLY TRUE: the caller's
// write lands on a representation byte-identical to the one they read.

/**
 * Canonical JSON: object keys sorted at every depth, so two structurally
 * equal representations always hash identically regardless of the key order
 * a driver, a `RETURNING` clause or a `JSON.stringify` happened to produce.
 * Array order is significant and preserved — it is part of the value.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, inner]) => [key, canonicalize(inner)]));
}

/**
 * The opaque tag VALUE for a representation — no surrounding quotes, which
 * belong to the header syntax rather than to the tag. Pair with
 * {@link formatEntityTag} when writing a header.
 *
 * Hex, not base64: an entity-tag's `etagc` production (RFC 9110 §8.8.3)
 * excludes `"` but a base64 tag would still need its `+` and `/` thought
 * about at every call site, and 32 hex characters is already 128 bits of
 * collision resistance for a concurrency check.
 */
export function entityTagFor(representation: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(representation)), "utf8").digest("hex").slice(0, 32);
}

/** Wraps a tag value in the strong-validator syntax an `ETag` header carries. */
export function formatEntityTag(tag: string): string {
  return `"${tag}"`;
}
