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
 * The days between an engine's runs, from the PLAN'S CADENCE (`engines.cadence_by_plan -> <plan>`, the `cadence` column of
 * `project_entitled_engines`: runs per 30-day cycle, per run kind): `CYCLE_DAYS / (its most frequent kind's runs per cycle)`.
 * `null` when there is no usable cadence (an engine the plan does not schedule, a malformed value). Data, never a plan name.
 */
export function runIntervalDays(cadence: unknown): number | null {
  if (typeof cadence !== "object" || cadence === null || Array.isArray(cadence)) return null;
  const runsPerCycle = Math.max(0, ...Object.values(cadence).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0));
  return runsPerCycle === 0 ? null : CYCLE_DAYS / runsPerCycle;
}

/**
 * The window a rule actually compares for one engine, derived from the plan's cadence (`runIntervalDays`).
 *
 * The rule's `window_days` is the SHORTEST window worth comparing, and "sustained" needs a window that can hold two runs. A cadence with
 * two or more runs in `window_days` (interval no longer than half of it: Business daily, Enterprise hourly) keeps the rule's own window.
 * Any slower cadence widens it to the smallest whole multiple of `window_days` that is at least double AND covers the interval:
 * Starter (4 runs a cycle, 7.5 days) and Growth (8 runs, 3.75 days, 1.87 runs a 7-day window: owner's rule applied literally,
 * 2026-10-19) compare the last 14 days with the 14 before, and the drop has to hold in the recent runs of both.
 *
 * No usable cadence returns the rule's own window.
 *
 * KNOWN LIMIT: the most frequent KIND sets the interval. At Business that is `priority` (30 runs), which runs only the `is_priority`
 * prompts, while `full` (4 runs) covers every prompt. A 7-day window can hold 0 or 1 full runs, so two compared windows may mix
 * prompt sets and their per-cell rates move from composition alone when the priority subset is smaller than the prompt list, and a
 * Business project with no priority prompts flagged runs weekly on a 7-day window. Prompt generation flags the top 50 by default,
 * so the common case is the full list.
 */
export function effectiveWindowDays(windowDays: number, cadence: unknown): number {
  const intervalDays = runIntervalDays(cadence);
  if (intervalDays === null || intervalDays * 2 <= windowDays) return windowDays;
  return windowDays * Math.max(2, Math.ceil(intervalDays / windowDays));
}

/**
 * The cells a run must hold to be a run at all, from the same cadence data as `effectiveWindowDays`: the window's sample floor
 * (`min_n`) divided by the MOST runs the window can hold (`ceil(span / interval)`), never under 1. A project whose runs all reach the
 * window's `min_n` between them (two Starter runs of 15 cells) therefore always has runs that count, while a remnant of a run does not.
 * 15 cells at Starter (2 runs), 8 at Growth (4), 5 at Business (7) and 1 at Enterprise. With no usable cadence the window is assumed to
 * hold one run a day, `ceil(min_n / span)`.
 */
export function runFloorCells(minN: number, span: number, cadence: unknown): number {
  const intervalDays = runIntervalDays(cadence) ?? 1;
  const runsHeld = Math.max(1, Math.ceil(span / intervalDays - 1e-9));
  return Math.max(1, Math.ceil(minN / runsHeld - 1e-9));
}

/** Slack on every threshold comparison: a change exactly AT the threshold counts ("at least"), though 0.9 - 0.8 is 0.0999... in floating point. */
const THRESHOLD_EPSILON = 1e-9;

export interface CompileParams {
  readonly projectId: string;
  /** `YYYY-MM-DD`, workspace-local: the LAST day of the current window. */
  readonly metricDate: string;
  readonly scoringVersion: string;
  /** The workspace's IANA timezone: the zone a capture's `captured_at` is read in to find its local date (the rollup's own rule). */
  readonly timezone: string;
  /** Per engine, the window `effectiveWindowDays` derived from its cadence. An engine absent here is compared over the rule's own `window_days`. */
  readonly engineWindowDays: Readonly<Record<string, number>>;
  /** Per engine, the cells a run must hold to count (`runFloorCells`). An engine absent here uses `ceil(min_n / window_days)`. */
  readonly engineRunFloor?: Readonly<Record<string, number>>;
}

