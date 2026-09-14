import type { GrowthMapPoint, GrowthMapSeries, DataGap } from "../../../contracts/analytics/index.js";

// STORY-137 — turning `metric_daily` rows into §7's series.
//
// THE CHART IS THE ONE PLACE `metric_daily` IS THE RIGHT SOURCE. STORY-136's
// window aggregate reads the facts because §3 defines its components over
// `C(T)` and a window rate is not the mean of daily rates. A chart plots
// exactly what the rollup stores: one point per day, already computed by the
// scoring library on that day's cells. Re-deriving ninety days from the
// facts would be the same numbers at ninety times the cost.

/** One day of one entity's `engine_key='all'` row. */
export interface DailySeriesRow {
  readonly entityId: string;
  readonly metricDate: string;
  readonly visibilityScore: number;
  readonly sov: number;
  readonly cellsTotal: number;
  readonly liveCaptureRatio: number;
}

/**
 * Every calendar day in the window, inclusive, so a gap has a point to be
 * null on.
 *
 * UTC ARITHMETIC ON A BARE DATE, built with `Date.UTC` from the parts rather
 * than by parsing an ISO string. Two reasons: parsing a bare `YYYY-MM-DD` as
 * local time would shift the whole window by a day for anyone east of
 * Greenwich, and a template that interpolated the date into a colon-bearing
 * string reads to the ISO-13 scanner as a cache-key construction site — the
 * same false positive STORY-042 hit. The date STRINGS were already resolved
 * in the project's timezone by the caller; from here they are calendar
 * labels, not instants.
 */
export function calendarDays(from: string, to: string): string[] {
  const days: string[] = [];
  const start = utcMidnight(from);
  const end = utcMidnight(to);
  for (let at = start; at <= end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

function utcMidnight(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!);
}

/**
 * One entity's points across the window.
 *
 * ⚠ A DAY WITH NO ROW IS A NULL POINT, NOT A MISSING ONE AND NOT A ZERO.
 * §7: "a day with `cells_total = 0` is `null` in `points` and appears in
 * `annotations.data_gaps` — it is never interpolated." Zero would draw the
 * brand's visibility collapsing to nothing on a day nobody measured; a
 * missing entry would let a renderer join the two neighbours and draw a
 * straight line through it, which is the same lie with a smoother curve.
 */
export function pointsFor(days: readonly string[], rows: readonly DailySeriesRow[]): GrowthMapPoint[] {
  const byDate = new Map(rows.map((row) => [row.metricDate, row]));
  return days.map((d) => {
    const row = byDate.get(d);
    return row === undefined
      ? { d, visibility_score: null, sov: null, cells: 0, live_ratio: null }
      : {
          d,
          visibility_score: row.visibilityScore,
          sov: row.sov,
          cells: row.cellsTotal,
          live_ratio: row.liveCaptureRatio,
        };
  });
}

/**
 * §7's `competitor_baseline` — THE MEDIAN, not the mean.
 *
 * A mean is dragged by one outlier, and the competitor set routinely
 * contains one: a category giant whose visibility is an order of magnitude
 * above the rest. A baseline the brand is compared against has to represent
 * the typical competitor, and on a skewed set the mean represents nobody.
 *
 * NULL WHERE NO COMPETITOR HAS A VALUE that day — the baseline is subject to
 * the same gap rule as any other series and is not carried across.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The baseline series, from the competitor series already built.
 *
 * Built from the SERIES rather than from the rows so it cannot disagree with
 * what is plotted: if a competitor's day is a gap, it is absent from the
 * median for that day too.
 */
export function baselinePoints(days: readonly string[], competitors: readonly GrowthMapSeries[]): GrowthMapPoint[] {
  return days.map((d, index) => {
    const values = competitors
      .map((series) => series.points[index]?.visibility_score)
      .filter((value): value is number => value !== null && value !== undefined);
    const sovValues = competitors
      .map((series) => series.points[index]?.sov)
      .filter((value): value is number => value !== null && value !== undefined);
    const cells = competitors.reduce((total, series) => total + (series.points[index]?.cells ?? 0), 0);
    return { d, visibility_score: median(values), sov: median(sovValues), cells, live_ratio: null };
  });
}

/** A day on which an engine failed, for naming the reason behind a gap. */
export interface FailureDay {
  readonly metricDate: string;
  readonly engineKey: string;
}

/**
 * §7's `data_gaps`, as CONTIGUOUS RANGES rather than one entry per day.
 *
 * A ninety-day chart on a paused project would otherwise carry ninety
 * annotations, which is a wall of text where the finding is "this stopped in
 * June". §7's own example is a two-day range for the same reason.
 *
 * The reason is derived, not assumed: a day on which some engine returned a
 * failure is `engine_unavailable` and NAMES those engines; a day with no
 * capture attempt at all is `no_capture`. Reporting the first for both would
 * blame an outage for a project nobody scheduled.
 */
export function dataGaps(points: readonly GrowthMapPoint[], failures: readonly FailureDay[]): DataGap[] {
  const failedEnginesByDate = new Map<string, Set<string>>();
  for (const failure of failures) {
    const set = failedEnginesByDate.get(failure.metricDate) ?? new Set<string>();
    set.add(failure.engineKey);
    failedEnginesByDate.set(failure.metricDate, set);
  }

  const gaps: DataGap[] = [];
  let open: DataGap | null = null;

  for (const point of points) {
    if (point.visibility_score !== null) {
      if (open !== null) gaps.push(open);
      open = null;
      continue;
    }
    const failed = failedEnginesByDate.get(point.d);
    const reason: DataGap["reason"] = failed === undefined ? "no_capture" : "engine_unavailable";
    const engines = failed === undefined ? [] : [...failed].sort();

    // A run of days only merges while the REASON matches. A day the engines
    // were down and a day nothing was scheduled are different findings, and
    // merging them would attribute the whole stretch to whichever came first.
    if (open !== null && open.reason === reason && sameEngines(open.engines, engines)) {
      open = { from: open.from, to: point.d, reason: open.reason, engines: open.engines };
    } else {
      if (open !== null) gaps.push(open);
      open = { from: point.d, to: point.d, reason, engines };
    }
  }
  if (open !== null) gaps.push(open);
  return gaps;
}

function sameEngines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((engine, index) => engine === right[index]);
}

/** The first and last day that actually carry a score — the ends of the summary. */
export function firstAndLastScored(points: readonly GrowthMapPoint[]): { start: number | null; end: number | null } {
  const scored = points.filter((point) => point.visibility_score !== null);
  return {
    start: scored[0]?.visibility_score ?? null,
    end: scored[scored.length - 1]?.visibility_score ?? null,
  };
}
