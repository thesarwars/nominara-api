import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { SweepBlindError, sweepStaleUnverifiedAccounts } from "../../../workers/rollup/unverified-sweep.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-173 — the daily tick for the stale-unverified-account sweep (owner
// decision, 2026-10-05). The job itself is `sweepStaleUnverifiedAccounts`; this
// is only what makes it a scheduled job: the owner connection, the single-flight
// lock, and the metrics and log line an operator reads.
//
// ⚠ THE OWNER CONNECTION, not the pooled runtime role: the sweep deletes from
// `users`, which the runtime role may not, and it reads `user_credentials`,
// `sessions` and `workspace_members` to decide a row is untouched. It is the same
// privileged-connection contract `audit.verify` and `credit.reconcile` run under.
//
// Idempotent under at-least-once delivery: a second run finds nothing left to
// delete. Single-flight across replicas by the advisory lock, taken as a TRY: a
// replica that does not get it yields, and loses nothing, because the next tick
// asks the same question.
export function createIdentitySweepUnverifiedHandler(context: QueueHandlerContext): JobProcessor {
  const logger = new Logger("identity.sweep_unverified");

  return async (_client: ClientBase, _job: Job): Promise<void> => {
    const client = await connect(withKeepalives(context.env.DATABASE_URL));
    const lockKey = globalQueueLockKey("identity.sweep_unverified");
    let held = false;
    try {
      held = await tryAdvisorySessionLock(client, lockKey);
      if (!held) {
        incrementCounter("nominara_identity_unverified_sweep_yielded_total");
        logger.warn("another replica holds the unverified-sweep lock; yielding this tick");
        return;
      }
      let result;
      try {
        result = await sweepStaleUnverifiedAccounts(client);
      } catch (error) {
        if (error instanceof SweepBlindError) {
          // Loud: a job that fails (DLQ), a metric, and an error line. Nothing
          // was deleted — the check runs before the first read.
          incrementCounter("nominara_identity_unverified_sweep_blind_total");
          logger.error(error.message);
        }
        throw error;
      }
      incrementCounter("nominara_identity_unverified_sweep_runs_total");
      if (result.deleted > 0) {
        incrementCounter("nominara_identity_unverified_accounts_deleted_total");
      }
      // Counts only — never an address or an account id.
      logger.log(
        `unverified sweep: deleted ${String(result.deleted)}, skipped ${String(result.skippedReferenced)} referenced / ${String(result.skippedLocked)} locked`,
      );
    } finally {
      if (held && !(await releaseAdvisorySessionLock(client, lockKey))) {
        logger.error("unverified-sweep lock was not held at release — the lock key or the connection changed under us");
      }
      await client.end();
    }
  };
}
