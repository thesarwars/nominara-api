import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { resolveBillingPeriod } from "../usage/billing-period.js";
import { releaseFairUseCapacity } from "./fair-use.js";

// NEW-A-13 checkpoint-4 (second-engineer finding 4) — the reaper for scheduled
// runs LOST between the planning COMMIT and the fire-and-forget dispatch.
//
// capture.plan advances `next_run_at`, commits the run row and reserves
// fair-use, and only THEN hands the cells to the queue, after commit. If the
// process dies in that window (a deploy's SIGTERM, an OOM) the run stays
// `queued` for ever, the project is not replanned (its schedule moved), and the
// cycle's reservation stays consumed. The handler's own compensation covers a
// REJECTED dispatch, not a lost process.
//
// So: a `scheduled` run still `queued` past STALE_QUEUED_RUN_BOUND_MS is failed
// (`{"reason":"stale_queued"}`) and its reservation, planned_cells -
// skipped_cells — the same figure planRun reserved — is given back, inside the
// run's own tenant context. Cells that did reach the queue after all are
// skipped by capture.execute once the run is `failed`.
//
// ONLY `scheduled` runs. A manual run debits credits as well, and failing it
// without the refund path would be a second, silent money bug; it is not this
// reaper's to decide.
//
// THE BOUND. The longest per-cell jitter is one hour (CADENCE_JITTER_MAX_MS), so
// a healthy run's first cell is delivered well inside that; six hours leaves
// room for a queue backlog without leaving a lost run for a day. The period is
// resolved at reap time, so a run lost across a billing-period roll releases
// against the wrong (or no) counter row — released at most to zero, never
// negative — an edge accepted for a six-hour window.
//
// RUNS ON THE SWEEP'S OWNER CONNECTION (it must see across tenants to find
// them), but every write is inside a per-run withTenantContext so RLS is the
// guarantee for the release. The `status = 'queued'` predicate makes it
// idempotent and keeps it from racing a cell that started in the meantime.

const logger = new Logger("capture.reaper");

/** How long a scheduled run may sit `queued` before it is presumed lost. */
export const STALE_QUEUED_RUN_BOUND_MS = 6 * 60 * 60 * 1000;

export interface ReapResult {
  readonly reaped: number;
}

export async function reapStaleQueuedRuns(
  client: ClientBase,
  now: Date,
  boundMs: number = STALE_QUEUED_RUN_BOUND_MS,
): Promise<ReapResult> {
  const cutoff = new Date(now.getTime() - boundMs);
  // IDs and counts only: no tenant content is read.
  const stale = await client.query<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id
       FROM capture_runs
      WHERE status = 'queued' AND trigger = 'scheduled' AND created_at < $1
      ORDER BY created_at ASC
      LIMIT 500`,
    [cutoff],
  );

  let reaped = 0;
  for (const row of stale.rows) {
    try {
      const done = await withTenantContext(client, { workspaceId: row.workspace_id, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const failed = await tx.query<{ planned_cells: number; skipped_cells: number }>(
          `UPDATE capture_runs
              SET status = 'failed', finished_at = now(),
                  error_summary = '{"reason":"stale_queued"}'::jsonb
            WHERE id = $1 AND status = 'queued' AND trigger = 'scheduled'
        RETURNING planned_cells, skipped_cells`,
          [row.id],
        );
        const updated = failed.rows[0];
        if (updated === undefined) return false;
        const { start } = await resolveBillingPeriod(tx, row.workspace_id, now);
        await releaseFairUseCapacity(tx, row.workspace_id, start, updated.planned_cells - updated.skipped_cells);
        return true;
      });
      if (!done) continue;
      reaped += 1;
      incrementCounter("nominara_capture_stale_runs_reaped_total");
      logger.log({ event: "capture.run.reaped_stale", workspace_id: row.workspace_id, run_id: row.id });
    } catch (error) {
      // One run's failure must not stop the others, nor the sweep that called us.
      logger.error({
        event: "capture.run.reap_failed",
        workspace_id: row.workspace_id,
        run_id: row.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return { reaped };
}
