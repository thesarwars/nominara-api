import type { ClientBase } from "pg";
import { CONFIDENCE_THRESHOLDS, SCORING_VERSION, visibilityDelta } from "../scoring/index.js";
import { AGGREGATE_ATTRIBUTE_CAPABLE_ENGINES } from "./aggregate-day.js";
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
    sentiment_score: string | null;
    cells_total: string;
  }>(
    `SELECT to_char(md.metric_date, 'YYYY-MM-DD') AS metric_date,
            md.visibility_score::text, md.rendering_quality::text, md.sentiment_score::text,
            md.cells_total::text
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
  const currentCells = cellsIn(current);

  // §3's delta rules, from the scoring library: NULL, not 0, when either
  // window is under-sampled. `n` is the number of CELLS, not of days — a
  // 30-day window of one cell a day is not a 30-cell sample by accident.
  const visibilityDelta30d = visibilityDelta(
    { score: meanOf(current.map((row) => Number(row.visibility_score))), measuredCells: currentCells },
    { score: meanOf(prior.map((row) => Number(row.visibility_score))), measuredCells: cellsIn(prior) },
  );

  // Sentiment reads the SAME window and the SAME cell counts as visibility —
  // it is a second measure over the same measured cells, not a separate
  // sample — so it goes through the identical threshold rule via the same
  // generic function.
  const sentimentDelta30d = visibilityDelta(
    { score: meanOf(nonNullNumbers(current, "sentiment_score")), measuredCells: currentCells },
    { score: meanOf(nonNullNumbers(prior, "sentiment_score")), measuredCells: cellsIn(prior) },
  );

  // Rendering shares the SAME window/threshold rule as visibility_delta_30d
  // (0028's own `COMMENT ON COLUMN projects.rendering_delta_30d`, and
  // `NFR-ANL-03`, which is not scoped to the visibility score specifically:
  // "No trend delta, arrow, or percentage change is rendered when n < 30").
  //
  // ⚠ REVIEW FIX (STORY-169 re-audit) — the gate MUST be the count of
  // ATTRIBUTE-CAPABLE-ENGINE measured cells, never `currentCells`/
  // `cellsIn(prior)` (the window's OVERALL cell count across every engine,
  // §8 excludes non-attribute-capable engines from RenderingQuality's own
  // population). `rendering_quality` on the "all" cross-engine row is a
  // per-DAY weighted mean over whichever attribute-capable engines mentioned
  // the brand that day — it carries no cell count of its own, so gating on
  // the shared `currentCells` silently substitutes "how many cells this
  // project measured, across every engine" for "how many cells the
  // rendering figure itself rests on". A project with 30 `chatgpt` cells
  // (non-attribute-capable, so `rendering_quality` is null every day) and
  // ONE `google_ai_mode` cell PER WINDOW clears `currentCells >= 30` while
  // the rendering figure still rests on n=1 per window — exactly the
  // "single attribute-capable-engine day" this comment used to say the gate
  // already prevented, which was false the moment another engine supplied
  // the other 29+ cells (STORY-169 re-audit, PROBE B — cells_30d: 31,
  // rendering_delta_30d published from n=1). Read straight from the
  // per-engine rows, restricted to `AGGREGATE_ATTRIBUTE_CAPABLE_ENGINES` —
  // the SAME two engines `aggregate-day.ts`'s own `render_mention_rows`
  // computes rendering from.
  const currentRenderingMean = meanOf(nonNullNumbers(current, "rendering_quality"));
  const priorRenderingMean = meanOf(nonNullNumbers(prior, "rendering_quality"));
  const renderingCellRows = await tx.query<{ metric_date: string; cells_total: string }>(
    `SELECT to_char(md.metric_date, 'YYYY-MM-DD') AS metric_date, md.cells_total::text
       FROM metric_daily md
      WHERE md.project_id = $1
        AND md.engine_key = ANY($2::text[])
        AND md.entity_type = 'brand'
        AND md.scoring_version = $3
        AND md.metric_date > ((now() AT TIME ZONE $4)::date - ($5 * 2)::int)`,
    [projectId, AGGREGATE_ATTRIBUTE_CAPABLE_ENGINES, SCORING_VERSION, timezone, WINDOW_DAYS],
  );
  const renderingCurrentCells = cellsIn(renderingCellRows.rows.filter((row) => row.metric_date > boundary));
  const renderingPriorCells = cellsIn(renderingCellRows.rows.filter((row) => row.metric_date <= boundary));
  const renderingDelta30d = visibilityDelta(
    { score: currentRenderingMean, measuredCells: renderingCurrentCells },
    { score: priorRenderingMean, measuredCells: renderingPriorCells },
  );

  const visibilityByEngine = await perEngineWindow(tx, projectId, timezone, boundary);

  await tx.query(
    `UPDATE projects
        SET visibility_blended = $2,
            visibility_delta_30d = $3,
            rendering_quality = $4,
            sparkline_30d = $5::jsonb,
            rendering_delta_30d = $6,
            sentiment_score = $7,
            sentiment_delta_30d = $8,
            cells_30d = $9,
            visibility_by_engine = $10::jsonb
      WHERE id = $1`,
    [
      projectId,
      Number(latest.visibility_score),
      visibilityDelta30d,
      latest.rendering_quality === null ? null : Number(latest.rendering_quality),
      // The sparkline is the CURRENT window's daily scores in date order —
      // what the matrix card draws. Stored as an array rather than an object
      // so the client renders it without a second decision about ordering.
      JSON.stringify(current.map((row) => Number(Number(row.visibility_score).toFixed(3)))),
      renderingDelta30d === null ? null : Number(renderingDelta30d.toFixed(3)),
      latest.sentiment_score === null ? null : Number(latest.sentiment_score),
      sentimentDelta30d === null ? null : Number(sentimentDelta30d.toFixed(3)),
      currentCells,
      visibilityByEngine === null ? null : JSON.stringify(visibilityByEngine),
    ],
  );

  // `aux_score_current` and `open_task_count` are DELIBERATELY NOT WRITTEN
  // here. AC9 lists them, and neither has a producer here: the AUX score
  // comes from `aux_audits` (refreshProjectAux) and the task counts from
  // `tasks` (refreshProjectTaskCounts) — separate rollup functions, because
  // this function only ever reads `metric_daily`. Writing 0 into either
  // would put a confident number on the matrix for a subsystem that has
  // never run — "audit score 0" reads as a failed audit, not as no audit.
  // They stay NULL/0-default until their own producer runs.
}

/** Every non-null numeric value of one column, across a set of brand rows. */
function nonNullNumbers<K extends string>(rows: readonly Record<K, string | null>[], key: K): number[] {
  return rows.flatMap((row) => (row[key] === null ? [] : [Number(row[key])]));
}

interface EngineScore {
  readonly score: number;
  readonly delta_30d: number | null;
}

/**
 * `visibility_by_engine` — one entry per engine with data in the current
 * window, cells-weighted exactly the way `GrowthMapService.bestAndWorstEngine`
 * already ranks engines: `sum(visibility_score * cells_total) / sum(cells_total)`,
 * over the per-engine `metric_daily` brand rows (never the `all` row, which
 * is the blend these numbers feed).
 *
 * `delta_30d` reuses the same 30-cell threshold as every other delta on this
 * row — NULL, not 0, when either window is under-sampled — computed from the
 * SAME weighted figure rather than a second, differently-shaped average.
 *
 * NULL WHEN THERE IS NO PER-ENGINE DATA, not `{}` — an empty object and "no
 * measurement" read the same to a human but not to a client checking for
 * absence.
 */
async function perEngineWindow(
  tx: ClientBase,
  projectId: string,
  timezone: string,
  boundary: string,
): Promise<Record<string, EngineScore> | null> {
  const rows = await tx.query<{
    engine_key: string;
    metric_date: string;
    visibility_score: string;
    cells_total: string;
  }>(
    `SELECT md.engine_key, to_char(md.metric_date, 'YYYY-MM-DD') AS metric_date,
            md.visibility_score::text, md.cells_total::text
       FROM metric_daily md
      WHERE md.project_id = $1
        AND md.engine_key <> $2
        AND md.entity_type = 'brand'
        AND md.scoring_version = $3
        AND md.metric_date > ((now() AT TIME ZONE $4)::date - ($5 * 2)::int)`,
    [projectId, CROSS_ENGINE_KEY, SCORING_VERSION, timezone, WINDOW_DAYS],
  );

  if (rows.rows.length === 0) return null;

  const byEngine = new Map<string, typeof rows.rows>();
  for (const row of rows.rows) {
    byEngine.set(row.engine_key, [...(byEngine.get(row.engine_key) ?? []), row]);
  }

  const result: Record<string, EngineScore> = {};
  for (const [engineKey, engineRows] of byEngine) {
    const current = engineRows.filter((row) => row.metric_date > boundary);
    const prior = engineRows.filter((row) => row.metric_date <= boundary);

    const currentWeighted = weightedByCells(current);
    if (currentWeighted === null) continue; // no measured cell in the CURRENT window — nothing to report

    const delta = visibilityDelta(
      { score: currentWeighted, measuredCells: cellsIn(current) },
      { score: weightedByCells(prior), measuredCells: cellsIn(prior) },
    );

    result[engineKey] = { score: Number(currentWeighted.toFixed(3)), delta_30d: delta === null ? null : Number(delta.toFixed(3)) };
  }

  return Object.keys(result).length === 0 ? null : result;
}

/** `sum(visibility_score * cells_total) / sum(cells_total)` — null over zero measured cells. */
function weightedByCells(rows: readonly { visibility_score: string; cells_total: string }[]): number | null {
  const cells = cellsIn(rows);
  if (cells === 0) return null;
  const weighted = rows.reduce((total, row) => total + Number(row.visibility_score) * Number(row.cells_total), 0);
  return weighted / cells;
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
