import { z } from "zod";

// STORY-026 T19 — api-specification.md §11's realtime event catalog.
//
// Namespace `/rt`; rooms `ws:{workspace_id}` and `proj:{project_id}`.
//
// A CLOSED union, exactly like the error taxonomy: a new event is a change to
// §11 first and this file second, never the other way round. The table has 18
// rows and NINETEEN events — one row carries both `scan.engine_result` and
// `scan.completed` — which is the kind of miscount a row-shaped reading
// produces and a name-shaped one cannot.
//
// VOCABULARY. These are `run.*` events over `capture_runs`. The word
// "simulation" appears nowhere in this catalog and must not: a run is a real
// capture against a real engine, and calling it a simulation would misdescribe
// the product to every client that renders these events.
export const realtimeEventNameSchema = z.enum([
  // capture
  "run.progress",
  "run.completed",
  "run.failed",
  "scan.engine_result",
  "scan.completed",
  // crawl
  "aux.audit_completed",
  "aux.finding_created",
  // rollup
  "task.created",
  "displacement.detected",
  // api
  "task.moved",
  "member.changed",
  "credits.topped_up",
  // api or worker
  "quota.threshold",
  "credits.debited",
  // worker
  "credits.threshold",
  "credits.depleted",
  "report.ready",
  "engine.degraded",
  // gateway
  "server.draining",
  // STORY-026 — both were already on the wire and in neither the union nor
  // the catalog, while this file called itself a closed set and clients had
  // to act on both. An event that is typed nowhere is an event a client
  // cannot handle.
  "resync",
  "error",
]);

export type RealtimeEventName = z.infer<typeof realtimeEventNameSchema>;

export const REALTIME_EVENT_COUNT = realtimeEventNameSchema.options.length;

/**
 * §11's "Emitted by" column, as data.
 *
 * Carried because it is the difference between an event this repository must
 * publish and one it must only be able to receive. `api` and `gateway` events
 * have a producer here; every `worker-*` event's producer arrives with the
 * epic that builds that worker, and claiming otherwise would make this catalog
 * describe a publisher that does not exist.
 */
export const REALTIME_EVENT_PRODUCER = {
  "run.progress": "worker-capture",
  "run.completed": "worker-rollup",
  "run.failed": "worker-capture",
  "scan.engine_result": "worker-capture",
  "scan.completed": "worker-capture",
  "aux.audit_completed": "worker-crawl",
  "aux.finding_created": "worker-crawl",
  "task.created": "worker-rollup",
  "task.moved": "api",
  "displacement.detected": "worker-rollup",
  "quota.threshold": "api-or-worker",
  "credits.debited": "api-or-worker",
  "credits.threshold": "worker",
  "credits.depleted": "worker",
  "credits.topped_up": "api",
  "report.ready": "worker-report",
  "engine.degraded": "worker-capture",
  "member.changed": "api",
  "server.draining": "gateway",
  // Both are produced BY the gateway and only by it: they describe the
  // delivery channel's own state, not the workspace's. Nothing upstream can
  // know a socket is over budget.
  "resync": "gateway",
  "error": "gateway",
} as const satisfies Record<RealtimeEventName, string>;

/**
 * §11's per-event delivery budgets — WHAT the budget is, not just how big.
 *
 * The reference gives two different guarantees and the code gave one. Every
 * budgeted event was a 200 ms-to-750 ms REPLACE-LATEST throttle, which is
 * right for `run.progress` (a client wants the current percentage, not every
 * percentage) and wrong for the "≤ 5 / s" rows, which carry DISTINCT ids:
 * twenty findings in a second delivered about five and the client never
 * learned of the other fifteen. Silently. Last-write-wins on a creation event
 * is data loss wearing a throttle's clothes.
 *
 * So the two are named apart:
 *
 *   replace_latest — at most one per window, and the one sent is the CURRENT
 *   state. Superseded values are meant to be dropped.
 *
 *   rate_limit — a real per-second budget which PERMITS the burst §11 allows
 *   (5/s means five at once; 200 ms spacing does not), and when it is spent
 *   the client is told ONCE to resync rather than quietly missing rows.
 *
 * `keyField` is what the budget is counted per, read from the event's own
 * payload: `run.progress` is per RUN, the "≤ 5 / s" rows are per PROJECT,
 * `engine.degraded` per ENGINE. One shared budget would coalesce two projects'
 * findings against each other — a correctness failure dressed as a
 * performance optimisation.
 */
export const REALTIME_DELIVERY_BUDGET = {
  "run.progress": { kind: "replace_latest", windowMs: 750, keyField: "run_id" },
  "engine.degraded": { kind: "replace_latest", windowMs: 60_000, keyField: "engine_key" },
  "aux.finding_created": { kind: "rate_limit", perSecond: 5, keyField: "project_id" },
  "task.created": { kind: "rate_limit", perSecond: 5, keyField: "project_id" },
  "displacement.detected": { kind: "rate_limit", perSecond: 5, keyField: "project_id" },
} as const;

export type BudgetedEventName = keyof typeof REALTIME_DELIVERY_BUDGET;

/**
 * §11's other three rules, and why they are NOT in the table above.
 *
 * `quota.threshold` is "once per threshold", `credits.threshold` "once per
 * threshold per cycle", `credits.depleted` "once per cycle". None is a time
 * window — they are once-per-STATE, and the state is a billing cycle that
 * outlives any socket, any gateway process and any replica.
 *
 * The gateway cannot honour them. It has no idea which threshold was crossed
 * or which cycle is current beyond what a payload asserts, and its bookkeeping
 * is per-socket and in-memory: it resets on reconnect, and a second replica
 * has its own. "Once per cycle" enforced that way is once per socket per
 * process per month, which is not the same promise and is worse than none,
 * because it looks like the promise.
 *
 * They belong to the PRODUCER, with durable state — the workers that arrive
 * with EPIC-04+, which is also when these events first have a publisher.
 * Listed here so the absence is a recorded decision rather than an oversight
 * the next reader has to infer from an empty row.
 */
export const PRODUCER_ENFORCED_EVENT_RULES = {
  "quota.threshold": "once per threshold",
  "credits.threshold": "once per threshold per cycle",
  "credits.depleted": "once per cycle",
} as const;

/**
 * The replace-latest windows alone, DERIVED rather than restated.
 *
 * `Coalescer` only ever handled replace-latest and should only ever be asked
 * to. Keeping a second hand-maintained list would let the two disagree about
 * which events coalesce — and the disagreement would be silent.
 */
export const REALTIME_COALESCING_MS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(REALTIME_DELIVERY_BUDGET)
      .filter(([, budget]) => budget.kind === "replace_latest")
      .map(([name, budget]) => [name, (budget as { windowMs: number }).windowMs]),
  ),
);
