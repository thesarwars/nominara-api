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
import { afterCommit, currentTenantStore } from "../../../tenancy/tenant-context.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { withProjectQueueLock } from "../locks.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../connection.js";
import { QueueProducer } from "../queue-producer.js";
import type { QueueHandlerContext } from "../handlers.js";
import { signingKeysFromEnv, type JobProcessor } from "../worker-factory.js";

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

/** Enqueues one `source.verify_presence` job. Injected in tests; production builds a producer from env on first use. */
export type EnqueueVerifyPresence = (workspaceId: string, payload: { projectId: string }, idempotencyKey: string) => Promise<unknown>;

/** STORY-063 — enqueues one `task.generate` job for a project and workspace-local day. Injected in tests. */
export type EnqueueTaskGenerate = (workspaceId: string, payload: { projectId: string; metricDate: string }, idempotencyKey: string) => Promise<unknown>;

export interface RollupMetricDailyDeps {
  readonly enqueueVerifyPresence?: EnqueueVerifyPresence;
  readonly enqueueTaskGenerate?: EnqueueTaskGenerate;
}

export function createRollupMetricDailyHandler(context: QueueHandlerContext, deps?: RollupMetricDailyDeps): JobProcessor {
  const logger = new Logger("rollup.metric_daily");

  // Built on the first job, inside the promise: constructing a producer at registration would open a
  // connection in every process that merely imports the registry, and a synchronous throw here would
  // escape the caller's `.catch`.
  let producer: QueueProducer | undefined;
  const enqueueVerifyPresence: EnqueueVerifyPresence =
    deps?.enqueueVerifyPresence ??
    (async (workspaceId, payload, idempotencyKey): Promise<unknown> => {
      producer ??= new QueueProducer(
        createQueueWorkerConnection(context.env.QUEUE_REDIS_URL),
        queueKeyPrefix(context.env.NODE_ENV),
        signingKeysFromEnv(context.env),
      );
      return producer.enqueueTenantJob("source.verify_presence", workspaceId, payload, { idempotencyKey });
    });

  const enqueueTaskGenerate: EnqueueTaskGenerate =
    deps?.enqueueTaskGenerate ??
    (async (workspaceId, payload, idempotencyKey): Promise<unknown> => {
      producer ??= new QueueProducer(
        createQueueWorkerConnection(context.env.QUEUE_REDIS_URL),
        queueKeyPrefix(context.env.NODE_ENV),
        signingKeysFromEnv(context.env),
      );
      return producer.enqueueTenantJob("task.generate", workspaceId, payload, { idempotencyKey });
    });

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

      // STORY-060 / STORY-061 — the persisted GEO analyses (A3 structure, A6
      // sentiment), each over the 7/30/90-day windows, written to geo_analyses
      // so the read endpoints only read. Same transaction and lock; reads only this
      // database (no network call), free and unmetered.
      await refreshProjectGeoWindows(tx, payload.projectId);

      // NEW-C-15 — owner decision 2026-10-08: brand presence is verified AFTER the rollup. The verify
      // job fetches third-party pages, so it may not run inside this transaction (KAD-06); it is queued
      // once this one has committed, so it sees the index this run wrote. One key per project and
      // workspace-local day, so a replay or a second rollup the same day queues nothing more. A failed
      // enqueue is logged, never thrown: the rollup is durable and the next day's run asks again.
      // No ambient tenant transaction (a direct call outside the worker) means no commit to wait for.
      if (currentTenantStore() !== undefined) {
        const today = await localToday(tx, timezone);
        const { projectId, workspaceId } = payload;

        // STORY-063 AC3 — generation runs after each rollup, on the latest day it rolled up. A separate job, queued once this
        // transaction has committed (so it reads what this run wrote), because the rule evaluation is its own unit of
        // work with its own retries. The key carries this job's id: a redelivery of THIS rollup queues nothing more, while
        // a later rollup of the same day (a dirty-date reprocess) queues a fresh evaluation, which is safe because
        // generation is idempotent. A failed enqueue is logged, never thrown: the rollup is durable.
        //
        // The day evaluated is never earlier than TODAY: a dirty-date or from/to reprocess of past days ends on an old date, and a
        // trailing window anchored there would raise tasks from a period that may be weeks old and already recovered. Event rules
        // (displacement, AUX) do not depend on the date at all, so nothing is lost by evaluating the present.
        //
        // No `triggerKinds` is passed on purpose (AC3, "rules whose trigger matches the changed facts"): a rollup changes every metric a
        // windowed rule reads and the event rules read their own tables, so the changed facts of a rollup match every trigger kind.
        // Narrowing is for a producer that knows ONE kind of change (the AUX audit), which is what the payload field is for.
        const lastDate = dates[dates.length - 1];
        if (lastDate !== undefined) {
          const evaluateDate = lastDate > today ? lastDate : today;
          const runKey = job.id ?? today;
          afterCommit(() => {
            void enqueueTaskGenerate(workspaceId, { projectId, metricDate: evaluateDate }, `taskgen:${projectId}:${evaluateDate}:${runKey}`)
              .then(() => {
                incrementCounter("nominara_taskgen_requested_total");
              })
              .catch((error: unknown) => {
                incrementCounter("nominara_taskgen_request_failed_total");
                logger.error({
                  event: "taskgen.request_failed",
                  workspace_id: workspaceId,
                  project_id: projectId,
                  error: error instanceof Error ? error.name : "unknown",
                });
              });
          });
        }
        afterCommit(() => {
          void enqueueVerifyPresence(workspaceId, { projectId }, `srcver:${projectId}:${today}`)
            .then(() => {
              incrementCounter("nominara_sources_presence_requested_total");
              logger.log({ event: "source.presence_requested", workspace_id: workspaceId, project_id: projectId });
            })
            .catch((error: unknown) => {
              incrementCounter("nominara_sources_presence_request_failed_total");
              logger.error({
                event: "source.presence_request_failed",
                workspace_id: workspaceId,
                project_id: projectId,
                error: error instanceof Error ? error.name : "unknown",
              });
            });
        });
      }
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
