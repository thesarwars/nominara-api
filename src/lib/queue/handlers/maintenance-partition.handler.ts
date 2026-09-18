import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { runMonthlyMaintenance } from "../../../workers/rollup/maintenance.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-142 — `maintenance.partition`, the fourth capability this line of work
// has found built, tested, and reachable by nobody.
//
// ⚠ AND THE FIRST ONE WITH A DATE ON IT. `runMonthlyMaintenance` creates the
// coming months' partitions, detects rows that have fallen into the DEFAULT
// partition, moves cold partitions to their tablespace, drops past retention,
// rebuilds vector indexes and analyses — all of it written under STORY-013,
// all of it tested, and run only when an operator remembers
// `pnpm db:maintenance:run`. On 2026-09-18 the estate had partitions for
// 2026-09 and 2026-10 and nothing beyond.
//
// What makes that a deadline rather than untidiness is the DEFAULT partition.
// Inserts past October do not fail — they land in `default`, silently, which
// is exactly why nobody would notice. But Postgres will not let you ATTACH a
// partition whose range overlaps rows already sitting in `default`: the catch
// -up has to move them out first, under lock, and it gets more expensive every
// day. `detectDefaultPartitionRows` and `catchUpDefaultPartition` exist
// because STORY-013 foresaw this; nothing was scheduled to prevent it.

/**
 * ⚠ THE OWNER ROLE, NOT THE POOLED ONE, and not an optimisation to remove.
 * This job issues DDL — CREATE TABLE, ATTACH, DETACH, DROP, REINDEX — and
 * `nominara_app` owns none of those tables. Same split as
 * `credit.reconcile`'s discovery connection, for the same reason, and it is
 * why `src/workers/rollup/maintenance.ts` reaches for `requireDatabaseUrl()`
 * rather than the pool.
 *
 * ⚠ AND IT CARRIES KEEPALIVES, because `runMonthlyMaintenance` holds a
 * BLOCKING session advisory lock (`MAINTENANCE_LOCK_KEY`) for the whole run.
 * A partitioned replica leaves that lock held by a live backend, and the next
 * tick does not skip — `withAdvisoryLock` is the waiting kind by design
 * (STORY-013 Test Scenario 2) — so it would sit blocked on a privileged
 * connection until the OS TCP keepalive default noticed, which is two hours.
 * See `withKeepalives`.
 */
export function createMaintenancePartitionHandler(context: QueueHandlerContext): JobProcessor {
  const logger = new Logger("maintenance.partition");

  return async (_client: ClientBase, _job: Job): Promise<void> => {
    const client = await connect(withKeepalives(context.env.DATABASE_URL));
    try {
      const result = await runMonthlyMaintenance(client);

      logger.log(
        `maintenance: created ${String(result.partitionsCreated.length)} partition(s), ` +
          `moved ${String(result.coldTierMoved.length)} to cold, dropped ${String(result.dropped.length)}, ` +
          `analysed ${String(result.analyzed.length)}`,
      );

      // ⚠ AN ALERT DOES NOT FAIL THE JOB, and the distinction matters. Rows in
      // the default partition are a fact about the estate that this run has
      // just reported — throwing would send the tick down the retry ladder and
      // into the dead-letter queue, where it would land again tomorrow and the
      // day after, because retrying does not move rows. The run DID its work.
      // What is needed is for somebody to see it, which is what the counter is
      // for: the ops script's non-zero exit has no equivalent on a queue.
      for (const alert of result.defaultPartitionAlerts) {
        incrementCounter("partition_default_rows_detected", { table: alert.table });
        logger.warn(
          `rows are sitting in ${alert.table}'s DEFAULT partition (${String(alert.rowCount)}) — ` +
            `a partition covering their range can no longer be attached until they are moved`,
        );
      }
    } finally {
      await client.end();
    }
  };
}
