import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { connect } from "../../../db/client.js";
import { reconcileOrphanedReservations } from "../../credits/reconcile.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import { incrementCounter } from "../../telemetry/metrics.js";
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
/**
 * ⚠ BOUNDS HOW LONG A DEAD PROCESS CAN HOLD THE LOCK, and without it this
 * handler's lock is strictly more dangerous than no lock at all.
 *
 * The case is a replica that is PARTITIONED rather than killed. Killed is
 * already safe — the backend dies and Postgres drops its session locks, which
 * is the argument `locks.ts` makes. Partitioned is not: the client is gone,
 * the backend is alive and idle holding the lock, and because
 * `pg_try_advisory_lock` is fleet-wide, every other replica's tick now yields.
 * No orphaned reservation in any workspace is returned to anyone until that
 * backend notices — and nothing in this repository sets any timeout, so it
 * notices at the OS TCP keepalive default, which is TWO HOURS on Linux.
 *
 * Worse, it is silent: a yielded tick completes successfully, so the
 * dead-letter queue stays empty and every alarm reads green while the one
 * path that hands credits back to customers who were never charged is dead.
 *
 * These are SERVER-side settings for this session, so the backend probes its
 * own peer and terminates itself in roughly 90 seconds instead of two hours —
 * and Postgres releases the session locks of a terminated backend.
 *
 * ⚠ DELIBERATELY NOT AN `idle_session_timeout`. That would also fire during a
 * perfectly healthy long scan: this connection is legitimately idle for most
 * of a run, because the releases happen on the `work` pool. It would then
 * terminate the holder MID-RUN, dropping the lock while the remaining
 * releases carried on unprotected — turning a bounded wait into the exact
 * concurrency this lock exists to prevent. Keepalives distinguish "idle" from
 * "gone"; a timeout cannot.
 *
 * ⚠ PASSED AS STARTUP OPTIONS RATHER THAN `SET`, and not to dodge anything.
 * `eslint-rules/no-session-scoped-config.js` bans a bare `SET` because
 * session-scoped config leaks across pooled connections under pgBouncer
 * transaction pooling (NFR-SEC-02) — a real hazard, and the rule is right.
 * It cannot apply here: this is `DATABASE_URL`, the DIRECT connection, opened
 * by `connect()` per job and never returned to a pool. Startup options are
 * also simply the better mechanism — the GUCs are in force from the moment
 * the backend starts, rather than after three round-trips during which the
 * window this closes is still open.
 */
export function withKeepalives(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", "-c tcp_keepalives_idle=60 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3");
  return url.toString();
}

export function createCreditReconcileHandler(context: QueueHandlerContext): JobProcessor {
  const logger = new Logger("credit.reconcile");

  return async (_client: ClientBase, job: Job): Promise<void> => {
    const payload = payloadSchema.parse((job.data as { payload?: unknown }).payload ?? {});

    const discovery = await connect(withKeepalives(context.env.DATABASE_URL));
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
        // ⚠ COUNTED, NOT JUST LOGGED, AND AT WARN. In steady state there is
        // ONE scheduler across the fleet producing ONE job per cadence, so a
        // yield is already anomalous rather than routine — it means a scan
        // has outrun its ten-minute cadence, or a holder is wedged. The
        // failure this guards is silent by construction: a yielded tick
        // COMPLETES, so the DLQ stays empty and every existing alarm reads
        // green while no orphaned reservation in any workspace is being
        // returned to anyone. An INFO line nobody greps is not a signal.
        incrementCounter("credit_reconcile_yielded_total");
        logger.warn("another replica holds the reconcile lock; yielding this tick");
        return;
      }
      outcome = await reconcileOrphanedReservations({ discovery, work: context.pool });
    } finally {
      // ⚠ `end()` IS THE GUARANTEE; THE EXPLICIT UNLOCK IS THE DOCUMENTATION.
      // An earlier version of this comment called the two redundant, and a
      // review proved that backwards in two directions.
      //
      // `end()` is load-bearing on its own. Remove it and the seven tests
      // below still pass, but every yielded tick LEAKS an owner-role,
      // non-pooled backend — one every ten minutes per replica until
      // `max_connections` is gone, at which point `connect()` above starts
      // failing and reconciliation stops entirely. That is pinned now.
      //
      // And the explicit unlock cannot cover the case that most needs it.
      // Session advisory locks survive ROLLBACK and a failed statement, so if
      // `pg_try_advisory_lock` is executed server-side and the client call
      // then rejects — a cancel, a socket error after the server processed
      // it — the SERVER holds the lock while `held` is false, and the
      // conditional below is skipped. `end()` is the only thing that releases
      // it on that path.
      //
      // The unlock still earns its place, for a change that has not happened
      // yet: if `discovery` ever becomes pooled, `end()` turns into
      // `release()` and hands the connection back STILL HOLDING the lock.
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
