import type { ClientBase } from "pg";
import { capturedInRunStatusSql, nonMeasurementStatusSql } from "../rollup/aggregate-day.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import type { RunStatus } from "../../../contracts/tracking/index.js";

// STORY-034 AC3 — "Progress projection returns planned, live, skipped, and
// failed counts with a completion percentage and an estimate to finish."
//
// A PROJECTION, NOT A SECOND SET OF COUNTERS. `capture_runs` already carries
// `planned_cells` and `skipped_cells`, written once by the planner; the
// captured and failed counts are derived from `answer_captures` rather than
// incremented on the run row. Two writers to one counter is how a progress
// bar ends up reporting 47 of 45.

export interface RunProgress {
  readonly runId: string;
  readonly projectId: string;
  readonly trigger: "scheduled" | "manual" | "verification" | "drift_sample" | "conversion_backfill";
  readonly status: RunStatus;
  readonly engineKeys: readonly string[];
  readonly planned: number;
  readonly captured: number;
  readonly skipped: number;
  readonly failed: number;
  readonly pct: number;
  readonly etaMs: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly cachedByLayer: { readonly l1: number; readonly l2: number };
}

interface RunRow {
  id: string;
  project_id: string;
  trigger: RunProgress["trigger"];
  status: RunStatus;
  engine_keys: string[];
  planned_cells: number;
  skipped_cells: number;
  failed_cells: number;
  started_at: Date | null;
  finished_at: Date | null;
  captured: string;
  failed: string;
  l1: string;
  l2: string;
}

/**
 * `eta_ms` from the rate cells have ACTUALLY been completing at.
 *
 * NULL BEFORE THE FIRST ONE FINISHES, which §11 requires — "an estimate is
 * not always computable, and zero is a real estimate rather than a missing
 * one". The alternative, seeding from an average cell duration, produces a
 * confident number for a run that may be about to sit in a queue behind a
 * degraded engine; a client rendering "about 4 minutes" from that has been
 * told something nobody measured.
 *
 * Null once nothing is outstanding, too: a finished run's estimate to finish
 * is not zero, it is absent.
 */
export function etaMsFrom(startedAt: Date | null, done: number, outstanding: number, nowMs: number): number | null {
  if (startedAt === null || done <= 0 || outstanding <= 0) return null;
  const elapsed = nowMs - startedAt.getTime();
  if (elapsed <= 0) return null;
  return Math.round((elapsed / done) * outstanding);
}

/** 0–100. A run with nothing planned is 100: there is nothing left to do. */
export function pctFrom(planned: number, done: number): number {
  if (planned <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((done / planned) * 100)));
}

/**
 * One round trip.
 *
 * The counts are a lateral aggregate over `answer_captures` rather than four
 * separate queries: a progress endpoint is polled, and four round trips per
 * poll multiplied by every open dashboard is a load profile nobody chose.
 *
 * NO `workspace_id` PREDICATE. RLS scopes the tenant (`NFR-SEC-01`); a
 * predicate here would imply that boundary lives in application code.
 */
export async function readRunProgress(tx: ClientBase, runId: string, now: Date = new Date()): Promise<RunProgress> {
  const result = await tx.query<RunRow>(
    `SELECT r.id, r.project_id, r.trigger, r.status, r.engine_keys,
            r.planned_cells, r.skipped_cells, r.failed_cells, r.started_at, r.finished_at,
            c.captured, c.failed, c.l1, c.l2
       FROM capture_runs r
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE ${capturedInRunStatusSql("status")})          AS captured,
                count(*) FILTER (WHERE ${nonMeasurementStatusSql("status")})           AS failed,
                count(*) FILTER (WHERE cache_layer = 'l1')                       AS l1,
                count(*) FILTER (WHERE cache_layer = 'l2')                       AS l2
           FROM answer_captures
          WHERE run_id = r.id
       ) c ON true
      WHERE r.id = $1`,
    [runId],
  );

  const row = result.rows[0];
  if (row === undefined) throw new NotFoundError({ message: "no such run" });

  const captured = Number(row.captured);
  // SCANFIX D4 - `capture_runs.failed_cells` is the count of cells that FAILED WITHOUT LEAVING AN
  // `answer_captures` ROW: a job that died in the dead-letter queue before the terminal-record fix, and
  // that only the stuck-run reaper can account for. A cell that wrote a failed row is in `row.failed`;
  // the reaper counts only the shortfall, so the two never overlap. Nothing else writes the column.
  const failed = Number(row.failed) + row.failed_cells;
  const skipped = row.skipped_cells;
  // A SUPPRESSED CELL IS DONE. `recordSuppressedCells` writes it `status =
  // 'skipped'`, so it is excluded from `captured` above and will never be
  // enqueued — leaving it out of `done` would strand a fully cache-served run
  // below 100% forever.
  //
  // Counted from the RUN ROW rather than from the partitioned table: the
  // planner wrote that number once, and reading it back costs nothing.
  const done = Math.min(row.planned_cells, captured + failed + skipped);
  const outstanding = Math.max(0, row.planned_cells - done);

  return {
    runId: row.id,
    projectId: row.project_id,
    trigger: row.trigger,
    status: row.status,
    engineKeys: row.engine_keys,
    planned: row.planned_cells,
    captured,
    skipped,
    failed,
    pct: pctFrom(row.planned_cells, done),
    etaMs: etaMsFrom(row.started_at, done, outstanding, now.getTime()),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    cachedByLayer: { l1: Number(row.l1), l2: Number(row.l2) },
  };
}
