import type { MetricWindowCondition } from "../../../contracts/tasks/index.js";
import { CYCLE_DAYS } from "../capture/engine-cadence.js";
import { measurementStatusSql } from "../rollup/aggregate-day.js";

// STORY-063 — the SQL predicate compiler for the `metric_window` template.
//
// THE GRAMMAR IS CLOSED, so this is a lookup, not a parser. Every fragment of SQL below is a constant selected by an enum
// member the zod schema has already validated; every NUMBER the condition carries (threshold, window, sample floor, floor
// value) and the project, date and scoring version are bound PARAMETERS. Nothing from the stored condition is ever
// concatenated into the statement, which is what keeps a jsonb catalog from being an injection vector — and the statement
// runs in the job's tenant transaction, so RLS still scopes every read.

/**
 * The window a rule actually compares for one engine, derived from the PLAN'S CADENCE (`engines.cadence_by_plan -> <plan>`, the
 * `cadence` column of `project_entitled_engines`: runs per 30-day cycle, per run kind) — data, never a plan name.
 *
 * The rule's `window_days` is the SHORTEST window worth comparing, and a window must be able to hold two runs for "sustained" to mean
 * anything. The interval between an engine's runs is `CYCLE_DAYS / (its most frequent kind's runs per cycle)`. A cadence whose
 * interval fits the rule's window (Growth: 3.75 days, Business: daily) keeps it. A slower cadence (Starter: 4 runs, 7.5 days, which can
 * leave a 7-day window with no run at all) widens the window to the smallest whole multiple of `window_days` that covers the
 * interval: a `window_days: 7` rule at Starter compares the last 14 days with the 14 before (owner decision 2026-10-19), two runs a
 * side, and the drop has to hold in both recent runs.
 *
 * No usable cadence (an engine the plan does not schedule, a malformed value) returns the rule's own window.
 *
 * "Keeps the rule's window" means the INTERVAL between runs (`CYCLE_DAYS / runs per cycle`) is no longer than `window_days`, not "two or
 * more runs per 7 days" literally: Growth (8 runs, 3.75 days, 1.87 a week) keeps 7 days although a 7-day window can then hold one run,
 * in which case no `metric_window` rule fires (it misses a drop; it never raises a false alarm). Owner confirmation of Growth at 7 days
 * is OPEN (plans-7day/story-063-decisions.md, Round 6).
 *
 * KNOWN LIMIT: the most frequent KIND sets the interval. At Business that is `priority` (30 runs), which runs only the `is_priority`
 * prompts, while `full` (4 runs) covers every prompt. A 7-day window can hold 0 or 1 full runs, so two compared windows may mix
 * prompt sets and their per-cell rates move from composition alone when the priority subset is smaller than the prompt list, and a
 * Business project with no priority prompts flagged runs weekly on a 7-day window. Prompt generation flags the top 50 by default,
 * so the common case is the full list.
 */
export function effectiveWindowDays(windowDays: number, cadence: unknown): number {
  if (typeof cadence !== "object" || cadence === null || Array.isArray(cadence)) return windowDays;
  const runsPerCycle = Math.max(0, ...Object.values(cadence).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0));
  if (runsPerCycle === 0) return windowDays;
  const intervalDays = CYCLE_DAYS / runsPerCycle;
  return windowDays * Math.max(1, Math.ceil(intervalDays / windowDays));
}

export interface CompileParams {
  readonly projectId: string;
  /** `YYYY-MM-DD`, workspace-local: the LAST day of the current window. */
  readonly metricDate: string;
  readonly scoringVersion: string;
  /** The workspace's IANA timezone: the zone a capture's `captured_at` is read in to find its local date (the rollup's own rule). */
  readonly timezone: string;
  /** Per engine, the window `effectiveWindowDays` derived from its cadence. An engine absent here is compared over the rule's own `window_days`. */
  readonly engineWindowDays: Readonly<Record<string, number>>;
}

