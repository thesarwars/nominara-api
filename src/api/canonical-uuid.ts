// STORY-150 — the canonical spelling of a uuid, with no framework attached.
//
// Its own module because unrelated layers need it and none should pull the
// others in: `CanonicalParamsGuard` normalises `req.params`, the idempotency
// fingerprint normalises what it keys on, and the realtime gateway normalises
// the project id it both authorises and names a room after. One definition, so
// they cannot drift into disagreeing about what a request's id is — which is
// the entire bug.

/** Case-insensitive on purpose: matching only lowercase would leave the problem unseen. */
const CANONICAL_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exactly 32 hex digits, once braces and hyphens are taken out. */
const THIRTY_TWO_HEX = /^[0-9a-f]{32}$/i;

/**
 * The canonical spelling of `value` when the WHOLE value is a canonically
 * shaped uuid, otherwise `value` unchanged.
 *
 * ⚠ ONLY AN EXACT UUID IS TOUCHED. Other path segments are slugs, provider
 * names and share tokens; lowercasing one of those would change what it
 * identifies. A uuid is case-insensitive by RFC 4122 and lowercase on output,
 * which Postgres already enforces on every `uuid` column — so for a uuid the
 * lowercase form denotes the same id by definition, and for anything else we
 * have no such licence.
 */
export function canonicalUuid(value: string): string {
  return CANONICAL_SHAPE.test(value) ? value.toLowerCase() : value;
}

/**
 * True for a value Postgres would accept as a uuid but that is NOT written the
 * one way we accept.
 *
 * ⚠ IT STRIPS AND COUNTS RATHER THAN MATCHING A SHAPE, and the first attempt
 * matching a shape is why. Postgres is far more lenient than a reader expects:
 * measured against a live Postgres 18, ALL of these cast to the same uuid —
 *
 *     {a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}
 *     a0eebc999c0b4ef8bb6d6bb9bd380a11
 *     a0ee-bc99-9c0b-4ef8-bb6d-6bb9bd380a11     hyphens in the WRONG places
 *     a0eebc99-9c0b4ef8-bb6d-6bb9bd380a11       a hyphen simply missing
 *     aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa          32 bare hex digits
 *
 * — and an optional-hyphen regex written to the 8-4-4-4-12 shape caught only
 * two of them. Stripping braces and every hyphen and counting 32 hex digits
 * needs no knowledge of where Postgres permits a separator, which is the whole
 * point: this must not become a second uuid parser racing the real one.
 *
 * It deliberately OVER-approximates: `a-0-e-e-b-c-…` is rejected here and also
 * rejected by Postgres, so over-approximating only ever refuses something that
 * would have failed anyway. Under-approximating is what lets two strings name
 * one row. test/integration/canonical-uuid-vs-postgres.spec.ts pins the
 * relationship against the real database rather than against this comment.
 *
 * ⚠ REJECTED RATHER THAN NORMALISED, AND THAT IS THE LESSON FROM STORY-149.
 * `audit-chain.service.ts` refused to reimplement Postgres's uuid parser in
 * Node — "a second implementation to keep in step forever, and drift is
 * precisely the bug" — and widening `canonicalUuid` to swallow these spellings
 * would be exactly that reimplementation, a regex racing a parser it cannot
 * see. Accepting ONE spelling needs no parser: anything else is a 400, which
 * is also the honest answer to a caller who sent something we will not
 * interpret.
 *
 * The consequence of NOT rejecting them is not hypothetical. `{a0ee…}` and
 * `a0ee…` name one row to Postgres and two different strings to us, so they
 * produced two idempotency fingerprints, two records and two executions on a
 * route that spends credits — while `assertMatchesTenant` 404'd one of them
 * and `AuditInterceptor` turned the other into a 500.
 *
 * ⚠ FORWARD HAZARD, STATED BECAUSE NOTHING ENFORCES IT. This is applied to
 * every path param of every route. No route today takes a case-sensitive
 * uuid-shaped or 32-hex-digit param — every `:id` maps to a `uuid` column,
 * `:provider` is a slug, invitation and share tokens travel in the body — but
 * `attribution_configs.site_token` and `custom_domains.verification_token` are
 * `text` columns whose generators are not written yet. A route that takes one
 * of those in its PATH must not reuse a uuid-shaped format.
 */
export function isNonCanonicalUuidSpelling(value: string): boolean {
  if (CANONICAL_SHAPE.test(value)) return false;
  return THIRTY_TWO_HEX.test(value.replace(/^\{/, "").replace(/\}$/, "").replaceAll("-", ""));
}
