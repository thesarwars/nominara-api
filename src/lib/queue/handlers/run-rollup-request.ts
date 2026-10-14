import type { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { readRunProgress } from "../../capture/run-progress.js";
import { capturedInRunStatusSql, hasFactsStatusSql, reusedStatusSql } from "../../rollup/aggregate-day.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { afterCommit } from "../../../tenancy/tenant-context.js";

// NEW-A-7 — the one place a run asks for its day's `rollup.metric_daily`.
//
// Called by BOTH capture.parse (the last cell to be parsed) and capture.execute
// (the last cell to settle was a terminal failure, so no parse follows it).
// Whichever settles the run last is the one that finds it complete.

export type EnqueueRollup = (
  queue: "rollup.metric_daily",
  workspaceId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
) => Promise<unknown>;

export interface RunRollupTarget {
  readonly runId: string | null;
  readonly projectId: string;
  readonly workspaceId: string;
  /** Picks the workspace-local day the rollup is for. */
  readonly capturedAt: Date;
}

/**
 * When the run has every cell accounted for and none still waiting to be
 * parsed, the day's facts are complete: ask for the rollup now rather than at
 * the next tick (there is no bare-cron fallback — `rollup.metric_daily` is
 * tenant-scoped).
 *
 * THE RUN ROW IS LOCKED FIRST. "Is the run complete" is a read-then-decide, and
 * under READ COMMITTED two cells finishing at once each see the OTHER still
 * unsettled and both skip — the run is never rolled up. `FOR NO KEY UPDATE` serialises
 * the completers (it conflicts with itself); the second one's next statement then sees the first's commit.
 *
 * NOT `FOR UPDATE` (SCANFIX D5): `capture.execute` holds `FOR KEY SHARE` on the run for its whole
 * transaction so the stuck-run reaper waits for a cell in flight. `FOR UPDATE` conflicts with KEY SHARE, so
 * two cells that each held it and each then asked for `FOR UPDATE` waited on one another: a deadlock.
 * `FOR NO KEY UPDATE` does not conflict with KEY SHARE, serialises completers just the same, and the
 * reaper's `FOR UPDATE` still conflicts with it.
 *
 * AFTER COMMIT: the rollup job runs on another connection and must see this
 * transaction's facts. One key per run, so a replay or a force re-parse does not
 * queue a second pass. A failed enqueue is logged, never thrown: the work is
 * stored, and a replay of this job re-requests under the same key.
 */
export async function requestRollupIfRunComplete(
  tx: ClientBase,
  target: RunRollupTarget,
  enqueueRollup: EnqueueRollup,
  logger: Logger,
): Promise<void> {
  const { runId, projectId, workspaceId } = target;
  if (runId === null) return;
  const run = await tx.query("SELECT 1 FROM capture_runs WHERE id = $1 FOR NO KEY UPDATE", [runId]);
  if (run.rowCount === 0) return;

  const progress = await readRunProgress(tx, runId);
  if (progress.captured + progress.failed + progress.skipped < progress.planned) return;
  // STORY-032 AC7 — a reused (L1/L2) row is a cell still waiting for its facts until it has been re-matched
  // (`brand_present` is NULL until then), unless the re-match was tried and cannot be done ('rematch_unavailable').
  // Without this the rollup could be requested before the reused cells' facts exist, and its one-per-run key would
  // then swallow the request that follows them.
  const unparsed = await tx.query(
    `SELECT 1 FROM answer_captures
      WHERE run_id = $1
        AND ((${capturedInRunStatusSql("status")} AND NOT ${hasFactsStatusSql("status")})
          OR (${reusedStatusSql("status")} AND cache_layer IN ('l1', 'l2') AND brand_present IS NULL
              AND NOT ('rematch_unavailable' = ANY(flags))))
      LIMIT 1`,
    [runId],
  );
  if ((unparsed.rowCount ?? 0) > 0) return;

  const day = await tx.query<{ metric_date: string }>(
    `SELECT to_char(($2::timestamptz AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS metric_date
       FROM workspaces w WHERE w.id = $1`,
    [workspaceId, target.capturedAt],
  );
  const metricDate = day.rows[0]?.metric_date;
  if (metricDate === undefined) return;

  afterCommit(() => {
    void enqueueRollup(
      "rollup.metric_daily",
      workspaceId,
      { projectId, metricDate, reason: "run_parsed" },
      `rollup:${projectId}:run:${runId}`,
    )
      .then(() => {
        incrementCounter("nominara_rollup_requested_total", { reason: "run_parsed" });
        logger.log({ event: "rollup.requested", workspace_id: workspaceId, project_id: projectId, run_id: runId });
      })
      .catch((error: unknown) => {
        logger.error({
          event: "rollup.request_failed",
          workspace_id: workspaceId,
          project_id: projectId,
          run_id: runId,
          error: error instanceof Error ? error.name : "unknown",
        });
      });
  });
}
