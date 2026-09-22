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
// ⚠ THIS IS ONE OF TWO HALVES, AND IT IS NOT THE ONE THAT MAKES THE HASH
// AGREE. STORY-149 folded `host($2::inet)` into the tail read in
// AuditChainService.append, so the value hashed and stored is the one the
// verifier will read back — correct by construction, because it is the same
// function, rather than a Node canonicaliser that would have to be kept in
// step with Postgres forever.
//
// What this still does, and why removing it would reintroduce the worse bug:
// `$2::inet` on a non-address raises 22P02, and that statement runs inside the
// MUTATION's transaction. Without this guard an uncastable value fails the
// whole request and writes no audit row at all — availability, not integrity,
// and repeatable by whoever controls the value.
//
// ⚠ AND THE MASK SUFFIX STAYS REJECTED, THOUGH THE STATED REASON WAS TOO
// BROAD. "A CIDR block is not an address" is true of `/8` and false of `/32`
// and `/128` — which are the masks a caller would actually append, and for
// which `host()` loses nothing. The honest accounting is that rejecting them
// trades an integrity problem `host()` already solves for a small attribution
// one: append `/32` to your own address and your rows read "unknown address"
// while every other field still names you.
//
// Kept anyway, and narrowly: no caller sends a mask, `@fastify/proxy-addr`
// will not produce one, and a value we cannot explain the provenance of is
// better refused than reinterpreted. If a real mask-bearing source ever
// appears, accept a full-length prefix (`/32`, `/128`) and nothing shorter —
// do not widen this to `host()` generally, which would silently record
// `10.0.0.0/8` as a host that acted.

/** The longest possible IPv6 text form: `ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255`. */
const MAX_IP_TEXT_LENGTH = 45;

/**
 * The value safe to CAST as an actor's address, or `null`.
 *
 * Not the value finally stored — `AuditChainService.append` canonicalises what
 * this admits through `host()`. This decides only what may reach the cast.
 *
 * `null` rather than a placeholder: "we do not know where this came from" is
 * a true statement an incident review can act on, and a stand-in address is a
 * false one that looks like evidence.
 */
export function safeActorIp(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  // A stated ceiling, and REDUNDANT WITH THE NEXT CHECK TODAY — said plainly
  // rather than dressed up as load-bearing. Measured: with no zone index,
  // `isIP` accepts nothing longer than 45, so the `%` rejection below is what
  // actually bounds this value. It stays because Node does not DOCUMENT a
  // maximum length for `isIP` — today's 45 is an implementation detail, and
  // this value is a bind parameter on every audited mutation. Making the
  // ceiling explicit means a future Node change cannot silently unbound it.
  // Neither guard is individually falsifiable by a unit test, which is what
  // redundancy means; the invariant they jointly hold is what is asserted.
  if (raw.length > MAX_IP_TEXT_LENGTH) return null;
  // ⚠ ZONE INDEX: `isIP` SAYS YES AND `inet` SAYS 22P02.
  // `isIP('fe80::1%eth0')` is 6, `'fe80::1%eth0'::inet` raises, and
  // `@fastify/proxy-addr` passes a zone id through verbatim — so one header
  // was a reliable kill switch on every mutating request a caller made,
  // leaving no audit row, which is exactly the failure this guard exists to
  // prevent. A scope id is meaningful only on the interface that owns it and
  // is meaningless in a record of who called us, so there is nothing to
  // preserve by stripping it rather than refusing it.
  if (raw.includes("%")) return null;
  return isIP(raw) === 0 ? null : raw;
}
