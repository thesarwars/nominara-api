import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { expireDuePurchasedCredits, type ExpiryOutcome } from "../../credits/expire.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { DAILY_COUNTER_RETAIN_DAYS, purgeDailyCounters } from "../../usage/daily-cap.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-076 AC4 and STORY-071 AC10 — `credit.housekeeping`, the daily tick for the two credit jobs that were built,
// tested, and called by nothing:
//
//   1. `expireDuePurchasedCredits` — FIFO expiry of purchased credits, writing an `expire` ledger entry
//      (`plans-and-entitlements.md` §5: "12 months from purchase, FIFO by expiry. Expiry writes an `expire` ledger
//      entry"). Before this, a purchased credit never expired.
//   2. `purgeDailyCounters` — `schemas/billing-and-credits.md`: "Rows older than 35 days are purged nightly."
//
// ⚠ ONE QUEUE FOR BOTH, AND THE REASON IS THE CONNECTION, NOT TIDINESS. Both need the same privileged, direct,
// non-pooled connection (`credit_purchases`, `credit_wallets` and `credit_daily_counters` carry FORCE ROW LEVEL
// SECURITY, so a cross-tenant scan on the runtime role sees nothing and reports a clean run). Two queues would be two
// of those per night for jobs that are each a few statements. They stay INDEPENDENT STEPS: one throwing never skips
// the other, and each reports its own metric, so a DLQ entry plus the log line still names the step that failed.
//
// ⚠ NOT IN §4's QUEUE TABLE, AND THE SCHEDULE IS NOT IN ANY REFERENCE. §4 allocates no queue to either job and no
// reference gives a time of day for them (the data model says only "nightly" for the purge and states no cadence for
// expiry). The queue is added by the precedent of `audit.verify`, `identity.sweep_unverified` and `billing.auto_topup`,
// and the hour is a chosen quiet window (see `schedule.ts`) the owner can move. Expiry at 12-month granularity loses
// nothing to a one-day cadence.
//
// ⚠ SINGLE-FLIGHT ACROSS REPLICAS by the session advisory lock, taken as a TRY: BullMQ's `concurrency` bounds one
// Worker, not the queue. A replica that does not get it yields and loses nothing — the next day asks the same
// question — and the sweep is idempotent besides (see `expire.ts`), so an overlap cannot double-expire.
//
// ⚠ A FAILURE DOES FAIL THE JOB here, unlike the reconciler. The reconciler runs every ten minutes, so a failed
// reservation is retried without ceremony; this runs once a day, so the retry ladder is the only prompt second try,
// and both steps are idempotent, so re-running the one that already succeeded costs nothing.
export function createCreditHousekeepingHandler(context: QueueHandlerContext): JobProcessor {
  const logger = new Logger("credit.housekeeping");

  return async (_client: ClientBase, _job: Job): Promise<void> => {
    const discovery = await connect(withKeepalives(context.env.DATABASE_URL));
    const lockKey = globalQueueLockKey("credit.housekeeping");
    let held = false;
    let failedSteps = 0;
    try {
      held = await tryAdvisorySessionLock(discovery, lockKey);
      if (!held) {
        incrementCounter("nominara_credit_housekeeping_yielded_total");
        logger.warn("another replica holds the credit housekeeping lock; yielding this tick");
        return;
      }

      let expiry: ExpiryOutcome | undefined;
      try {
        expiry = await expireDuePurchasedCredits({ discovery, work: context.pool });
      } catch (error) {
        failedSteps += 1;
        incrementCounter("nominara_credit_housekeeping_step_failed_total", { step: "expiry" });
        logger.error(`credit expiry step failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (expiry !== undefined) {
        if (expiry.workspacesExpired > 0) incrementCounter("nominara_credit_expiry_workspaces_total");
        for (const failure of expiry.failures) {
          failedSteps += 1;
          incrementCounter("nominara_credit_housekeeping_step_failed_total", { step: "expiry_workspace" });
          // The workspace ID and the database's reason — never a name, never a balance.
          logger.error(`could not expire credits: workspaceId=${failure.workspaceId} reason="${failure.reason}"`);
        }
      }

      let purged = 0;
      try {
        purged = await purgeDailyCounters(discovery, DAILY_COUNTER_RETAIN_DAYS);
        if (purged > 0) incrementCounter("nominara_credit_daily_counters_purged_total");
      } catch (error) {
        failedSteps += 1;
        incrementCounter("nominara_credit_housekeeping_step_failed_total", { step: "daily_counter_purge" });
        logger.error(`daily counter purge step failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      incrementCounter("nominara_credit_housekeeping_runs_total");
      // Counts only — never an address, a name or a balance.
      logger.log(
        `credit housekeeping: expiry checked ${String(expiry?.workspacesChecked ?? 0)} workspace(s), ` +
          `expired ${String(expiry?.creditsExpired ?? 0)} credit(s) in ${String(expiry?.workspacesExpired ?? 0)}; ` +
          `purged ${String(purged)} daily counter row(s); ${String(failedSteps)} failure(s)`,
      );
    } finally {
      // `end()` is the guarantee that the lock is released; the explicit unlock is the documentation (see
      // credit-reconcile.handler.ts for the reasoning, which applies unchanged).
      if (held && !(await releaseAdvisorySessionLock(discovery, lockKey))) {
        logger.error("credit housekeeping lock was not held at release — the lock key or the connection changed under us");
      }
      await discovery.end();
    }

    if (failedSteps > 0) {
      throw new Error(`credit housekeeping: ${String(failedSteps)} step(s) failed — see the log for each`);
    }
  };
}
