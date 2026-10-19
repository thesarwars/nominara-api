import type { Pool } from "pg";
import type { Env } from "../../config/env.schema.js";
import { createBillingAutoTopupHandler } from "./handlers/billing-auto-topup.handler.js";
import { createBillingCustomerEmailHandler } from "./handlers/billing-customer-email.handler.js";
import { createCaptureExecuteHandler } from "./handlers/capture-execute.handler.js";
import { createCapturePlanHandler } from "./handlers/capture-plan.handler.js";
import { createCaptureParseHandler } from "./handlers/capture-parse.handler.js";
import { createCreditHousekeepingHandler } from "./handlers/credit-housekeeping.handler.js";
import { createCreditReconcileHandler } from "./handlers/credit-reconcile.handler.js";
import { createRetentionPurgeHandler } from "./handlers/retention-purge.handler.js";
import { createAuditVerifyHandler } from "./handlers/audit-verify.handler.js";
import { createIdentitySweepUnverifiedHandler } from "./handlers/identity-sweep-unverified.handler.js";
import { createMaintenancePartitionHandler } from "./handlers/maintenance-partition.handler.js";
import { createCrawlAuditHandler } from "./handlers/crawl-audit.handler.js";
import { createCrawlDiscoverHandler } from "./handlers/crawl-discover.handler.js";
import { createRollupMetricDailyHandler } from "./handlers/rollup-metric-daily.handler.js";
import { createSourceVerifyPresenceHandler } from "./handlers/source-verify-presence.handler.js";
import { createTaskGenerateHandler } from "./handlers/task-generate.handler.js";
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
 * `capture.plan` lands with NEW-A-10: it plans and dispatches one scheduled
 * run for one project. It is tenant-scoped, so the schedule registrar will
 * never tick it as a bare cron; its producer is the sweep (NEW-A-13).
 *
 * `capture.arbitrate` is STILL INERT and that is deliberate: it has no bound
 * model (STORY-038 left the port unbound pending a dependency decision), and a
 * worker pulling a job it cannot process would fail it into the dead-letter
 * queue — turning "not built yet" into "tried and failed" in the record an
 * operator reads during an incident.
 *
 * `task.generate` lands with STORY-063: it evaluates the task rule catalog for one project and day. Its producers are the
 * rollup handler (after each day's rollup) and, later, the AUX finding lifecycle.
 *
 * `maintenance.partition` is the obvious first real entry — non-tenant-
 * scoped, and its logic already exists in src/workers/rollup/maintenance.ts,
 * invoked today only by a hand-run script (README gap G-10). Wiring it is a
 * behaviour change and belongs to its own story.
 */
export const QUEUE_HANDLERS: Partial<Record<QueueName, QueueHandlerFactory>> = {
  "crawl.discover": (context) => createCrawlDiscoverHandler(context),
  "capture.plan": (context) => createCapturePlanHandler(context),
  "crawl.audit": (context) => createCrawlAuditHandler(context),
  "capture.execute": (context) => createCaptureExecuteHandler(context),
  "capture.parse": (context) => createCaptureParseHandler(context),
  "rollup.metric_daily": (context) => createRollupMetricDailyHandler(context),
  "credit.reconcile": (context) => createCreditReconcileHandler(context),
  "credit.housekeeping": (context) => createCreditHousekeepingHandler(context),
  "retention.purge": (context) => createRetentionPurgeHandler(context),
  "maintenance.partition": (context) => createMaintenancePartitionHandler(context),
  "audit.verify": (context) => createAuditVerifyHandler(context),
  "identity.sweep_unverified": (context) => createIdentitySweepUnverifiedHandler(context),
  "source.verify_presence": (context) => createSourceVerifyPresenceHandler(context),
  "task.generate": (context) => createTaskGenerateHandler(context),
  "billing.auto_topup": (context) => createBillingAutoTopupHandler(context),
  "billing.customer_email": (context) => createBillingCustomerEmailHandler(context),
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
