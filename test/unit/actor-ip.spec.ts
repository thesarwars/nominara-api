import { describe, expect, it } from "vitest";
import { safeActorIp } from "../../src/lib/crypto/actor-ip.js";

// STORY-148 review — the first half of "a caller-supplied address cannot break
// a tenant's audit chain".
//
// ⚠ EVERY REJECTED CASE BELOW IS ONE MEASURED AGAINST THE REAL DATABASE, not
// a guess about what Postgres might do. `audit_log.actor_ip` is `inet`, the
// row hash is computed over the string we send, and the verifier reads the row
// back with `host(actor_ip)` — so a spelling Postgres rewrites yields a row
// whose hash can never be recomputed, and the daily verifier reports that
// TENANT'S chain as tampered. Forever.
describe("STORY-148 · safeActorIp — what may be hashed into the audit chain", () => {
  it("keeps an address Postgres stores and returns unchanged", () => {
    expect(safeActorIp("203.0.113.9")).toBe("203.0.113.9");
    expect(safeActorIp("127.0.0.1")).toBe("127.0.0.1");
    // The dual-stack form fastify itself produces on a loopback socket — the
    // single most common real value, and one host() leaves alone.
    expect(safeActorIp("::ffff:127.0.0.1")).toBe("::ffff:127.0.0.1");
    expect(safeActorIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("passes null and undefined straight through", () => {
    expect(safeActorIp(null)).toBeNull();
    expect(safeActorIp(undefined)).toBeNull();
  });

  // ⚠ `'not-an-ip'::inet` RAISES 22P02, and the append shares its transaction
  // with the MUTATION. So this is not a bad audit row — it is a failed
  // request with no audit row, repeatable at will by whoever controls the
  // value. That is the one case here that is an availability bug rather than
  // an integrity bug.
  it("REJECTS a value Postgres cannot cast, which would abort the mutation's own transaction", () => {
    expect(safeActorIp("not-an-ip")).toBeNull();
    expect(safeActorIp("")).toBeNull();
    expect(safeActorIp("203.0.113.9, 198.51.100.2"), "a whole chain is not an address").toBeNull();
    expect(safeActorIp("A".repeat(4000))).toBeNull();
    expect(safeActorIp("'; DROP TABLE audit_log; --")).toBeNull();
  });

  // ⚠ EVERY NEGATIVE ABOVE IS COLON-FREE, AND THAT WAS A HOLE THE REVIEW
  // WALKED THROUGH. With no IPv6 rejection case anywhere in the suite, the
  // one-line "simplification"
  //
  //     return isIP(raw) === 0 && !raw.includes(":") ? null : raw;
  //
  // passed all sixteen assertions while admitting networks and uncastable
  // garbage — the exact two failures this function exists to prevent.
  it("REJECTS an IPv6 network, an IPv6 that does not parse, and an IPv6 mask", () => {
    expect(safeActorIp("2001:db8::/64"), "a network is not a host that acted").toBeNull();
    expect(safeActorIp("2001:db8::1/128")).toBeNull();
    expect(safeActorIp(":::::::"), "casts to 22P02 and aborts the mutation").toBeNull();
    expect(safeActorIp("not:an:ip")).toBeNull();
  });

  // ⚠ `isIP` SAYS 6 AND `inet` SAYS 22P02. The one input where the two
  // disagree, and the whole remaining job of this function is that they do
  // not. `@fastify/proxy-addr` passes a zone id through verbatim, so one
  // header was a reliable kill switch on every mutating request a caller
  // made — the transaction the audit append shares with the MUTATION aborts,
  // the request fails, and no audit row records the attempt.
  it("REJECTS an IPv6 zone index, which Node validates and Postgres refuses", () => {
    expect(safeActorIp("fe80::1%eth0")).toBeNull();
    expect(safeActorIp("fe80::1%25eth0")).toBeNull();
    expect(safeActorIp("::ffff:192.168.0.1%1")).toBeNull();
  });

  // ⚠ THE INVARIANT, NOT EITHER GUARD. `isIP`'s only unbounded acceptance is
  // the zone suffix — `isIP('fe80::1%' + 'a'.repeat(100000))` is 6 — and that
  // is already rejected above, so the explicit 45-character ceiling is
  // redundant TODAY and neither check is individually falsifiable here. That
  // is what redundancy means, and it is worth saying rather than writing two
  // assertions that each look load-bearing and are not. What this pins is the
  // property both exist to hold: nothing over-long reaches the bind parameter
  // by any route. Removing BOTH fails it.
  //
  // The `"A"*4000` case above pins nothing about length — that string is
  // colon-free and is rejected for not being an address at all.
  it("admits nothing longer than the longest possible IPv6 text form, by any route", () => {
    for (const long of [`fe80::1%${"a".repeat(100_000)}`, "0".repeat(50), `${"1".repeat(46)}.1.1.1`]) {
      expect(safeActorIp(long)).toBeNull();
    }
    expect(safeActorIp("ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255"), "45 chars, and valid").toBe(
      "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255",
    );
  });

  // ⚠ THESE ARE THE CHAIN POISONERS. Each casts cleanly, so nothing fails at
  // write time; each comes back from host() as a DIFFERENT string, so the row
  // can never verify again.
  it("REJECTS a valid-looking spelling that Postgres rewrites — measured, not assumed", () => {
    // host('203.0.113.9/32') -> '203.0.113.9'
    expect(safeActorIp("203.0.113.9/32")).toBeNull();
    expect(safeActorIp("10.0.0.0/8")).toBeNull();
    // host('0203.0.113.9') -> '203.0.113.9'
    expect(safeActorIp("0203.0.113.9")).toBeNull();
  });

  // ⚠ A NON-CANONICAL IPv6 LITERAL PASSES HERE, AND THAT IS NOW CORRECT.
  // STORY-149.
  //
  // This function decides what may reach `$2::inet`, not what is stored.
  // `AuditChainService.append` canonicalises what it admits through `host()`,
  // so '2001:0DB8::0001' becomes '2001:db8::1' BEFORE the hash is computed and
  // the row verifies. Rejecting it here would discard a real address for a
  // problem solved one layer down — the actor of that request would be
  // recorded as unknown because they wrote their own address in capitals.
  //
  // test/integration/audit-chain-service.spec.ts is where the round-trip is
  // observable and where that claim is actually proved; this only pins that
  // the value is not dropped on the way.
  it("admits a valid but non-canonical spelling — append canonicalises it, so dropping it would lose a real actor", () => {
    expect(safeActorIp("2001:0DB8::0001")).toBe("2001:0DB8::0001");
    expect(safeActorIp("2001:DB8::1")).toBe("2001:DB8::1");
  });
});