export interface CompiledQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * The value of the metric over one window's aggregates (alias `t` is a row of `winr`). EVERY metric is a rate per MEASURED CELL, a
 * count included (`owned_citation_count` is owned citations per measured cell): a rate is immune to how a run is cut. A run split over
 * two local dates keeps its rate on both halves, a project that trims its prompt list keeps the per-prompt rate, and windows holding
 * different numbers of runs (the scheduler's cadence is 7.5 days, not a calendar week; a manual deep scan adds a run) compare like
 * with like. A per-run or per-date count reads any of those as a drop.
 */
const VALUE_SQL: Record<MetricWindowCondition["metric"], (t: string) => string> = {
  sov: (t) => `${t}.sov_w / NULLIF(${t}.cells, 0)`,
  presence_rate: (t) => `${t}.present / NULLIF(${t}.cells, 0)`,
  owned_citation_count: (t) => `${t}.owned / NULLIF(${t}.cells, 0)`,
};

/** The same metric for ONE day's row (alias `d` is a `metric_daily` row), in the same unit as the window value above. */
const DAY_VALUE_SQL: Record<MetricWindowCondition["metric"], string> = {
  sov: "d.sov::float8",
  presence_rate: "d.cells_present::float8 / NULLIF(d.cells_total, 0)",
  owned_citation_count: "d.citations_owned::float8 / NULLIF(d.cells_total, 0)",
};

const CHANGE_SQL: Record<MetricWindowCondition["change"], Record<MetricWindowCondition["direction"], (cur: string, prior: string) => string>> = {
  relative: {
    down: (cur, prior) => `(${prior} - ${cur}) / NULLIF(${prior}, 0)`,
    up: (cur, prior) => `(${cur} - ${prior}) / NULLIF(${prior}, 0)`,
  },
  absolute: { down: (cur, prior) => `${prior} - ${cur}`, up: (cur, prior) => `${cur} - ${prior}` },
};

// Day floor (a documented constant of the grammar, derived from the rule's own numbers rather than tuned separately): a day is
// only a breaching day when it carries at least `ceil(min_n / span)` cells, where `span` is the engine's effective window (see
// `effectiveWindowDays`), the average a day would hold if the sample floor were reached on daily captures. A low-volume blip
// therefore cannot make up the count around one heavy day. It never blocks a sparse cadence, whose capture days hold MORE than that
// average (a weekly day carries a whole window's sample divided by its two runs).

/**
 * One row per engine (never the cross-engine `all` row) whose metric moved by at least the threshold in the given direction,
 * with the windows at or above the sample floor, AND the change sustained.
 *
 * THE WINDOW is the engine's effective window (`effectiveWindowDays`, from the plan's cadence): the rule's own `window_days` for a
 * cadence with two or more runs in it, a whole multiple of it for a weekly cadence. The current window is the `span` days ending
 * at `metricDate`; the prior window is the `span` days before it.
 *
 * A CAPTURE RUN IS NOT A DATE, AND BELONGS TO EXACTLY ONE WINDOW. `metric_daily` is keyed by the workspace-local date of a capture,
 * and the scheduler's cadence (7.5 days, plus per-cell jitter) drifts across local midnight, so ONE run can put facts on two dates,
 * even on either side of a window boundary. A run (a distinct `answer_captures.run_id` of the engine, measurement status, scoring
 * version, read in the workspace timezone exactly as the rollup does) is therefore bucketed by its EARLIEST local capture date,
 * for the count of runs and for the sustain check alike. The compared windows' run sets are disjoint by construction, so one bad
 * run can never be both the "prior" and the "current" breach. (The cell and fact totals still follow `metric_daily`'s dates:
 * a run's two halves are the same rate, which is why every metric is a rate per measured cell.)
 *  - The change needs TWO OR MORE runs in the current window (a single run is a single sample: there is no shared-baseline path).
 *    The window change must reach the threshold, and it must hold on at least `min(sustained_days, runs_in_window)` distinct RUNS,
 *    each on a date carrying the day floor, compared with the prior window's value. One heavy day or one bad run cannot carry the
 *    aggregate when there are runs to compare.
 *
 * A RUN BREACHES FROM FACTS THAT ARE ITS OWN. A `metric_daily` row blends every run that put cells on that date (a manual deep scan
 * beside a scheduled run; a Business full run beside a daily priority run; a straddler's tail beside the next run's head), so a
 * bad run and a good one on one date make a row that is neither run's value, and breaching on it would credit BOTH runs for one bad
 * sample. A date is therefore evidence only for the run that is ALONE on it (`date_runs.runs_on_date = 1`, over the engine's runs
 * in the same measurement status, scoring version and timezone); a run with no date of its own breaches on nothing. The cost is
 * recall, never a false alarm: a shared date can only hide a breach (the run still counts toward `current_runs`, so the sustain
 * requirement does not shrink). The upgrade path is a per-run rate from `answer_captures` grouped by `run_id`.
 *
 * `run_dates` reads one day MORE than the compared windows reach back, so a run that began just before them still has its true earliest date;
 * the `daily` CTE counts a date for every run of the CURRENT window (bucket 0) that put facts on it, a run once however many dates it touches, and only for a date no other run of the engine touches.
 *
 * Columns: `engine_key`, `n_current`, `n_prior`, `cur_value`, `prior_value`, `change_value` (a positive magnitude in the rule's unit).
 * A relative change needs a non-zero prior value; an empty or null window cannot fire.
 */
export function compileMetricWindow(condition: MetricWindowCondition, params: CompileParams): CompiledQuery {
  const spanEngines = Object.keys(params.engineWindowDays).sort();
  const values: unknown[] = [
    params.projectId, params.metricDate, condition.window_days, params.scoringVersion, condition.min_n, condition.threshold, condition.sustained_days,
    params.timezone, spanEngines, spanEngines.map((engine) => params.engineWindowDays[engine]),
  ];
  const relative = condition.change === "relative";
  const priorGuard = relative ? "AND s.prior_value > 0" : "";
  const change = CHANGE_SQL[condition.change][condition.direction];
  const v = VALUE_SQL[condition.metric];
  const text = `
WITH eng AS (
  SELECT engine_key, span
    FROM unnest($9::text[], $10::int[]) AS e(engine_key, span)
), win AS (
  SELECT d.engine_key,
         (($2::date - d.metric_date) / COALESCE(e.span, $3::int)) AS bucket,
         sum(d.cells_total)::float8 AS cells,
         sum(d.cells_present)::float8 AS present,
         sum(d.sov * d.cells_total)::float8 AS sov_w,
         sum(d.citations_owned)::float8 AS owned
    FROM metric_daily d
    LEFT JOIN eng e ON e.engine_key = d.engine_key
   WHERE d.project_id = $1::uuid
     AND d.entity_type = 'brand'
     AND d.engine_key <> 'all'
     AND d.scoring_version = $4
     AND d.metric_date >  $2::date - 2 * COALESCE(e.span, $3::int)
     AND d.metric_date <= $2::date
   GROUP BY d.engine_key, bucket
), run_dates AS (
  SELECT DISTINCT c.engine_key, c.run_id, (c.captured_at AT TIME ZONE $8::text)::date AS run_date, COALESCE(e.span, $3::int) AS span
    FROM answer_captures c
    LEFT JOIN eng e ON e.engine_key = c.engine_key
   WHERE c.project_id = $1::uuid
     AND c.scoring_version = $4
     AND ${measurementStatusSql("c.status")}
     AND c.captured_at >= (($2::date - 2 * COALESCE(e.span, $3::int))::timestamp AT TIME ZONE $8::text)
     AND c.captured_at <  (($2::date + 1)::timestamp AT TIME ZONE $8::text)
), runs AS (
  SELECT engine_key, run_id, span, min(run_date) AS first_date,
         (($2::date - min(run_date)) / span) AS bucket
    FROM run_dates
   GROUP BY engine_key, run_id, span
), date_runs AS (
  SELECT engine_key, run_date, (count(*))::int AS runs_on_date
    FROM run_dates
   GROUP BY engine_key, run_date
), runwin AS (
  SELECT engine_key, bucket, (count(*))::int AS runs
    FROM runs
   GROUP BY engine_key, bucket
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
), daily AS (
  SELECT d.engine_key, count(DISTINCT r.run_id) AS runs_breached
    FROM metric_daily d
    JOIN scored s ON s.engine_key = d.engine_key
    JOIN run_dates rd ON rd.engine_key = d.engine_key AND rd.run_date = d.metric_date
    JOIN date_runs dr ON dr.engine_key = rd.engine_key AND dr.run_date = rd.run_date AND dr.runs_on_date = 1
    JOIN runs r ON r.engine_key = rd.engine_key AND r.run_id = rd.run_id AND r.bucket = 0
   WHERE d.project_id = $1::uuid
     AND d.entity_type = 'brand'
     AND d.scoring_version = $4
     AND d.metric_date >  $2::date - r.span
     AND d.metric_date <= $2::date
     AND d.cells_total >= ceil($5::float8 / r.span)
     AND s.prior_value IS NOT NULL
     ${priorGuard}
     AND ${change(DAY_VALUE_SQL[condition.metric], "s.prior_value")} >= $6::float8
   GROUP BY d.engine_key
)
SELECT s.engine_key, s.n_current, s.n_prior, s.cur_value, s.prior_value, s.change_value
  FROM scored s
  LEFT JOIN daily y ON y.engine_key = s.engine_key
 WHERE s.n_current >= $5::float8
   AND s.n_prior   >= $5::float8
   AND s.cur_value IS NOT NULL
   AND s.prior_value IS NOT NULL
   AND s.current_runs >= 2
   ${priorGuard}
   AND s.change_value >= $6::float8
   AND COALESCE(y.runs_breached, 0) >= LEAST($7::int, s.current_runs)
 ORDER BY s.engine_key`;
  return { text, values };
}
