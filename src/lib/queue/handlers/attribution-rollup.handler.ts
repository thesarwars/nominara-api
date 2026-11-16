import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { ATTRIBUTION_WINDOW_DAYS } from "../../../../contracts/attribution/index.js";
import { addDays, localToday, projectTimezone, purgeProjectRollups, rollUpWindow } from "../../attribution/attribution-rollup.js";
import { raiseSubstitutionAlerts } from "../../attribution/substitution-alert.js";
import { URL_NORMALISATION_VERSION } from "../../attribution/url-normalisation.js";
import { attributionLagSeconds, ATTRIBUTION_LAG_OBJECTIVE_SECONDS } from "../../attribution/rollup-lag.js";
import { afterCommit, currentTenantStore } from "../../../tenancy/tenant-context.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { withProjectQueueLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-114 - `attribution.rollup`: one project's per-URL rollup, every documented window length (7, 30, 90 days) unless one is named.
//
// Runs inside `withTenantJob` (signature verified, tenant context set, transaction open): RLS scopes every statement. The payload is
// strict. IDEMPOTENT under at-least-once delivery: a window's rows are replaced, so a redelivery recomputes the same figures.
// Serialised per project by an advisory lock, as the queue's idempotency key `attr:{project}:{window}` implies.
//
// EACH WINDOW IS COMPUTED WITH ITS PREDECESSOR (the window of the same length that ends where it starts), because the substitution
// alert needs "2 consecutive windows" and the predecessor may never have been a job's own window.
//
// `rebuild: true` is the REBUILD PATH a normalisation change requires (url-normalisation.ts): it first deletes every rollup row of the
// project, whatever key it was built under, then recomputes from the sources, re-keying each URL string with the current normalisation.
//
// No network call (KAD-06): Postgres only. The producer is the hourly sweep over projects with a receiving configuration
// (src/lib/attribution/sweep.ts), run by the worker's report group.

const tracer = trace.getTracer("nominara-api");

const payloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string(),
    projectId: z.string().uuid(),
    /** `YYYY-MM-DD`, workspace-local. Absent means "the window ending yesterday" for each length. */
    windowStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
    windowDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
    rebuild: z.boolean().optional(),
  })
  .strict();

export interface AttributionRollupSummary {
  readonly status: "rolled_up" | "project_gone";
  readonly windows: number;
  readonly rows: number;
  readonly alertsRaised: number;
}

