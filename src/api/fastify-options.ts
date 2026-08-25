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
 * worse because it is silent and free. A HOP COUNT trusts exactly the proxies
 * the operator says are theirs and treats everything beyond as caller input.
 *
 * Absent means no proxy. That is the honest default: with nothing in front,
 * the peer address IS the client, and a wrong guess in the other direction
 * would hand every caller control of their own bucket key.
 */
export function fastifyServerOptions(): FastifyServerOptions {
  const hops = loadEnv().TRUST_PROXY_HOPS;
  return hops === undefined ? {} : { trustProxy: hops };
}
