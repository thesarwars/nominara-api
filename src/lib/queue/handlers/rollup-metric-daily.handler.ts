import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { denormalizeProject } from "../../rollup/denormalize.js";
import { refreshProjectGeoWindows } from "../../rollup/refresh-project-geo.js";
import { datesWithFacts } from "../../rollup/aggregate-day.js";
import { refreshProjectDisplacements } from "../../rollup/refresh-project-displacements.js";
import { refreshProjectSourceIndex } from "../../rollup/refresh-project-source-index.js";
import { rollUpDay } from "../../rollup/roll-up-day.js";
import { withProjectQueueLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-042 — `rollup.metric_daily`.
//
// ADVISORY-LOCKED PER PROJECT (AC2), using the helper STORY-030 already
// built for exactly this queue: "rollup.metric_daily ... advisory-locked per
// project". Two workers on one project serialise rather than racing, which
// matters because the second pass reads the rows the first pass writes — a
// concurrent run would blend a half-written set.
//
// THE LOCK IS TRANSACTION-SCOPED, so it releases on COMMIT or ROLLBACK with
// no unlock call to forget. `withTenantJob` has already opened the
// transaction by the time this runs.

const payloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string(),
    projectId: z.string().uuid(),
    /**
     * `YYYY-MM-DD`, workspace-local. Absent means "every date with facts in
     * the range below" — which is what a rebuild sends.
     */
    metricDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    /** A rebuild's inclusive range. AC10's endpoint sends these. */
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    reason: z.string().optional(),
  })
  .strict();

export function createRollupMetricDailyHandler(_context: QueueHandlerContext): JobProcessor {
  const logger = new Logger("rollup.metric_daily");

  return async (tx: ClientBase, job: Job): Promise<void> => {
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);

    // AC3 — THE TIMEZONE IS THE WORKSPACE'S, read from the row rather than
    // taken from the server or the payload. A payload-supplied zone would let
    // a stale job bucket a day against a timezone the workspace has since
    // changed, and every chart built from it would be wrong in a way no test
    // that runs in one timezone can see.
    const settings = await tx.query<{ timezone: string }>(
      `SELECT w.timezone
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [payload.projectId],
    );
    const timezone = settings.rows[0]?.timezone;
    if (timezone === undefined) {
      logger.log(`project ${payload.projectId} is gone; skipping rollup`);
      return;
    }

    await withProjectQueueLock(tx, "rollup.metric_daily", payload.projectId, async () => {
      const dates =
        payload.metricDate !== undefined
          ? [payload.metricDate]
          : payload.fromDate !== undefined && payload.toDate !== undefined
            ? await datesWithFacts(tx, payload.projectId, timezone, payload.fromDate, payload.toDate)
            : [await localToday(tx, timezone)];

      for (const date of dates) {
        const groups = await rollUpDay(tx, payload.workspaceId, payload.projectId, date, timezone);
        logger.log(`rolled up ${payload.projectId} ${date}: ${String(groups)} groups`);
        // NEW-C-3 — displacement persistence after each day's rollup, in date
        // order (recovery needs the earlier event to exist). Idempotent on a
        // dirty date: the pair's unique key makes a re-run an update.
        await refreshProjectDisplacements(tx, payload.projectId, date, timezone);
      }

      // AC9 — ONCE, after every date. Denormalising per date would write the
      // project row N times for one rebuild and leave it holding whichever
      // date happened to be last rather than the most recent one.
      await denormalizeProject(tx, payload.projectId, timezone);

      // NEW-C-4 — the Source Citation Index (and source_coverage) is derived
      // from citation_facts; recompute it here, inside the same tenant
      // transaction and lock, so it never serves a stale or seeded index. It
      // reads only this database: no network call.
      await refreshProjectSourceIndex(tx, payload.projectId, await localToday(tx, timezone));

      // STORY-060 — A3 answer structure, persisted to geo_analyses so the
      // read endpoints only read. Same transaction and lock; reads only this
      // database (no network call), free and unmetered.
      await refreshProjectGeoWindows(tx, payload.projectId);
    });
  };
}

/** Today, in the workspace's zone. Asked of Postgres so the conversion uses the same tz database the aggregate does. */
async function localToday(tx: ClientBase, timezone: string): Promise<string> {
  const row = await tx.query<{ today: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`, [
    timezone,
  ]);
  return row.rows[0]!.today;
}