export function createAttributionRollupHandler(_context: QueueHandlerContext): JobProcessor<AttributionRollupSummary> {
  const logger = new Logger("attribution.rollup");

  return async (tx: ClientBase, job: Job): Promise<AttributionRollupSummary> => {
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
    const started = Date.now();
    return tracer.startActiveSpan("attribution.rollup", async (span) => {
      let status: AttributionRollupSummary["status"] | "failed" = "failed";
      try {
        const timezone = await projectTimezone(tx, payload.projectId);
        if (timezone === undefined) {
          status = "project_gone";
          logger.log({ event: "attribution.rollup.project_gone", workspace_id: payload.workspaceId });
          return { status: "project_gone" as const, windows: 0, rows: 0, alertsRaised: 0 };
        }
        const summary = await withProjectQueueLock(tx, "attribution.rollup", payload.projectId, async () => {
          if (payload.rebuild === true) await purgeProjectRollups(tx, payload.projectId);
          const today = await localToday(tx, timezone);
          // STORY-114 AC6 / decision 107(c) - the lag is measured at the START of the run: now minus the OLDEST ingest time (beacon session
          // or owned-page citation) among rows not yet included in a committed rollup of this project, the marker being
          // projects.attribution_rolled_up_at. Nothing pending is no figure (a quiet site is not late); the gauge of seconds since the last
          // committed rollup is what shows a stalled rollup.
          const startedAtMs = Date.now();
          const pending = await tx.query<{ oldest_pending: Date | null; last_committed: Date | null }>(
            `SELECT least(
                      (SELECT min(d.ingested_at) FROM attribution_daily d WHERE d.workspace_id = app.current_workspace() AND d.project_id = p.id AND (p.attribution_rolled_up_at IS NULL OR d.ingested_at > p.attribution_rolled_up_at)),
                      (SELECT min(c.captured_at) FROM citation_facts c WHERE c.workspace_id = app.current_workspace() AND c.project_id = p.id AND c.is_owned AND (p.attribution_rolled_up_at IS NULL OR c.captured_at > p.attribution_rolled_up_at))
                    ) AS oldest_pending, /* oldest pending ingest */
                    p.attribution_rolled_up_at AS last_committed
               FROM projects p
              WHERE p.workspace_id = app.current_workspace() AND p.id = $1`,
            [payload.projectId],
          );
          const oldestPending = pending.rows[0]?.oldest_pending ?? null;
          const lastCommitted = pending.rows[0]?.last_committed ?? null;
          const pendingMs = oldestPending === null ? null : new Date(oldestPending).getTime();
          if (lastCommitted !== null) observeValue("nominara_rollup_attribution_seconds_since_last_commit", Math.max(0, startedAtMs - new Date(lastCommitted).getTime()) / 1000);
          let windows = 0;
          let rows = 0;
          let alertsRaised = 0;
          for (const windowDays of payload.windowDays === undefined ? ATTRIBUTION_WINDOW_DAYS : [payload.windowDays]) {
            const windowStart = payload.windowStart ?? addDays(today, -windowDays);
            // The predecessor first, so the current window's alert finds it.
            await rollUpWindow(tx, { projectId: payload.projectId, windowStart: addDays(windowStart, -windowDays), windowDays }, timezone);
            const joined = await rollUpWindow(tx, { projectId: payload.projectId, windowStart, windowDays }, timezone);
            const alerts = await raiseSubstitutionAlerts(tx, { workspaceId: payload.workspaceId, projectId: payload.projectId, windowStart, windowDays });
            windows += 1;
            rows += joined.length;
            alertsRaised += alerts.raised;
          }
          // The marker moves in this transaction, so it is advanced exactly when the rollup rows commit. `now()` is the transaction's start:
          // a row ingested while the run was computing stays pending until the next one, never wrongly counted as included.
          await tx.query("UPDATE projects SET attribution_rolled_up_at = now() WHERE workspace_id = app.current_workspace() AND id = $1", [payload.projectId]);
          // After COMMIT, so the observation is only made for a rollup that is visible. The objective is a bound on this value (2 hours).
          if (currentTenantStore() !== undefined) {
            afterCommit(() => {
              const measured = attributionLagSeconds(pendingMs, startedAtMs);
              if (measured === null) return;
              observeValue("nominara_rollup_attribution_lag_seconds", measured.lagSeconds);
              incrementCounter("nominara_rollup_attribution_lag_observations_total", { within_objective: String(measured.withinObjective) });
              if (!measured.withinObjective) logger.warn({ event: "attribution.rollup.lag_over_objective", workspace_id: payload.workspaceId, project_id: payload.projectId, lag_seconds: measured.lagSeconds, objective_seconds: ATTRIBUTION_LAG_OBJECTIVE_SECONDS });
            });
          }
          return { status: "rolled_up" as const, windows, rows, alertsRaised };
        });
        status = "rolled_up";
        span.setAttribute("attribution.windows", summary.windows);
        span.setAttribute("attribution.rows", summary.rows);
        span.setAttribute("attribution.rebuild", payload.rebuild === true);
        // Workspace and project IDs and counts only: never a URL, a figure per page or a workspace name.
        logger.log({ event: "attribution.rollup.done", workspace_id: payload.workspaceId, project_id: payload.projectId, windows: summary.windows, rows: summary.rows, alerts_raised: summary.alertsRaised, rebuild: payload.rebuild === true, normalisation_version: URL_NORMALISATION_VERSION });
        return summary;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.setAttribute("attribution.outcome", status);
        span.end();
        incrementCounter("nominara_attribution_rollup_runs_total", { status, rebuild: String(payload.rebuild === true) });
        observeValue("nominara_attribution_rollup_duration_ms", Date.now() - started, { status });
      }
    });
  };
}
