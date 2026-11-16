import type { FastifyServerOptions } from "fastify";
import { loadEnv } from "../config/env.js";

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
  const hops = loadEnv().TRUST_PROXY_HOPS;
  // fastify >= 5.12.2 made a NUMERIC trustProxy fail closed (request.ip is always the socket peer: a hop count cannot validate
  // the immediate peer, so a direct client could spoof X-Forwarded-For). That would put every client behind the load balancer in
  // one rate-limit bucket. A trust FUNCTION is not touched by that change, and `(_, hop) => hop < hops` is exactly what a hop
  // count meant before: trust the first N hops from the socket peer. The same precondition applies as before and is now
  // explicit - the API must be reachable only through its proxy chain (network policy), because the peer itself is trusted.
  // Pinned by test/unit/trust-proxy.spec.ts. OWNER DECISION 108(c) follow-up: a CIDR allow-list would remove the precondition.
  return hops === undefined ? {} : { trustProxy: (_address: string, hop: number): boolean => hop < hops };
}
