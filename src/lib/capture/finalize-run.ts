import type { ClientBase } from "pg";
import { settleFinishedRunCredits } from "../credits/run-settlement.js";
import { resolveRunOutcome } from "../engines/run-outcome.js";
import type { RunProgress } from "./run-progress.js";

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

  const finalised = await tx.query<{ finished_at: Date }>(
    `UPDATE capture_runs SET status = $2, finished_at = now()
      WHERE id = $1 AND status IN ('queued','running')
      RETURNING finished_at`,
    [progress.runId, status],
  );
  const row = finalised.rows[0];
  if (row === undefined) return null;

  const settlement = await settleFinishedRunCredits(tx, {
    workspaceId,
    runId: progress.runId,
    deliveredCells: progress.captured + progress.skipped,
  });
  return { status, finishedAt: row.finished_at, refunded: settlement.refunded };
}
