import type { MetricWindowCondition } from "../../../contracts/tasks/index.js";

// STORY-063 — the SQL predicate compiler for the `metric_window` template.
//
// THE GRAMMAR IS CLOSED, so this is a lookup, not a parser. Every fragment of SQL below is a constant selected by an enum
// member the zod schema has already validated; every NUMBER the condition carries (threshold, window, sample floor, floor
// value) and the project, date and scoring version are bound PARAMETERS. Nothing from the stored condition is ever
// concatenated into the statement, which is what keeps a jsonb catalog from being an injection vector — and the statement
// runs in the job's tenant transaction, so RLS still scopes every read.

export interface CompileParams {
  readonly projectId: string;
  /** `YYYY-MM-DD`, workspace-local: the LAST day of the current window. */
  readonly metricDate: string;
  readonly scoringVersion: string;
}

export interface CompiledQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** The value of the metric over one window's aggregates (alias `t` is a row of `win`). */
const VALUE_SQL: Record<MetricWindowCondition["metric"], (t: string) => string> = {
  sov: (t) => `${t}.sov_w / NULLIF(${t}.cells, 0)`,
  presence_rate: (t) => `${t}.present / NULLIF(${t}.cells, 0)`,
  owned_citation_count: (t) => `${t}.owned`,
};

/**
 * The same metric for ONE day's row (alias `d` is a `metric_daily` row; `$3` is the window length). A count is scaled to the
 * window (a day that matches the prior window's daily average reads as the prior window's total), so a day and a window
 * are comparable in one unit.
 */
const DAY_VALUE_SQL: Record<MetricWindowCondition["metric"], string> = {
  sov: "d.sov::float8",
  presence_rate: "d.cells_present::float8 / NULLIF(d.cells_total, 0)",
  owned_citation_count: "d.citations_owned::float8 * $3::int",
};

const CHANGE_SQL: Record<MetricWindowCondition["change"], Record<MetricWindowCondition["direction"], (cur: string, prior: string) => string>> = {
  relative: {
    down: (cur, prior) => `(${prior} - ${cur}) / NULLIF(${prior}, 0)`,
    up: (cur, prior) => `(${cur} - ${prior}) / NULLIF(${prior}, 0)`,
  },
  absolute: { down: (cur, prior) => `${prior} - ${cur}`, up: (cur, prior) => `${cur} - ${prior}` },
};

/**
 * One row per engine (never the cross-engine `all` row) whose metric moved by at least the threshold in the given
 * direction, with BOTH windows at or above the sample floor AND the change holding on at least `sustained_days` individual days of the
 * current window (so one heavy day cannot carry the aggregate). A day is only a breaching day when it carries at least
 * `ceil(min_n / window_days)` cells: low-volume blips cannot make up the count around one heavy day. Columns: `engine_key`, `n_current`, `n_prior`, `cur_value`,
 * `prior_value`, `change_value` (a positive magnitude in the rule's unit).
 *
 * The current window is the `window_days` ending at `metricDate`; the prior window is the `window_days` before it. A
 * relative change needs a non-zero prior value; an empty or null window cannot fire.
 */
export function compileMetricWindow(condition: MetricWindowCondition, params: CompileParams): CompiledQuery {
  const values: unknown[] = [
    params.projectId, params.metricDate, condition.window_days, params.scoringVersion, condition.min_n, condition.threshold, condition.sustained_days,
  ];
  const priorGuard = condition.change === "relative" ? "AND prior_value > 0" : "";
  const change = CHANGE_SQL[condition.change][condition.direction];
  const text = `
WITH win AS (
  SELECT engine_key,
         (metric_date > $2::date - $3::int) AS is_current,
         sum(cells_total)::float8 AS cells,
         sum(cells_present)::float8 AS present,
         sum(sov * cells_total)::float8 AS sov_w,
         sum(citations_owned)::float8 AS owned
    FROM metric_daily
   WHERE project_id = $1::uuid
     AND entity_type = 'brand'
     AND engine_key <> 'all'
     AND scoring_version = $4
     AND metric_date >  $2::date - 2 * $3::int
     AND metric_date <= $2::date
   GROUP BY engine_key, is_current
), pair AS (
  SELECT c.engine_key,
         c.cells AS n_current,
         p.cells AS n_prior,
         ${VALUE_SQL[condition.metric]("c")} AS cur_value,
         ${VALUE_SQL[condition.metric]("p")} AS prior_value
    FROM win c
    JOIN win p ON p.engine_key = c.engine_key AND c.is_current AND NOT p.is_current
), scored AS (
  SELECT engine_key, n_current, n_prior, cur_value, prior_value,
         CASE WHEN prior_value IS NULL OR cur_value IS NULL THEN NULL ELSE ${change("cur_value", "prior_value")} END AS change_value
    FROM pair
), daily AS (
  SELECT d.engine_key, count(*) AS days_breached
    FROM metric_daily d
    JOIN scored s ON s.engine_key = d.engine_key
   WHERE d.project_id = $1::uuid
     AND d.entity_type = 'brand'
     AND d.scoring_version = $4
     AND d.metric_date >  $2::date - $3::int
     AND d.metric_date <= $2::date
     AND d.cells_total >= ceil($5::float8 / $3::int)
     AND s.prior_value IS NOT NULL
     ${priorGuard.replace("prior_value", "s.prior_value")}
     AND ${change(DAY_VALUE_SQL[condition.metric], "s.prior_value")} >= $6::float8
   GROUP BY d.engine_key
)
SELECT s.engine_key, s.n_current, s.n_prior, s.cur_value, s.prior_value, s.change_value
  FROM scored s
  JOIN daily y ON y.engine_key = s.engine_key
 WHERE s.n_current >= $5::float8
   AND s.n_prior   >= $5::float8
   AND s.cur_value IS NOT NULL
   AND s.prior_value IS NOT NULL
   ${priorGuard.replace("prior_value", "s.prior_value")}
   AND s.change_value >= $6::float8
   AND y.days_breached >= $7::int
 ORDER BY s.engine_key`;
  return { text, values };
}
