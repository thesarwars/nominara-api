import type { NestFastifyApplication } from "@nestjs/platform-fastify";

// STORY-025 T18 — every request from its own source address.
//
// WHY THIS EXISTS. §12's `Auth (/auth/*)` row is 30/min per IP with a burst of
// 5, and RateLimitGuard now enforces it on unauthenticated traffic — which is
// the whole point of that row, since a caller signing in has no workspace yet.
// The identity suites drive multi-step auth flows dozens of times through one
// app, all from light-my-request's single default address, so they exhausted a
// real production limit and were refused. The limit was right; the suites were
// simulating a crowd and presenting it as one client.
//
// WHAT IT COSTS, STATED PLAINLY. This is more generous than reality: a single
// user's three-step sign-in genuinely comes from ONE address, and here it gets
// three. The consequence is that these suites do NOT exercise §12's per-IP auth
// bucket at all — that bucket is covered by test/unit/rate-limit-buckets.spec
// .ts, which asserts the sixth request from one address is refused. Choosing
// per-request rather than per-actor keeps this to one line per suite instead of
// a judgement at sixty-seven call sites, and the thing being given up is
// covered elsewhere rather than merely waived.
//
// An explicit `remoteAddress` on a call still wins, so a test that IS about one
// source — STORY-016's per-source ledger — keeps saying so.

const SOURCE_PREFIX = "198.51.100.";

/**
 * Wraps `app.inject` so each call comes from a distinct address.
 *
 * Call once, after `app.init()`. 198.51.100.0/24 is TEST-NET-2 (RFC 5737):
 * documentation addresses that can never be a real client, so a value leaking
 * into an assertion is obviously a test artefact.
 */
export function eachRequestFromItsOwnClient(app: NestFastifyApplication): void {
  const inject = app.inject.bind(app) as (options: Record<string, unknown>) => unknown;
  let nth = 0;

  (app as unknown as { inject: (options: Record<string, unknown>) => unknown }).inject = (options) => {
    nth += 1;
    return inject({ remoteAddress: `${SOURCE_PREFIX}${String((nth % 250) + 1)}`, ...options });
  };
}
