import type { ClientBase } from "pg";
import { CONFIDENCE_THRESHOLDS, SCORING_VERSION, visibilityDelta } from "../scoring/index.js";
import { CROSS_ENGINE_KEY } from "./roll-up-day.js";

// STORY-042 AC9 — the dashboard block, written onto the project row.
//
// "Denormalisation is what buys the workspace matrix its performance budget.
// Fifty projects each requiring a rollup query would blow the budget many
// times over; a single indexed scan over the project table meets it."

/** §3 — `visibility_delta_30d` compares the last 30 days with the prior 30. */
const WINDOW_DAYS = 30;

/**
 * Recompute a project's denormalised block from `metric_daily`.
 *
 * EVERY FIELD CAN BE NULL, and the columns are nullable for it. A project
 * with no rolled-up day has no blended score — not a zero, which on a 0–100
 * scale is a real and terrible result rather than an absence.
 */
export async function denormalizeProject(tx: ClientBase, projectId: string, timezone: string): Promise<void> {
  const brandRows = await tx.query<{
    metric_date: string;
    visibility_score: string;
    rendering_quality: string | null;
    cells_total: string;
  }>(
    `SELECT to_char(md.metric_date, 'YYYY-MM-DD') AS metric_date,
            md.visibility_score::text, md.rendering_quality::text, md.cells_total::text
       FROM metric_daily md
      WHERE md.project_id = $1
        AND md.engine_key = $2
        AND md.entity_type = 'brand'
        AND md.scoring_version = $3
        AND md.metric_date > ((now() AT TIME ZONE $4)::date - ($5 * 2)::int)
      ORDER BY md.metric_date`,
    [projectId, CROSS_ENGINE_KEY, SCORING_VERSION, timezone, WINDOW_DAYS],
  );

  if (brandRows.rows.length === 0) return;

  const today = await tx.query<{ today: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`, [
    timezone,
  ]);
  const boundary = shiftDate(today.rows[0]!.today, -WINDOW_DAYS);

  const current = brandRows.rows.filter((row) => row.metric_date > boundary);
  const prior = brandRows.rows.filter((row) => row.metric_date <= boundary);

  const latest = brandRows.rows[brandRows.rows.length - 1]!;

  // §3's delta rules, from the scoring library: NULL, not 0, when either
  // window is under-sampled. `n` is the number of CELLS, not of days — a
  // 30-day window of one cell a day is not a 30-cell sample by accident.
  const delta = visibilityDelta(
    { score: meanOf(current.map((row) => Number(row.visibility_score))), measuredCells: cellsIn(current) },
    { score: meanOf(prior.map((row) => Number(row.visibility_score))), measuredCells: cellsIn(prior) },
  );

  await tx.query(
    `UPDATE projects
        SET visibility_blended = $2,
            visibility_delta_30d = $3,
            rendering_quality = $4,
            sparkline_30d = $5::jsonb
      WHERE id = $1`,
    [
      projectId,
      Number(latest.visibility_score),
      delta,
      latest.rendering_quality === null ? null : Number(latest.rendering_quality),
      // The sparkline is the CURRENT window's daily scores in date order —
      // what the matrix card draws. Stored as an array rather than an object
      // so the client renders it without a second decision about ordering.
      JSON.stringify(current.map((row) => Number(Number(row.visibility_score).toFixed(3)))),
    ],
  );

  // `aux_score_current` and `open_task_count` are DELIBERATELY NOT WRITTEN
  // here. AC9 lists them, and neither has a producer: the AUX audit is
  // EPIC-07's and tasks are EPIC-09's. Writing 0 into either would put a
  // confident number on the matrix for a subsystem that has never run —
  // "audit score 0" reads as a failed audit, not as no audit. They stay NULL
  // until the epic that computes them lands, and the columns already allow
  // it.
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function cellsIn(rows: readonly { cells_total: string }[]): number {
  return rows.reduce((total, row) => total + Number(row.cells_total), 0);
}

/**
 * `YYYY-MM-DD` arithmetic in UTC — the string is already a workspace-local
 * calendar date, so this shifts a CALENDAR day and never a duration.
 *
 * Built from `Date.UTC` rather than by interpolating the date into an ISO
 * timestamp string. ISO-13's scanner reads a colon-joined interpolated
 * template as a cache-key construction site and fails the build on it — and
 * it is right to, because that is exactly what an un-namespaced key looks
 * like. It scans raw source, so the literal cannot appear in this comment
 * either. Parsing the parts is also stricter: a malformed date produces NaN
 * here rather than an Invalid Date that stringifies to "Invalid Date".
 */
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export { WINDOW_DAYS as DENORMALIZE_WINDOW_DAYS, CONFIDENCE_THRESHOLDS };
