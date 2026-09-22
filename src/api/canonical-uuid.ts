// STORY-150 — the canonical spelling of a uuid, with no framework attached.
//
// Its own module because two unrelated layers need it and neither should pull
// the other in: `CanonicalParamsGuard` (a Nest guard) normalises `req.params`,
// and `routeIdentity` (the idempotency key, which reads the raw url and never
// sees params) normalises the path. One definition, so the two cannot drift
// into disagreeing about what a request's id is — which is the entire bug.

/** Case-insensitive on purpose: matching only lowercase would leave the problem unseen. */
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The canonical spelling of `value` when the WHOLE value is a uuid, otherwise
 * `value` unchanged.
 *
 * ⚠ ONLY AN EXACT UUID IS TOUCHED. Other path segments are slugs, provider
 * names and share tokens; lowercasing one of those would change what it
 * identifies. A uuid is case-insensitive by RFC 4122 and lowercase on output,
 * which Postgres already enforces on every `uuid` column — so for a uuid the
 * lowercase form denotes the same id by definition, and for anything else we
 * have no such licence.
 */
export function canonicalUuid(value: string): string {
  return UUID_VALUE.test(value) ? value.toLowerCase() : value;
}
