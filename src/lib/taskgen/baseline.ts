import type { ClientBase } from "pg";
import { taskBaselineMetricsSchema, type TaskBaselineMetrics } from "../../../contracts/tasks/index.js";

/** The window the baseline averages over. */
export const BASELINE_WINDOW_DAYS = 7;

/**
 * STORY-063 AC9 — the metrics a task is measured against, captured AT CREATION: the brand's trailing window ending on the
 * evaluated day, for the task's engine (or the cross-engine `all` row). `captured_at` is the transaction's own `now()` —
 * the same instant `tasks.created_at` takes — so the before provably predates the work.
 *
 * A metric with no data is `null`, never `0`: zero share of voice and "not measured" must stay distinguishable for the
 * verification run that reads this back.
 */
export async function captureBaseline(
  tx: ClientBase,
  projectId: string,
  metricDate: string,
  engineKey: string,
  scoringVersion: string,
): Promise<TaskBaselineMetrics> {
  const result = await tx.query<{
    captured_at: Date;
    rows: string;
    cells: string | null;
    present: string | null;
    sov_w: number | null;
    vis_w: number | null;
    owned: string | null;
  }>(
    `SELECT now() AS captured_at,
            count(*)::text AS rows,
            sum(cells_total)::text AS cells,
            sum(cells_present)::text AS present,
            sum(sov * cells_total)::float8 AS sov_w,
            sum(visibility_score * cells_total)::float8 AS vis_w,
            sum(citations_owned)::text AS owned
       FROM metric_daily
      WHERE project_id = $1::uuid AND entity_type = 'brand' AND engine_key = $2 AND scoring_version = $3
        AND metric_date >  $4::date - $5::int
        AND metric_date <= $4::date`,
    [projectId, engineKey, scoringVersion, metricDate, BASELINE_WINDOW_DAYS],
  );
  const row = result.rows[0]!;
  const cells = row.cells === null ? 0 : Number(row.cells);
  const measured = cells > 0;
  return taskBaselineMetricsSchema.parse({
    captured_at: row.captured_at.toISOString(),
    metric_date: metricDate,
    window_days: BASELINE_WINDOW_DAYS,
    engine_key: engineKey,
    cells_total: cells,
    sov: measured && row.sov_w !== null ? row.sov_w / cells : null,
    presence_rate: measured && row.present !== null ? Number(row.present) / cells : null,
    visibility_score: measured && row.vis_w !== null ? row.vis_w / cells : null,
    owned_citation_count: Number(row.rows) > 0 && row.owned !== null ? Number(row.owned) : null,
  });
}
