import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { connect } from "../../../db/client.js";
import { reconcileOrphanedReservations } from "../../credits/reconcile.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-073 — `credit.reconcile`. `system-architecture.md` §4: producer
// "cron every 10 min", worker group `rollup`, concurrency 1, not tenant
// scoped.
//
// ⚠ NOTHING ENQUEUES THIS YET, and that is the repo's oldest structural gap
// rather than an oversight in this story. No process anywhere registers a
// BullMQ repeatable job — `capture.plan`'s "scheduler cron" producer does
// not exist either, which is why no scheduled tracking run has ever
// happened. The handler is wired here so that the day a scheduler lands, the
// reconciler is already correct and tested rather than being written under
// the deadline of whatever incident prompted it; until then it is reachable
// by enqueueing the job by hand, exactly as `audit-verify.ts` and
// `retention.ts` are reachable by running them.

const payloadSchema = z
  .object({
    /**
     * The time bucket this run covers, from `creditrec:{bucket}`. Carried for
     * the log line and for the queue's own idempotency key; the scan itself
     * does not need it, because "what is still open now" is not a question
     * about a window.
     */
    bucket: z.string().min(1).optional(),
  })
  .strict();

/**
 * ⚠ IT OPENS A PRIVILEGED CONNECTION OF ITS OWN, and that is not an
 * optimisation to remove. The worker's `context.pool` is built from
 * `DATABASE_URL_POOLED` — `nominara_app` — and `credit_ledger` carries FORCE
 * ROW LEVEL SECURITY, so the reconciler's cross-tenant scan sees ZERO ROWS
 * on it and reports a clean run over an estate full of orphans. The
 * second-engineer review reproduced that against this very handler. The
 * releases still go through the pooled runtime role, tenant-scoped; only
 * discovery needs the privilege. See `ReconcileConnections`.
 *
 * Opened per job rather than per handler: this runs every ten minutes, so a
 * connection held open between runs costs more than it saves, and a
 * long-lived privileged connection is a thing to have fewer of.
 *
 * ⚠ IT ALSO USES THE CONTEXT'S POOL, NOT THE CLIENT IT IS HANDED.
 *
 * Every other handler in this repo does its work on the `tx` the worker
 * factory gives it, and doing that here would be wrong. The reconciler opens
 * ONE TRANSACTION PER ORPHANED RESERVATION on purpose — see
 * `reconcile.ts` — because a single transaction across the estate would hold
 * a row lock on every wallet it touched for the length of the scan, and one
 * unreleasable orphan would roll back every release that had already
 * succeeded.
 *
 * `credit.reconcile` is not tenant-scoped, so the factory hands over a bare
 * client with no transaction and no tenant context on it; there is no open
 * transaction being abandoned here, just an unused connection held for the
 * length of the run. Concurrency is 1 on this queue, so that is one
 * connection, and the alternative — a second pool for a job that runs every
 * ten minutes — costs more than it saves.
 */
export function createCreditReconcileHandler(context: QueueHandlerContext): JobProcessor {
  const logger = new Logger("credit.reconcile");

  return async (_client: ClientBase, job: Job): Promise<void> => {
    const payload = payloadSchema.parse((job.data as { payload?: unknown }).payload ?? {});

    const discovery = await connect(context.env.DATABASE_URL);
    let outcome;
    try {
      outcome = await reconcileOrphanedReservations({ discovery, work: context.pool });
    } finally {
      await discovery.end();
    }

    const window = payload.bucket === undefined ? "" : ` bucket=${payload.bucket}`;
    logger.log(
      `orphan scan${window}: found ${String(outcome.found)}, released ${String(outcome.released)} ` +
        `holding ${String(outcome.credits)} credit(s), ${String(outcome.alreadySettled)} already settled, ` +
        `${String(outcome.failures.length)} failure(s)`,
    );

    for (const failure of outcome.failures) {
      logger.error(
        `could not release orphaned reservation: workspaceId=${failure.workspaceId} ` +
          `key=${failure.key} reason="${failure.reason}"`,
      );
    }

    // ⚠ A FAILURE DOES NOT FAIL THE JOB. Throwing would send the whole run
    // down the retry ladder and re-scan every orphan it already released —
    // which is safe, because the ledger's unique index makes a repeat
    // release a no-op, and pointless, because the one reservation that could
    // not be released will fail again on every attempt and then land in the
    // dead-letter queue as though the reconciler itself were broken. The
    // failures are logged per row; the next run, ten minutes later, retries
    // them without ceremony.
  };
}
