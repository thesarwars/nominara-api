import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { requestRollupIfRunComplete, type EnqueueRollup } from "../queue/handlers/run-rollup-request.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { finalizeRun } from "./finalize-run.js";
import { readRunProgress } from "./run-progress.js";
import { STALE_QUEUED_RUN_BOUND_MS } from "./stale-run-reaper.js";

// SCANFIX D4 - the reaper for runs that STARTED and never finished.
//
// The 2026-10-12 incident: cells exhausted their retries into the dead-letter queue
// without a terminal record, so `captured + failed + skipped` never reached
// `planned` and the runs sat at running/queued for ever - rollup never requested, no
// scores shown, the up-front charge never settled. The live path is fixed (the final
// attempt now records a failed cell), but runs already in that state, and any future
// run whose cell is lost some other way (a job removed from the queue, a worker
// killed at the wrong moment), still need an owner. This is it.
//
// WHAT IT DOES, per stuck run, inside the run's OWN tenant context (RLS is the
// guarantee for every write; the sweep's owner connection only finds them):
//   1. locks the run row and re-checks it is still unfinished and still idle;
//   2. counts the cells that never produced a row (planned - captured - failed -
//      skipped) into `capture_runs.failed_cells` - the column that exists for exactly
//      that, and that `readRunProgress` adds to `failed`;
//   3. finalises through the SAME `finalizeRun` the last live cell uses, so the
//      outcome (partial / failed) and the money (nothing captured => refunded in
//      full; partial => charged in full) follow one rule;
//   4. requests the rollup, so the cells that DID capture become scores.
//
// STUCK MEANS IDLE, NOT OLD. A big paced run legitimately takes hours, so age alone
// would reap a healthy one. The test is "no activity for the grace window": the
// newest of the run's creation, its start, and its latest capture row. The window
// defaults to the stale-queued bound (6 h) - far longer than the paced time-to-first-
// cell of any backlog the capture queue should hold.
//
// NOT SCHEDULED `queued` RUNS: those are `reapStaleQueuedRuns`'s, with different
// semantics (the run was lost BEFORE dispatch, so the fair-use reservation is
// released and nothing was ever debited). A scheduled run that is `running` is ours.
//
// IDEMPOTENT: the `status IN ('queued','running')` predicate inside `finalizeRun`
// and the ledger's idempotency keys mean a second pass changes nothing.
//
// A CELL STILL IN FLIGHT HOLDS THE REAPER OFF (SCANFIX D5): the handler takes
// `FOR KEY SHARE` on the run at the start of its transaction, which conflicts with the
// `FOR UPDATE` below, so the reaper never counts a cell mid-vendor-call as lost, never
// refunds a run that is about to deliver an answer, and a cell arriving after the reaper
// finalised the run waits for it and then skips (every terminal status skips). This
// replaces the old "KNOWN, ACCEPTED" count drift - and the money half of it, which the old
// note did not mention: a run refunded in full and then handed a captured answer.

const logger = new Logger("capture.reaper");

/** How long a run may show no activity before it is presumed stuck. */
export const STUCK_RUN_GRACE_MS = STALE_QUEUED_RUN_BOUND_MS;

const BATCH_LIMIT = 200;

export interface StuckRunResult {
  readonly finalized: number;
}

export interface StuckRunOptions {
  readonly enqueueRollup: EnqueueRollup;
  readonly graceMs?: number;
}

/** The newest sign of life on a run. */
const LAST_ACTIVITY_SQL = `GREATEST(
  r.created_at,
  COALESCE(r.started_at, r.created_at),
  COALESCE((SELECT max(a.captured_at) FROM answer_captures a WHERE a.run_id = r.id), r.created_at)
)`;

