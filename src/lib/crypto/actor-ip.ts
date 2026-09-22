import { isIP } from "node:net";

// STORY-148 review — what may be written into `audit_log.actor_ip`.
//
// ⚠ THAT COLUMN IS `inet`, AND THE ROW HASH IS COMPUTED OVER THE STRING WE
// SEND, NOT OVER WHAT POSTGRES STORES. `AuditChainService.append` hashes
// `content.actor_ip` and inserts the same value; the verifier reads the row
// back with `host(actor_ip)` (src/modules/audit/audit-log-reader.ts). So any
// spelling Postgres rewrites produces a row whose stored hash can never be
// recomputed — a permanent `hash_mismatch` on that TENANT'S chain, reported
// by the daily verifier as tampering. Measured against the real database:
//
//   '203.0.113.9'      -> host() '203.0.113.9'   round-trips
//   '203.0.113.9/32'   -> host() '203.0.113.9'   DOES NOT
//   '0203.0.113.9'     -> host() '203.0.113.9'   DOES NOT
//   '2001:0DB8::0001'  -> host() '2001:db8::1'   DOES NOT
//   '::ffff:127.0.0.1' -> unchanged              round-trips
//
// And an outright invalid value is worse than a wrong one: `'not-an-ip'::inet`
// raises 22P02, which aborts the transaction the append shares with the
// MUTATION ITSELF — so the request fails and no audit row is written for it.
// A caller able to choose `request.ip` could fail every mutating request they
// make and leave no trace of having tried.
//
// None of that was reachable while `request.ip` was always this process's
// peer. nominara-app now relays the caller's X-Forwarded-For chain, so the
// moment `TRUST_PROXY_HOPS` is set, a caller inside the trusted span chooses
// this string.
//
// ⚠ THIS IS THE FIRST OF TWO HALVES, DELIBERATELY. `isIP` rejects the mask
// suffix, the leading zero and the garbage — three of the four rows above and
// the transaction abort with them. What survives is a VALID but non-canonical
// IPv6 literal, which Postgres still rewrites. Node has no canonicaliser that
// agrees with `host()` (WHATWG's URL parser turns '::ffff:127.0.0.1' into
// '::ffff:7f00:1', which would break the common case rather than fix the rare
// one), so the honest fix is to normalise the survivors through the database
// itself — `SELECT host($1::inet)` inside the same transaction, which is
// correct by construction because it is the very function the verifier uses.
// That is its own story; it needs an integration test against real Postgres.
//
// Until it lands, `TRUST_PROXY_HOPS` must stay unset in every environment —
// see src/config/env.schema.ts.

/**
 * The value safe to hash and store as an actor's address, or `null`.
 *
 * `null` rather than a placeholder: "we do not know where this came from" is
 * a true statement an incident review can act on, and a stand-in address is a
 * false one that looks like evidence.
 */
export function safeActorIp(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return isIP(raw) === 0 ? null : raw;
}
