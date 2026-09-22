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
// ⚠ AND THE MASK SUFFIX STAYS REJECTED THOUGH `host()` WOULD NOW SURVIVE IT.
// `host('10.0.0.0/8')` is '10.0.0.0', which would record a NETWORK as though
// it were a host that acted. A CIDR block is not an address, and quietly
// reinterpreting one as one is a worse answer than `null`.

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
  return isIP(raw) === 0 ? null : raw;
}
