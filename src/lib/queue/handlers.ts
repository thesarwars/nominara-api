import type { Pool } from "pg";
import type { Env } from "../../config/env.schema.js";
import { createCaptureExecuteHandler } from "./handlers/capture-execute.handler.js";
import { createCaptureParseHandler } from "./handlers/capture-parse.handler.js";
import { createCreditReconcileHandler } from "./handlers/credit-reconcile.handler.js";
import { createMaintenancePartitionHandler } from "./handlers/maintenance-partition.handler.js";
import { createCrawlDiscoverHandler } from "./handlers/crawl-discover.handler.js";
import { createRollupMetricDailyHandler } from "./handlers/rollup-metric-daily.handler.js";
import { QUEUE_TOPOLOGY } from "./topology.js";
import type { JobProcessor } from "./worker-factory.js";

// STORY-124 — where a queue handler goes.
//
// src/worker.ts built a real BullMQ Worker for all 21 queues and handed
// every one of them the same throwing placeholder, so the topology,
// signing, idempotency, dead-letter routing and backoff ladders from
// STORY-030 were all real and nothing processed a job. This is the seam
// they were built for.
//
// A STATIC table, not a runtime register() call. A mutable registry makes
// the set of live queues depend on which modules happened to be imported,
// which is a different answer in a test, in the worker, and in the API
// process. This is the same shape QUEUE_TOPOLOGY and ACTIVE_ENGINE_KEYS
// already have: greppable, typed, and visible in a diff.

/** Every queue name in the topology — so a handler cannot be registered for a queue that does not exist. */
export type QueueName = (typeof QUEUE_TOPOLOGY)[number]["name"];

/**
 * What a handler is given. Deliberately small: a pool and the validated
 * env. A handler that needs a service constructs it here rather than
 * reaching for a Nest container the worker process does not run.
 */
export interface QueueHandlerContext {
  readonly pool: Pool;
  readonly env: Env;
}

export type QueueHandlerFactory = (context: QueueHandlerContext) => JobProcessor;

/**
 * The queues that can process a job today.
 *
 * **Every absent queue is deliberate, and stays inert.** A queue with no
 * entry keeps `autorun: false`, so its worker never pulls a job at all —
 * which matters more than it looks. A worker that pulled a job it cannot
 * process would fail it down the retry ladder and into the dead-letter
 * queue, turning "not built yet" into "tried and failed" in the record an
 * operator reads during an incident.
 *
 * A story that produces work lands its handler here in the same commit:
 * `crawl.discover` with STORY-043, `capture.execute` with STORY-034,
 * `capture.parse` with STORY-135, `rollup.metric_daily` with STORY-042.
 * One line each.
 *
 * `credit.reconcile` lands with STORY-073 and is the first handler here
 * whose PRODUCER does not exist. Nothing in this repo registers a BullMQ
 * repeatable job — not for the reconciler, not for `capture.plan`'s
 * "scheduler cron" — so it is wired and will simply never be handed a job
 * until a scheduler does. That is a better state than inert: an inert queue
 * would need this file edited under whatever incident first made someone
 * want the reconciler running, and the handler is correct and tested now.
 *
 * `capture.plan` and `capture.arbitrate` are STILL INERT and that is
 * deliberate. Planning happens on the request path inside the trigger's
 * transaction rather than as a job, so nothing enqueues it; arbitration has
 * no bound model (STORY-038 left the port unbound pending a dependency
 * decision), and a worker pulling a job it cannot process would fail it into
 * the dead-letter queue — turning "not built yet" into "tried and failed" in
 * the record an operator reads during an incident.
 *
 * `maintenance.partition` is the obvious first real entry — non-tenant-
 * scoped, and its logic already exists in src/workers/rollup/maintenance.ts,
 * invoked today only by a hand-run script (README gap G-10). Wiring it is a
 * behaviour change and belongs to its own story.
 */
export const QUEUE_HANDLERS: Partial<Record<QueueName, QueueHandlerFactory>> = {
  "crawl.discover": (context) => createCrawlDiscoverHandler(context),
  "capture.execute": (context) => createCaptureExecuteHandler(context),
  "capture.parse": (context) => createCaptureParseHandler(context),
  "rollup.metric_daily": (context) => createRollupMetricDailyHandler(context),
  "credit.reconcile": (context) => createCreditReconcileHandler(context),
  "maintenance.partition": (context) => createMaintenancePartitionHandler(context),
};

/** The factory for `name`, or undefined when the queue is not wired yet. */
export function handlerFor(name: string): QueueHandlerFactory | undefined {
  return QUEUE_HANDLERS[name as QueueName];
}

/** Names that can process a job, in topology order — for the boot line and for tests. */
export function liveQueueNames(names: readonly string[] = QUEUE_TOPOLOGY.map((entry) => entry.name)): string[] {
  return names.filter((name) => handlerFor(name) !== undefined);
}

/** Names that are still inert, in topology order. */
export function inertQueueNames(names: readonly string[] = QUEUE_TOPOLOGY.map((entry) => entry.name)): string[] {
  return names.filter((name) => handlerFor(name) === undefined);
}
