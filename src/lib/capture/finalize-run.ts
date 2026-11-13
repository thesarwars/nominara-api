import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { settleFinishedRunCredits } from "../credits/run-settlement.js";
import { resolveRunOutcome } from "../engines/run-outcome.js";
import { writeNotification } from "../notifications/writer.js";
import { incrementCounter } from "../telemetry/metrics.js";
import type { RunProgress } from "./run-progress.js";

const logger = new Logger("capture.finalize");

// SCANFIX - the ONE place a run is moved to its terminal status, shared by the last
// live cell (capture.execute) and the stuck-run reaper. It used to be inline in the
// handler, which is why nothing else could finish a run and a lost cell left it
// running for ever.

export type FinalRunStatus = "completed" | "partial" | "failed";

export interface FinalizedRun {
  readonly status: FinalRunStatus;
  readonly finishedAt: Date;
  /** Credits handed back by the settlement (0 for a partial run, a scheduled run, or a repeat). */
  readonly refunded: number;
}

/**
 * Decide the outcome from `progress`, write it, and settle the money - in the caller's tenant
 * transaction, so the status and the refund commit or roll back together.
 *
 * `resolveRunOutcome` (STORY-031, unchanged): zero successes is `failed`; anything short of every cell
 * succeeding is `partial`, never `failed` - "a run never fails MERELY because one engine is down". A
 * suppressed cell counts as a success: it produced an answer.
 *
 * Returns null when the run was already terminal (`AND status IN ('queued','running')`), so two cells
 * finishing together cannot both finalise, emit twice, or refund twice.
 */
export async function finalizeRun(tx: ClientBase, workspaceId: string, progress: RunProgress): Promise<FinalizedRun | null> {
  const outcome = resolveRunOutcome({
    successCount: progress.captured + progress.skipped,
    totalCount: progress.planned,
    hasDegradedEngine: progress.failed > 0,
  });
  const status: FinalRunStatus = outcome === "success" ? "completed" : outcome;

  const finalised = await tx.query<{ finished_at: Date; triggered_by: string | null }>(
    `UPDATE capture_runs SET status = $2, finished_at = now()
      WHERE id = $1 AND status IN ('queued','running')
      RETURNING finished_at, triggered_by`,
    [progress.runId, status],
  );
  const row = finalised.rows[0];
  if (row === undefined) return null;

  const settlement = await settleFinishedRunCredits(tx, {
    workspaceId,
    runId: progress.runId,
    deliveredCells: progress.captured + progress.skipped,
  });
  await notifyManualRunFinished(tx, workspaceId, progress, status, row.triggered_by, settlement.refunded);
  return { status, finishedAt: row.finished_at, refunded: settlement.refunded };
}

/**
 * STORY-089 (FR-CMD-06) - "a long-running command ... appears in the notification centre on completion". The command bar's long-running command is a manual deep scan, so a
 * finished MANUAL run writes one in-app notification for the member who started it. Written here, in the transaction that finalised the run, so the notification and the
 * status commit together and the run's single finalisation is the single producer (the event key is a second guard). A scheduled run was nobody's command, and a manual
 * run with no member behind it (`triggered_by` null) has no one to tell: both write nothing. PROVISIONAL: the story names no notification kind, copy or severity; this is the
 * most conservative reading (in-app only, never an email, warning only when nothing was captured).
 */
async function notifyManualRunFinished(tx: ClientBase, workspaceId: string, progress: RunProgress, status: FinalRunStatus, triggeredBy: string | null, refunded: number): Promise<void> {
  if (progress.trigger !== "manual" || triggeredBy === null) return;
  const title = status === "completed" ? "Your scan is ready" : status === "partial" ? "Your scan finished with gaps" : "Your scan captured nothing";
  const body =
    status === "completed"
      ? `${String(progress.captured)} answers captured live, ${String(progress.skipped)} already fresh.`
      : status === "partial"
        ? `${String(progress.captured)} answers captured live, ${String(progress.skipped)} already fresh, ${String(progress.failed)} could not be captured.`
        : refunded > 0
          ? "No engine returned an answer. The credits were refunded in full."
          : "No engine returned an answer.";
  // A NOTIFICATION IS NEVER ALLOWED TO UNDO THE RUN. The status and the settlement above commit with this transaction, so a failure here (the insert, or the deep-link parse)
  // must not abort it: the write runs inside a SAVEPOINT, and on any error only the savepoint is rolled back. The failure is logged (ids only) and counted, never swallowed silently.
  await tx.query("SAVEPOINT run_completed_notify");
  try {
    await writeNotification(tx, {
      workspaceId,
      projectId: progress.projectId,
      userId: triggeredBy,
      kind: "run.completed",
      severity: status === "failed" ? "warning" : "info",
      title,
      body,
      eventKey: `run.completed:${progress.runId}`,
      deepLink: { path: `/p/${progress.projectId}/overview`, query: { run: progress.runId } },
      facts: { run_id: progress.runId, status, captured: progress.captured, skipped: progress.skipped, failed: progress.failed },
    });
    await tx.query("RELEASE SAVEPOINT run_completed_notify");
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT run_completed_notify");
    incrementCounter("nominara_capture_run_notify_failures_total", { trigger: "manual" });
    logger.warn({ event: "run.completed.notify_failed", workspace_id: workspaceId, run_id: progress.runId, project_id: progress.projectId, error_name: error instanceof Error ? error.name : "unknown" });
  }
}
