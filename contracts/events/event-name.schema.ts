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
} as const satisfies Record<RealtimeEventName, string>;

/**
 * §11's "Coalescing" column, in milliseconds, for the events that carry one.
 *
 * `run.progress` is the only per-RUN budget; the `≤ 5 / s / project` rows are
 * per-project, and `engine.degraded` is per-engine. The key an event is
 * coalesced ON therefore differs by event, which is why this is a table rather
 * than one number — collapsing them would coalesce two projects' findings
 * against each other.
 */
export const REALTIME_COALESCING_MS = {
  "run.progress": 750,
  "aux.finding_created": 200,
  "task.created": 200,
  "displacement.detected": 200,
  "engine.degraded": 60_000,
} as const;

export type CoalescedEventName = keyof typeof REALTIME_COALESCING_MS;

/**
 * WHAT each budget is PER — the payload field carrying the coalescing key.
 *
 * §11 does not give one shared budget: `run.progress` is per RUN, the
 * "≤ 5 / s" rows are per PROJECT, and `engine.degraded` is per ENGINE. Sharing
 * one budget across projects would coalesce two tenants' findings against each
 * other, which is a correctness failure wearing a performance optimisation's
 * clothes.
 *
 * Declared here, next to the windows, rather than in the gateway: both halves
 * are read off the same reference table, and splitting them across a contract
 * and a service is how the two drift.
 */
export const REALTIME_COALESCE_KEY_FIELD = {
  "run.progress": "run_id",
  "aux.finding_created": "project_id",
  "task.created": "project_id",
  "displacement.detected": "project_id",
  "engine.degraded": "engine_key",
} as const satisfies Record<CoalescedEventName, string>;