export async function reapStuckRuns(client: ClientBase, now: Date, options: StuckRunOptions): Promise<StuckRunResult> {
  const cutoff = new Date(now.getTime() - (options.graceMs ?? STUCK_RUN_GRACE_MS));
  // IDs only: no tenant content is read.
  const stuck = await client.query<{ id: string; workspace_id: string }>(
    `SELECT r.id, r.workspace_id
       FROM capture_runs r
      WHERE r.status IN ('queued','running')
        AND NOT (r.status = 'queued' AND r.trigger = 'scheduled')
        AND ${LAST_ACTIVITY_SQL} < $1
      ORDER BY r.created_at ASC
      LIMIT ${String(BATCH_LIMIT)}`,
    [cutoff],
  );

  let finalized = 0;
  for (const row of stuck.rows) {
    try {
      const status = await reapStuckRun(client, row, now, cutoff, options);
      if (status === null) continue;
      finalized += 1;
      incrementCounter("nominara_capture_stuck_runs_finalized_total", { status });
    } catch (error) {
      // One run's failure must not stop the others, nor the sweep that called us.
      incrementCounter("nominara_capture_stuck_run_reap_failed_total");
      logger.error({
        event: "capture.run.reap_stuck_failed",
        workspace_id: row.workspace_id,
        run_id: row.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return { finalized };
}

/**
 * ONE stuck run, in its own tenant transaction (`row.workspace_id` is the context). Exported so a test can
 * run it as the RUNTIME role with a deliberately wrong workspace and prove RLS - not the code - refuses it.
 * Returns the status the run was finalised to, or null when it was left alone.
 */
export async function reapStuckRun(
  client: ClientBase,
  row: { readonly id: string; readonly workspace_id: string },
  now: Date,
  cutoff: Date,
  options: StuckRunOptions,
): Promise<string | null> {
  return withTenantContext(client, { workspaceId: row.workspace_id, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    // LOCK, THEN RE-CHECK IN A SECOND STATEMENT. The lock waits for any cell still in flight (the handler
    // holds `FOR KEY SHARE` on the run for its whole transaction - SCANFIX D5). Under READ COMMITTED a
    // statement that waited re-evaluates only the locked row, with its ORIGINAL snapshot for sub-selects, so
    // a capture committed while we waited would be invisible to an idle test folded into this query. The
    // next statement takes a fresh snapshot and sees it.
    const locked = await tx.query<{ project_id: string }>(
      "SELECT r.project_id FROM capture_runs r WHERE r.id = $1 AND r.status IN ('queued','running') FOR UPDATE OF r",
      [row.id],
    );
    const projectId = locked.rows[0]?.project_id;
    if (projectId === undefined) return null;
    const idle = await tx.query(`SELECT 1 FROM capture_runs r WHERE r.id = $1 AND ${LAST_ACTIVITY_SQL} < $2`, [row.id, cutoff]);
    if (idle.rowCount === 0) return null;

    const before = await readRunProgress(tx, row.id, now);
    const lost = Math.max(0, before.planned - (before.captured + before.failed + before.skipped));
    if (lost > 0) {
      await tx.query("UPDATE capture_runs SET failed_cells = failed_cells + $2 WHERE id = $1", [row.id, lost]);
    }
    const progress = await readRunProgress(tx, row.id, now);
    const finalised = await finalizeRun(tx, row.workspace_id, progress);
    if (finalised === null) return null;

    // The day the captures belong to, not the day the reaper ran.
    const lastCapture = await tx.query<{ at: Date | null }>("SELECT max(captured_at) AS at FROM answer_captures WHERE run_id = $1", [row.id]);
    await requestRollupIfRunComplete(
      tx,
      { runId: row.id, projectId, workspaceId: row.workspace_id, capturedAt: lastCapture.rows[0]?.at ?? now },
      options.enqueueRollup,
      logger,
    );
    logger.log({
      event: "capture.run.reaped_stuck",
      workspace_id: row.workspace_id,
      run_id: row.id,
      status: finalised.status,
      planned: progress.planned,
      captured: progress.captured,
      lost_cells: lost,
      refunded_credits: finalised.refunded,
    });
    return finalised.status;
  });
}