export interface CompiledQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * The value of the metric over one aggregate (alias `t` is a row of `winr`, or of `runs`: the same four sums). EVERY metric is a rate
 * per MEASURED CELL, a count included (`owned_citation_count` is owned citations per measured cell): a project that trims its prompt
 * list keeps the per-prompt rate, and windows holding different numbers of runs (the scheduler's cadence is 7.5 days, not a calendar
 * week; a manual deep scan adds a run) compare like with like. A per-run or per-date count reads any of those as a drop. A rate does
 * NOT make a run's two halves interchangeable: a run split over two local dates puts two different prompt subsets on its two dates,
 * so a date's rate is not the run's. That is why a run is judged on all of its own cells (`runs`), never on one date's.
 */
const VALUE_SQL: Record<MetricWindowCondition["metric"], (t: string) => string> = {
  sov: (t) => `${t}.sov_w / NULLIF(${t}.cells, 0)`,
  presence_rate: (t) => `${t}.present / NULLIF(${t}.cells, 0)`,
  owned_citation_count: (t) => `${t}.owned / NULLIF(${t}.cells, 0)`,
};

const CHANGE_SQL: Record<MetricWindowCondition["change"], Record<MetricWindowCondition["direction"], (cur: string, prior: string) => string>> = {
  relative: {
    down: (cur, prior) => `(${prior} - ${cur}) / NULLIF(${prior}, 0)`,
    up: (cur, prior) => `(${cur} - ${prior}) / NULLIF(${prior}, 0)`,
  },
  absolute: { down: (cur, prior) => `${prior} - ${cur}`, up: (cur, prior) => `${cur} - ${prior}` },
};

/**
 * One row per engine (never the cross-engine `all` row) whose metric moved by at least the threshold in the given direction,
 * with the windows at or above the sample floor, AND the change sustained.
 *
 * THE WINDOW is the engine's effective window (`effectiveWindowDays`, from the plan's cadence): the rule's own `window_days` for a
 * cadence with two or more runs in it, a whole multiple of it otherwise. The current window is the `span` days ending
 * at `metricDate`; the prior window is the `span` days before it.
 *
 * A RUN IS A FINISHED, REPRESENTATIVE CAPTURE RUN. A distinct `answer_captures.run_id` of the engine (measurement status, scoring
 * version, read in the workspace timezone exactly as the rollup does) counts as a run, and can breach, only when
 *  - its `capture_runs` row is finished (`completed` or `partial`): the hourly rollup enqueues task.generate while the next run is
 *    still being captured, and its first cells are neither a run nor a breach until it finishes;
 *  - it measured at least half of the cells it planned for the engine (`planned_cells` over the `engine_keys` it covered): a run that
 *    lost most of its cells to failures is an outage, not a sample; and
 *  - it holds at least the cadence floor (`runFloorCells`: `ceil(min_n / most runs the window can hold)`, from the same cadence data as
 *    the window), so a remnant cannot be "the second of both recent runs".
 * A run that is none of those is simply absent: not counted in `current_runs`, not a breach.
 *
 * A CAPTURE RUN IS NOT A DATE, AND BELONGS TO EXACTLY ONE WINDOW. `metric_daily` is keyed by the workspace-local date of a capture,
 * and the scheduler's cadence (7.5 days, plus per-cell jitter) drifts across local midnight, so ONE run can put facts on two dates,
 * even on either side of a window boundary. A run is therefore bucketed by its EARLIEST local capture date, for the count of runs and
 * for the sustain check alike. The compared windows' run sets are disjoint by construction, so one bad run can never be both the
 * "prior" and the "current" breach. (The window VALUES and cell totals still follow `metric_daily`'s dates, so a straddler on a window
 * boundary leaves part of its cells in the neighbouring window; its two halves are different prompt subsets and need not share a
 * rate, so that can move a window value slightly. The sample floor and the threshold bound the effect.)
 *  - The change needs TWO OR MORE runs in the current window (a single run is a single sample: there is no shared-baseline path).
 *    The window change must reach the threshold, and it must hold on at least `min(sustained_days, runs_in_window)` runs, each compared
 *    with the prior window's value, AND at least `min(sustained_days, distinct dates the window's runs start on)` distinct local DATES
 *    must breach. Runs prove it is not one sample; dates prove it lasted. At Enterprise one local date holds 25 runs, so counting runs
 *    alone made three hours of one bad day "sustained".
 *    A DATE IS JUDGED ON THE POOLED CELLS of every qualifying run that starts on it (`rundates`: the runs' cells summed, one rate, compared
 *    with the prior value like a run). One run is a sample; a date's pool is 25 runs at Enterprise (about 1,250 cells), so ordinary
 *    per-run sampling noise on a few hours cannot make a date count, only a real collapse of the day can. With one run on a date (Starter,
 *    Growth, Business) the pool is that run and nothing changes. A scheduled run plus a manual run on one date is one date.
 *
 * Every comparison with the threshold is inclusive with a 1e-9 slack: a change exactly at the threshold counts.
 *
 * A RUN IS JUDGED ON ITS OWN CELLS, ALL OF THEM. The per-run rate is read from `answer_captures` grouped by `(engine_key, run_id)`:
 * presence is the cells with `brand_present`, share the mean of `sov` over the run's cells, owned citations `owned_citation_count`
 * per cell. A run breaches when that rate moves by the threshold against the prior window's value. A date is NOT the unit of
 * evidence: a date row blends every run that touched it (and a run's two halves are different prompt subsets).
 *
 * `runs` reads one day MORE than the compared windows reach back, so a run that began just before them still has its true earliest
 * date (and lands in an older bucket, where it is not judged).
 *
 * Columns: `engine_key`, `n_current`, `n_prior`, `cur_value`, `prior_value`, `change_value` (a positive magnitude in the rule's unit).
 * A relative change needs a non-zero prior value; an empty or null window cannot fire.
 */
