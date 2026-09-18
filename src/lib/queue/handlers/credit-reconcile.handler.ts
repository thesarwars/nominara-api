import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { connect } from "../../../db/client.js";
import { reconcileOrphanedReservations } from "../../credits/reconcile.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-073 — `credit.reconcile`. `system-architecture.md` §4: producer
// "cron every 10 min", worker group `rollup`, concurrency 1, not tenant
// scoped.
//
// ⚠ STORY-140 GAVE THIS A TIMER, AND THAT CHANGED WHAT "concurrency: 1"
// BUYS. Until then nothing enqueued this job at all — it ran when an
// operator ran it — so the fact that §4 also specifies "advisory-locked"
// beside the concurrency was moot. It is not moot now: a job scheduler fires
// this every ten minutes in EVERY worker-rollup replica, and BullMQ's
// `concurrency` bounds one Worker instance, not the queue. Two replicas at
// concurrency 1 each can run two reconcilers at the same instant — see
// `locks.ts`, whose header made exactly this argument for exactly this
// queue, and whose `globalQueueLockKey` names it. The lock below is §4's
// second half, finally called.

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
    const lockKey = globalQueueLockKey("credit.reconcile");
    let outcome;
    let held = false;
    try {
      // ⚠ TRY, NOT WAIT, and the tick that loses does NOTHING. Waiting would
      // queue the ticks behind a slow scan, each holding a privileged
      // connection to arrive at an estate the winner has already swept. A
      // skipped run costs nothing: "what is still open now" is not a question
      // about a window, so the next tick ten minutes later asks the same one.
      //
      // The lock lives on `discovery` — a dedicated, non-pooled connection
      // ended in this same `finally` — because it must outlive the
      // per-reservation transactions the scan opens. See `locks.ts`.
      held = await tryAdvisorySessionLock(discovery, lockKey);
      if (!held) {
        logger.log("another replica holds the reconcile lock; yielding this tick");
        return;
      }
      outcome = await reconcileOrphanedReservations({ discovery, work: context.pool });
    } finally {
      // ⚠ THESE TWO LINES ARE REDUNDANT AND BOTH ARE HERE ON PURPOSE. Ending
      // the connection releases the lock by itself — Postgres drops every
      // session-level advisory lock when the backend terminates — so the
      // explicit unlock changes nothing observable today, and a mutation
      // removing EITHER one passes the whole suite. Removing BOTH fails six
      // of seven tests, which is what is actually pinned: after this handler
      // returns, by any path, the lock is not held.
      //
      // The explicit unlock earns its place against a change that has not
      // happened yet. If `discovery` ever becomes a pooled client, `end()`
      // turns into `release()` and hands the connection back to the pool
      // STILL HOLDING the lock — which would wedge the reconciler for the
      // life of the process and, because the reconciler is the path that
      // returns credits to people who were never charged, would do it
      // silently. Do not read this line as load-bearing today; read it as the
      // thing that keeps the failure loud if that refactor arrives.
      if (held && !(await releaseAdvisorySessionLock(discovery, lockKey))) {
        logger.error("reconcile lock was not held at release — the lock key or the connection changed under us");
      }
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
