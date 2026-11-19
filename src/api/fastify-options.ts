import { Logger } from "@nestjs/common";
import type { FastifyServerOptions } from "fastify";
import { isIP } from "node:net";
import { loadEnv } from "../config/env.js";

const logger = new Logger("fastify-options");

/**
 * Batch 19 (follow-up to owner decision 108(k)) - the valid entries of a `TRUSTED_PROXY_CIDRS` value: a comma-separated list of addresses or CIDR
 * ranges, IPv4 or IPv6. NEVER THROWS: an entry that is not a well-formed address or prefix is dropped (the count of dropped entries is logged, never the
 * text), because a mistyped variable must not stop the API booting and an entry dropped can only mean LESS is trusted, never more. Deliberately stricter
 * than the library that will receive the result (zone ids, a second slash, a sign, a prefix past the family's width are all refused here), so what
 * reaches Fastify is always something it can compile.
 *
 * A CATCH-ALL RANGE IS REFUSED, not trusted (any entry whose prefix length is 0: `0.0.0.0/0`, `::/0`, and `x/0` for any x, which masks to everything).
 * Trusting every peer is `trustProxy: true` under another spelling: any caller could put a forged address in X-Forwarded-For and pick their own
 * per-IP rate-limit bucket, silently and for free. It is well-formed, so it is counted apart from `dropped` (malformed), and the caller warns on it.
 */
export function parseTrustedProxyCidrs(raw: string): { readonly valid: string[]; readonly dropped: number; readonly catchAll: number } {
  const valid: string[] = [];
  let dropped = 0;
  let catchAll = 0;
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const pieces = entry.split("/");
    const family = pieces.length <= 2 && !entry.includes("%") ? isIP(pieces[0]!) : 0;
    const prefix = pieces[1];
    const prefixOk = prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128));
    if (family === 0 || !prefixOk) {
      dropped += 1;
      continue;
    }
    if (prefix !== undefined && Number(prefix) === 0) {
      catchAll += 1;
      continue;
    }
    valid.push(entry);
  }
  return { valid, dropped, catchAll };
}

// STORY-026 audit fix — the Fastify options every process that serves HTTP
// must be constructed with.
//
// One place, because the setting below is a security property and a second
// bootstrap that forgot it would be silently wrong. `src/main.ts` and every
// test that boots a real app go through here.

/**
 * `trustProxy` from a validated hop count, never `true`.
 *
 * Fastify's `request.ip` is the immediate peer. Behind a load balancer that is
 * the balancer, so §12's per-IP buckets — `auth` at 30/min, `portal_session`
 * at 10/hour, `public_niche_reports` at 120/hour — all collapse onto ONE key
 * shared by every caller on the platform. Thirty sign-ins a minute, globally.
 *
 * Bare `trustProxy: true` is not the fix. It trusts the entire
 * `X-Forwarded-For` chain, so any caller can prepend a forged address and land
 * in an untouched bucket — evasion instead of denial of service, which is
 * worse because it is silent and free. A HOP COUNT trusts exactly that many
 * entries at the right-hand end of the chain and treats everything beyond as
 * caller input.
 *
 * ⚠ THE COUNT IS OF **APPENDING** HOPS. A hop that relays the chain verbatim
 * — nominara-app does — writes no entry and consumes no count, because
 * `proxy-addr` begins at the socket peer and that peer is the relaying hop.
 * `browser → ingress → nominara-app → api` is ONE. The counting rule and why
 * an off-by-one here is invisible under honest traffic are in
 * src/config/env.schema.ts; the arithmetic is pinned in
 * test/unit/trust-proxy.spec.ts.
 *
 * Absent means no proxy. That is the honest default: with nothing in front,
 * the peer address IS the client, and a wrong guess in the other direction
 * would hand every caller control of their own bucket key.
 */
export function fastifyServerOptions(): FastifyServerOptions {
  const env = loadEnv();
  // Batch 19 - an allow-list of proxy RANGES, and it WINS over the hop count when set. Fastify trusts a forwarded hop only when its address is in
  // the list, so a direct caller outside the ranges cannot have a header believed; this removes the "only the proxy can reach the API" precondition
  // the hop rule carries (decision 108(k)). Blank is the same as unset. Set but with NO valid entry: trust NOBODY (the peer address is the client),
  // and do NOT fall back to TRUST_PROXY_HOPS - an operator who wrote an allow-list asked for the narrower rule, and the broader one is not a safe
  // answer to a typo. Coarse rate-limit buckets are the cost, and the warning says why. A catch-all (/0) entry is refused the same way (see the parser).
  const cidrs = env.TRUSTED_PROXY_CIDRS?.trim();
  if (cidrs !== undefined && cidrs !== "") {
    const { valid, dropped, catchAll } = parseTrustedProxyCidrs(cidrs);
    if (dropped > 0) logger.warn({ event: "trusted_proxy_cidrs_entries_dropped", dropped, kept: valid.length });
    // The count only, never the text: the entry is operator input, and what matters is that it was refused and that the rest of the list still applies.
    if (catchAll > 0) logger.warn({ event: "trusted_proxy_cidrs_catch_all_refused", refused: catchAll, kept: valid.length, effect: "a /0 range would trust every peer" });
    if (valid.length === 0) {
      logger.warn({ event: "trusted_proxy_cidrs_none_valid", effect: "no proxy trusted; request.ip is the socket peer" });
      return {};
    }
    return { trustProxy: valid };
  }
  const hops = env.TRUST_PROXY_HOPS;
  // fastify >= 5.12.2 made a NUMERIC trustProxy fail closed (request.ip is always the socket peer: a hop count cannot validate
  // the immediate peer, so a direct client could spoof X-Forwarded-For). That would put every client behind the load balancer in
  // one rate-limit bucket. A trust FUNCTION is not touched by that change, and `(_, hop) => hop < hops` is exactly what a hop
  // count meant before: trust the first N hops from the socket peer. The same precondition applies as before and is now
  // explicit - the API must be reachable only through its proxy chain (network policy), because the peer itself is trusted.
  // Pinned by test/unit/trust-proxy.spec.ts. TRUSTED_PROXY_CIDRS (above) is the allow-list that removes the precondition.
  return hops === undefined ? {} : { trustProxy: (_address: string, hop: number): boolean => hop < hops };
}