export function compileMetricWindow(condition: MetricWindowCondition, params: CompileParams): CompiledQuery {
  const spanEngines = Object.keys(params.engineWindowDays).sort();
  const values: unknown[] = [
    params.projectId, params.metricDate, condition.window_days, params.scoringVersion, condition.min_n, condition.threshold, condition.sustained_days,
    params.timezone, spanEngines, spanEngines.map((engine) => params.engineWindowDays[engine]),
    spanEngines.map((engine) => params.engineRunFloor?.[engine] ?? Math.max(1, Math.ceil(condition.min_n / params.engineWindowDays[engine]!))),
  ];
  const relative = condition.change === "relative";
  const priorGuard = relative ? "AND s.prior_value > 0" : "";
  const change = CHANGE_SQL[condition.change][condition.direction];
  const v = VALUE_SQL[condition.metric];
  const text = `
WITH eng AS (
  SELECT engine_key, span, run_floor
    FROM unnest($9::text[], $10::int[], $11::int[]) AS e(engine_key, span, run_floor)
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
), runcells AS (
  SELECT c.engine_key, c.run_id, COALESCE(e.span, $3::int) AS span,
         COALESCE(e.run_floor, CEIL($5::float8 / $3::int))::float8 AS run_floor,
         (r.planned_cells::float8 / GREATEST(cardinality(r.engine_keys), 1)) AS planned,
         min((c.captured_at AT TIME ZONE $8::text)::date) AS first_date,
         (count(*))::float8 AS cells,
         (count(*) FILTER (WHERE c.brand_present))::float8 AS present,
         COALESCE(sum(COALESCE(c.sov, 0)), 0)::float8 AS sov_w,
         COALESCE(sum(c.owned_citation_count), 0)::float8 AS owned
    FROM answer_captures c
    JOIN capture_runs r ON r.id = c.run_id AND r.project_id = c.project_id
    LEFT JOIN eng e ON e.engine_key = c.engine_key
   WHERE c.project_id = $1::uuid
     AND c.scoring_version = $4
     AND ${measurementStatusSql("c.status")}
     AND r.status IN ('completed', 'partial')
     AND c.captured_at >= (($2::date - 2 * COALESCE(e.span, $3::int))::timestamp AT TIME ZONE $8::text)
     AND c.captured_at <  (($2::date + 1)::timestamp AT TIME ZONE $8::text)
   GROUP BY c.engine_key, c.run_id, COALESCE(e.span, $3::int), COALESCE(e.run_floor, CEIL($5::float8 / $3::int)), r.planned_cells, cardinality(r.engine_keys)
), runs AS (
  SELECT *, (($2::date - first_date) / span) AS bucket
    FROM runcells
   WHERE cells >= run_floor
     AND cells >= planned / 2
), runwin AS (
  SELECT engine_key, bucket, (count(*))::int AS runs, (count(DISTINCT first_date))::int AS run_dates
    FROM runs
   GROUP BY engine_key, bucket
), rundates AS (
  SELECT engine_key, bucket, first_date,
         sum(cells) AS cells, sum(present) AS present, sum(sov_w) AS sov_w, sum(owned) AS owned
    FROM runs
   GROUP BY engine_key, bucket, first_date
), winr AS (
  SELECT w.*, COALESCE(r.runs, 0) AS runs, COALESCE(r.run_dates, 0) AS run_dates
    FROM win w
    LEFT JOIN runwin r ON r.engine_key = w.engine_key AND r.bucket = w.bucket
), pair AS (
  SELECT c.engine_key,
         c.cells AS n_current,
         p.cells AS n_prior,
         c.runs AS current_runs,
         c.run_dates AS current_dates,
         ${v("c")} AS cur_value,
         ${v("p")} AS prior_value
    FROM winr c
    JOIN winr p ON p.engine_key = c.engine_key AND c.bucket = 0 AND p.bucket = 1
), scored AS (
  SELECT engine_key, n_current, n_prior, current_runs, current_dates, cur_value, prior_value,
         CASE WHEN prior_value IS NULL OR cur_value IS NULL THEN NULL ELSE ${change("cur_value", "prior_value")} END AS change_value
    FROM pair
), breached AS (
  SELECT r.engine_key, (count(*))::int AS runs_breached
    FROM runs r
    JOIN scored s ON s.engine_key = r.engine_key
   WHERE r.bucket = 0
     AND s.prior_value IS NOT NULL
     ${priorGuard}
     AND ${change(v("r"), "s.prior_value")} >= $6::float8 - ${THRESHOLD_EPSILON}
   GROUP BY r.engine_key
), dates_breached AS (
  SELECT d.engine_key, (count(*))::int AS dates_breached
    FROM rundates d
    JOIN scored s ON s.engine_key = d.engine_key
   WHERE d.bucket = 0
     AND s.prior_value IS NOT NULL
     ${priorGuard}
     AND ${change(v("d"), "s.prior_value")} >= $6::float8 - ${THRESHOLD_EPSILON}
   GROUP BY d.engine_key
)
SELECT s.engine_key, s.n_current, s.n_prior, s.cur_value, s.prior_value, s.change_value
  FROM scored s
  LEFT JOIN breached y ON y.engine_key = s.engine_key
  LEFT JOIN dates_breached z ON z.engine_key = s.engine_key
 WHERE s.n_current >= $5::float8
   AND s.n_prior   >= $5::float8
   AND s.cur_value IS NOT NULL
   AND s.prior_value IS NOT NULL
   AND s.current_runs >= 2
   ${priorGuard}
   AND s.change_value >= $6::float8 - ${THRESHOLD_EPSILON}
   AND COALESCE(y.runs_breached, 0) >= LEAST($7::int, s.current_runs)
   AND COALESCE(z.dates_breached, 0) >= LEAST($7::int, s.current_dates)
 ORDER BY s.engine_key`;
  return { text, values };
}
