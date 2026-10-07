import type { ClientBase } from "pg";
import { assertManualRunCapturable } from "../../lib/capture/manual-run.js";
import type { CreditAction } from "../decorators/credits.decorator.js";

// STORY-034 — what a credit-priced action must have in hand BEFORE CreditGuard
// reserves anything.
//
// WHY THIS LIVES IN CreditGuard'S OWN PATH AND NOT IN A GUARD OF ITS OWN.
// Every guard in this application is a global `APP_GUARD` (api.module.ts), and
// Nest runs global guards before controller- and route-level ones — so a guard
// attached with `@UseGuards()` to the trigger route would run AFTER
// CreditGuard, which is exactly the wrong side of the reservation. Only a
// global guard registered ahead of CreditGuard could refuse first, and that is
// a change to §5's documented chain (and to the order api.module.spec.ts
// locks) for one action's benefit, reachable only if the route also remembers
// a decorator. Consulted from `CreditGuard.reserve`, immediately before the
// wallet is touched, the ordering holds BY CONSTRUCTION: there is no
// arrangement of the guard array that puts a reservation ahead of this check.
//
// A precondition REFUSES BY THROWING A DOMAIN ERROR. CreditGuard collects it
// rather than letting it escape the transaction it runs in, so the daily-cap
// increment DailyCapGuard already committed can be given back — a refused
// request must not spend the day's allowance any more than a wallet refusal
// does (STORY-071 AC6).
//
// `Record<CreditAction, ...>` so a new priced action has to say what — if
// anything — it needs first; `null` is an explicit "nothing to check".

/** The part of the request a precondition may read. */
export interface CreditPreconditionRequest {
  readonly params?: Record<string, string | undefined>;
}

export type CreditPrecondition = (tx: ClientBase, request: CreditPreconditionRequest) => Promise<void>;

/**
 * `deep_scan`: refuse an empty scope. `POST /projects/:id/runs` is the only
 * route that carries it, and its project is the `:id` segment.
 *
 * A route with no `:id` (the specs that mount `@Credits("deep_scan")` on a
 * bare test controller) has no scope to inspect and passes through. The real
 * route is pinned by deep-scan-zero-scope-http.spec.ts, which fails if the
 * segment is ever renamed out from under this.
 */
const deepScanHasSomethingToCapture: CreditPrecondition = async (tx, request) => {
  const projectId = request.params?.["id"];
  if (projectId === undefined) return;
  await assertManualRunCapturable(tx, projectId);
};

export const CREDIT_PRECONDITIONS: Readonly<Record<CreditAction, CreditPrecondition | null>> = Object.freeze({
  deep_scan: deepScanHasSomethingToCapture,
});
