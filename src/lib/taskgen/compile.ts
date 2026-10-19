import type { MetricWindowCondition } from "../../../contracts/tasks/index.js";
import { measurementStatusSql } from "../rollup/aggregate-day.js";

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
  /** The workspace's IANA timezone: the zone a capture's `captured_at` is read in to find its local date (the rollup's own rule). */
  readonly timezone: string;
}

export interface CompiledQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * The value of the metric over one window's aggregates (alias `t` is a row of `winr`). A COUNT is measured PER CAPTURE RUN: windows
 * can hold different numbers of runs (the scheduler's cadence is 7.5 days, not a calendar week, and a manual deep scan adds a run),
 * so a raw window sum would read an extra run as growth and a missing one as a drop.
 */
const VALUE_SQL: Record<MetricWindowCondition["metric"], (t: string) => string> = {
  sov: (t) => `${t}.sov_w / NULLIF(${t}.cells, 0)`,
  presence_rate: (t) => `${t}.present / NULLIF(${t}.cells, 0)`,
  owned_citation_count: (t) => `${t}.owned / NULLIF(${t}.runs, 0)`,
};

/**
 * The same metric for ONE day's row (alias `d` is a `metric_daily` row, `rd` that day's run count). A count is divided by the runs
 * the day holds, so a day and a window are in one unit (a count per run) whatever the plan's cadence.
 */
const DAY_VALUE_SQL: Record<MetricWindowCondition["metric"], string> = {
  sov: "d.sov::float8",
  presence_rate: "d.cells_present::float8 / NULLIF(d.cells_total, 0)",
  owned_citation_count: "d.citations_owned::float8 / NULLIF(rd.runs, 0)",
};

const CHANGE_SQL: Record<MetricWindowCondition["change"], Record<MetricWindowCondition["direction"], (cur: string, prior: string) => string>> = {
  relative: {
    down: (cur, prior) => `(${prior} - ${cur}) / NULLIF(${prior}, 0)`,
    up: (cur, prior) => `(${cur} - ${prior}) / NULLIF(${prior}, 0)`,
  },
  absolute: { down: (cur, prior) => `${prior} - ${cur}`, up: (cur, prior) => `${cur} - ${prior}` },
};

// Day floor (a documented constant of the grammar, derived from the rule's own numbers rather than tuned separately): a day is
// only a breaching day when it carries at least `ceil(min_n / window_days)` cells, the average a day would hold if the sample
// floor were reached on daily captures. A low-volume blip therefore cannot make up the count around one heavy day. It never
// blocks a sparse cadence, whose capture days hold MORE than that average (a weekly day carries the whole window's sample).

/**
 * One row per engine (never the cross-engine `all` row) whose metric moved by at least the threshold in the given direction,
 * with the windows at or above the sample floor, AND the change sustained.
 *
 * A CAPTURE RUN IS NOT A DATE. `metric_daily` is keyed by the workspace-local date of a capture, and the scheduler's weekly cadence
 * (7.5 days, plus per-cell jitter) drifts across local midnight, so ONE run can put facts on two dates. "Sustained" therefore counts
 * RUNS: the distinct `answer_captures.run_id`s of the engine whose captures fall in the window (a measurement status, the scoring
 * version, read in the workspace timezone exactly as the rollup does). A window holds 7 runs on daily, about 2 on twice-weekly, 1 on weekly.
 *  - TWO OR MORE runs in the current window: the window change must reach the threshold, and it must hold on at least
 *    `min(sustained_days, runs_in_window)` distinct RUNS, each on a day carrying the day floor above (so one heavy day or one bad
 *    run cannot carry the aggregate when there are runs to compare). Each of those days is compared with the prior window's value.
 *  - ONE run in the current window: there is nothing to compare within it, so the change must hold against a SHARED BASELINE, the
 *    window before the prior one: BOTH the prior window and the current window breach against it (all three at the sample floor).
 *    A held step drop (0.4, 0.28, 0.28) and a continuing decline fire; one bad run (0.4, 0.4, 0.28), or a bad run that recovered
 *    (0.4, 0.28, 0.4), does not. Zero runs (facts with no capture behind them) fire nothing.
 * `current_runs` counts the CURRENT window's runs.
 *
 * Columns: `engine_key`, `n_current`, `n_prior`, `cur_value`, `prior_value`, `change_value` (a positive magnitude in the rule's unit).
 * On the one-run path `prior_value` and `change_value` are the shared baseline's and the change against it.
 *
 * The current window is the `window_days` ending at `metricDate`; the prior window is the `window_days` before it. A
 * relative change needs a non-zero prior value; an empty or null window cannot fire.
 */
export function compileMetricWindow(condition: MetricWindowCondition, params: CompileParams): CompiledQuery {
  const values: unknown[] = [
    params.projectId, params.metricDate, condition.window_days, params.scoringVersion, condition.min_n, condition.threshold, condition.sustained_days,
    params.timezone,
  ];
  const relative = condition.change === "relative";
  const priorGuard = relative ? "AND prior_value > 0" : "";
  const change = CHANGE_SQL[condition.change][condition.direction];
  const v = VALUE_SQL[condition.metric];
  const text = `
WITH win AS (
  SELECT engine_key,
         (($2::date - metric_date) / $3::int) AS bucket,
         sum(cells_total)::float8 AS cells,
         sum(cells_present)::float8 AS present,
         sum(sov * cells_total)::float8 AS sov_w,
         sum(citations_owned)::float8 AS owned
    FROM metric_daily
   WHERE project_id = $1::uuid
     AND entity_type = 'brand'
     AND engine_key <> 'all'
     AND scoring_version = $4
     AND metric_date >  $2::date - 3 * $3::int
     AND metric_date <= $2::date
   GROUP BY engine_key, bucket
), runs AS (
  SELECT DISTINCT c.engine_key, c.run_id, (c.captured_at AT TIME ZONE $8::text)::date AS run_date
    FROM answer_captures c
   WHERE c.project_id = $1::uuid
     AND c.scoring_version = $4
     AND ${measurementStatusSql("c.status")}
     AND c.captured_at >= (($2::date - 3 * $3::int + 1)::timestamp AT TIME ZONE $8::text)
     AND c.captured_at <  (($2::date + 1)::timestamp AT TIME ZONE $8::text)
), runwin AS (
  SELECT engine_key, (($2::date - run_date) / $3::int) AS bucket, (count(DISTINCT run_id))::int AS runs
    FROM runs
   GROUP BY engine_key, bucket
), runday AS (
  SELECT engine_key, run_date, (count(DISTINCT run_id))::int AS runs
    FROM runs
   GROUP BY engine_key, run_date
), winr AS (
  SELECT w.*, COALESCE(r.runs, 0) AS runs
    FROM win w
    LEFT JOIN runwin r ON r.engine_key = w.engine_key AND r.bucket = w.bucket
), pair AS (
  SELECT c.engine_key,
         c.cells AS n_current,
         p.cells AS n_prior,
         c.runs AS current_runs,
         ${v("c")} AS cur_value,
         ${v("p")} AS prior_value
    FROM winr c
    JOIN winr p ON p.engine_key = c.engine_key AND c.bucket = 0 AND p.bucket = 1
), scored AS (
  SELECT engine_key, n_current, n_prior, current_runs, cur_value, prior_value,
         CASE WHEN prior_value IS NULL OR cur_value IS NULL THEN NULL ELSE ${change("cur_value", "prior_value")} END AS change_value
    FROM pair
), shared AS (
  SELECT w0.engine_key,
         ${v("w2")} AS baseline_value,
         ${change(v("w0"), v("w2"))} AS baseline_change,
         COALESCE(
           w0.cells >= $5::float8 AND w1.cells >= $5::float8 AND w2.cells >= $5::float8
           AND ${v("w0")} IS NOT NULL AND ${v("w1")} IS NOT NULL AND ${v("w2")} IS NOT NULL
           ${relative ? `AND ${v("w2")} > 0` : ""}
           AND ${change(v("w0"), v("w2"))} >= $6::float8
           AND ${change(v("w1"), v("w2"))} >= $6::float8,
           false) AS held
    FROM winr w0
    JOIN winr w1 ON w1.engine_key = w0.engine_key AND w0.bucket = 0 AND w1.bucket = 1
    JOIN winr w2 ON w2.engine_key = w0.engine_key AND w2.bucket = 2
), daily AS (
  SELECT d.engine_key, count(DISTINCT r.run_id) AS runs_breached
    FROM metric_daily d
    JOIN scored s ON s.engine_key = d.engine_key
    JOIN runday rd ON rd.engine_key = d.engine_key AND rd.run_date = d.metric_date
    JOIN runs r ON r.engine_key = d.engine_key AND r.run_date = d.metric_date
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
SELECT s.engine_key, s.n_current, s.n_prior, s.cur_value,
       CASE WHEN s.current_runs >= 2 THEN s.prior_value ELSE g.baseline_value END AS prior_value,
       CASE WHEN s.current_runs >= 2 THEN s.change_value ELSE g.baseline_change END AS change_value
  FROM scored s
  LEFT JOIN daily y ON y.engine_key = s.engine_key
  LEFT JOIN shared g ON g.engine_key = s.engine_key
 WHERE s.n_current >= $5::float8
   AND s.n_prior   >= $5::float8
   AND s.cur_value IS NOT NULL
   AND s.prior_value IS NOT NULL
   AND (
     (s.current_runs >= 2
       ${priorGuard.replace("prior_value", "s.prior_value")}
       AND s.change_value >= $6::float8
       AND COALESCE(y.runs_breached, 0) >= LEAST($7::int, s.current_runs))
     OR (s.current_runs = 1 AND COALESCE(g.held, false))
   )
 ORDER BY s.engine_key`;
  return { text, values };
}
