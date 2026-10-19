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
  negative_mention_rate: (t) => `${t}.negative / NULLIF(${t}.mentions, 0)`,
};

/** The sample size the `min_n` floor applies to: cells, except a rate over mentions, which is sized by mentions. */
const SAMPLE_SQL: Record<MetricWindowCondition["metric"], (t: string) => string> = {
  sov: (t) => `${t}.cells`,
  presence_rate: (t) => `${t}.cells`,
  owned_citation_count: (t) => `${t}.cells`,
  negative_mention_rate: (t) => `${t}.mentions`,
};

const CHANGE_SQL: Record<MetricWindowCondition["change"], Record<MetricWindowCondition["direction"], string>> = {
  relative: { down: "(prior_value - cur_value) / prior_value", up: "(cur_value - prior_value) / prior_value" },
  absolute: { down: "prior_value - cur_value", up: "cur_value - prior_value" },
};

/**
 * One row per engine (never the cross-engine `all` row) whose metric moved by at least the threshold in the given
 * direction, with BOTH windows at or above the sample floor. Columns: `engine_key`, `n_current`, `n_prior`, `cur_value`,
 * `prior_value`, `change_value` (a positive magnitude in the rule's unit).
 *
 * The current window is the `window_days` ending at `metricDate`; the prior window is the `window_days` before it. A
 * relative change needs a non-zero prior value; an empty or null window cannot fire.
 */
export function compileMetricWindow(condition: MetricWindowCondition, params: CompileParams): CompiledQuery {
  const values: unknown[] = [params.projectId, params.metricDate, condition.window_days, params.scoringVersion, condition.min_n, condition.threshold];
  const floor = condition.min_current === undefined ? "" : `AND cur_value >= $${String(values.push(condition.min_current))}::float8`;
  const priorGuard = condition.change === "relative" ? "AND prior_value > 0" : "";
  const text = `
WITH win AS (
  SELECT engine_key,
         (metric_date > $2::date - $3::int) AS is_current,
         sum(cells_total)::float8 AS cells,
         sum(cells_present)::float8 AS present,
         sum(sov * cells_total)::float8 AS sov_w,
         sum(citations_owned)::float8 AS owned,
         sum(mentions_total)::float8 AS mentions,
         sum(mentions_negative)::float8 AS negative
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
         ${SAMPLE_SQL[condition.metric]("c")} AS n_current,
         ${SAMPLE_SQL[condition.metric]("p")} AS n_prior,
         ${VALUE_SQL[condition.metric]("c")} AS cur_value,
         ${VALUE_SQL[condition.metric]("p")} AS prior_value
    FROM win c
    JOIN win p ON p.engine_key = c.engine_key AND c.is_current AND NOT p.is_current
), scored AS (
  SELECT engine_key, n_current, n_prior, cur_value, prior_value,
         CASE WHEN prior_value IS NULL OR cur_value IS NULL THEN NULL ELSE ${CHANGE_SQL[condition.change][condition.direction]} END AS change_value
    FROM pair
)
SELECT engine_key, n_current, n_prior, cur_value, prior_value, change_value
  FROM scored
 WHERE n_current >= $5::float8
   AND n_prior   >= $5::float8
   AND cur_value IS NOT NULL
   AND prior_value IS NOT NULL
   ${priorGuard}
   AND change_value >= $6::float8
   ${floor}
 ORDER BY engine_key`;
  return { text, values };
}
