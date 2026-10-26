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

// ───────────────────────── STORY-066 — the series contract ─────────────────────────

/** One `>90d` bucket: seven calendar days (the first may be shorter), labelled by its first day. */
export interface WeekBucket {
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly days: readonly string[];
}

/**
 * §13 — `>90d → week`. Seven-day buckets that END ON THE WINDOW'S LAST DAY,
 * so the most recent bucket is always a whole week and today is in it; the
 * first bucket takes the remainder and may be shorter.
 */
export function weekBuckets(days: readonly string[]): WeekBucket[] {
  const buckets: WeekBucket[] = [];
  for (let end = days.length; end > 0; end -= 7) {
    const slice = days.slice(Math.max(0, end - 7), end);
    buckets.unshift({ label: slice[0]!, start: slice[0]!, end: slice[slice.length - 1]!, days: slice });
  }
  return buckets;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * §13 / AC2 — a week is THE MEAN OF ITS DAILY VALUES, never a resampled last
 * value. A last-value resample plots whichever day happened to close the
 * bucket, so one good or bad Sunday becomes the whole week.
 *
 * Only MEASURED days enter the mean: a null day is a gap, not a zero, and a
 * week with no measured day is null with zero cells — never carried across.
 * `points` must be the daily points over exactly the buckets' days, in order.
 */
export function resampleWeekly(buckets: readonly WeekBucket[], points: readonly GrowthMapPoint[]): GrowthMapPoint[] {
  const byDay = new Map(points.map((point) => [point.d, point]));
  return buckets.map((bucket) => {
    const measured = bucket.days
      .map((d) => byDay.get(d))
      .filter((point): point is GrowthMapPoint => point !== undefined && point.visibility_score !== null);
    if (measured.length === 0) return { d: bucket.label, visibility_score: null, sov: null, cells: 0, live_ratio: null };
    return {
      d: bucket.label,
      visibility_score: mean(measured.map((point) => point.visibility_score!)),
      sov: mean(measured.map((point) => point.sov).filter((value): value is number => value !== null)),
      cells: measured.reduce((total, point) => total + point.cells, 0),
      live_ratio: mean(measured.map((point) => point.live_ratio).filter((value): value is number => value !== null)),
    };
  });
}

/** The bucket a day falls in, by label. */
function bucketLabelOf(buckets: readonly WeekBucket[], day: string): string | undefined {
  return buckets.find((bucket) => day >= bucket.start && day <= bucket.end)?.label;
}

/** Failure days re-keyed to their week's label, so `dataGaps` can name the engines behind a missing week. */
export function bucketFailures(failures: readonly FailureDay[], buckets: readonly WeekBucket[]): FailureDay[] {
  return failures.flatMap((failure) => {
    const label = bucketLabelOf(buckets, failure.metricDate);
    return label === undefined ? [] : [{ metricDate: label, engineKey: failure.engineKey }];
  });
}

/** A weekly gap's `to` is the LAST DAY of its last bucket, not that bucket's label — the gap covers the whole week. */
export function extendGapsToBucketEnds(gaps: readonly DataGap[], buckets: readonly WeekBucket[]): DataGap[] {
  const endOf = new Map(buckets.map((bucket) => [bucket.label, bucket.end]));
  return gaps.map((gap) => ({ ...gap, to: endOf.get(gap.to) ?? gap.to }));
}

/** A week's label for any day in it (the day itself when it is in no bucket). */
export function weekLabelFor(buckets: readonly WeekBucket[], day: string): string {
  return bucketLabelOf(buckets, day) ?? day;
}

const HOUR_MS = 3_600_000;

/** The UTC instant an hour starts, as §7's `d` label: `YYYY-MM-DDTHH:00:00Z`. */
export function hourLabel(at: number): string {
  // Floored to the hour, so the milliseconds are always `.000`; dropping them
  // gives the label without building a colon-bearing template (see `calendarDays`).
  return new Date(Math.floor(at / HOUR_MS) * HOUR_MS).toISOString().replace(".000Z", "Z");
}

/**
 * §13 — `24h → hour`: the 24 UTC hours ending with the current one.
 *
 * INSTANTS, not wall-clock hours: on the night the clocks go back a local
 * 01:00 happens twice, and two points with one label would be drawn on top of
 * each other.
 */
export function hourBuckets(now: number): string[] {
  const current = Math.floor(now / HOUR_MS) * HOUR_MS;
  return Array.from({ length: 24 }, (_, index) => hourLabel(current - (23 - index) * HOUR_MS));
}

/** `projects.cadence`'s CHECK — the only words the trigger can write. */
const CADENCES = "hourly|daily|twice_weekly|weekly|manual";
const CADENCE_CHANGE = new RegExp(`^(${CADENCES}) to (${CADENCES})$`, "u");

/**
 * AC5 — reads `app.record_cadence_change()`'s own `format('%s to %s', OLD, NEW)`
 * detail (migration 0017). STRICT: anything that is not exactly two known
 * cadences around " to " is not a cadence change, and returns null rather
 * than a guess. A wrong annotation explains a trend break that did not
 * happen, which is worse than none.
 */
export function parseCadenceChange(detail: string | null): { from: string; to: string } | null {
  const match = detail === null ? null : CADENCE_CHANGE.exec(detail);
  if (match === null || match[1] === match[2]) return null;
  return { from: match[1]!, to: match[2]! };
}

/** A `metric_daily` row with the scoring version it was computed under. */
export interface VersionedSeriesRow extends DailySeriesRow {
  readonly scoringVersion: string;
  /** `computed_at`, epoch ms — which of two older versions is the more recent. */
  readonly computedAt: number;
}

/**
 * AC12 — ONE row per (entity, day): the current scoring version where the day
 * has it, otherwise the most recently computed older version.
 *
 * A series filtered to the current version alone would draw everything before
 * a cut-over as a gap, although it was measured — and history past raw-capture
 * retention can never be re-scored. Plotting the older figure and MARKING THE
 * BOUNDARY (`versionChanges`) keeps both facts on the chart.
 */
export function pickScoringVersion<Row extends VersionedSeriesRow>(rows: readonly Row[], current: string): Row[] {
  const picked = new Map<string, Row>();
  for (const row of rows) {
    const key = `${row.entityId}|${row.metricDate}`;
    const held = picked.get(key);
    if (held === undefined) {
      picked.set(key, row);
      continue;
    }
    const heldCurrent = held.scoringVersion === current;
    const rowCurrent = row.scoringVersion === current;
    if (rowCurrent && !heldCurrent) picked.set(key, row);
    else if (rowCurrent === heldCurrent && row.computedAt > held.computedAt) picked.set(key, row);
  }
  return [...picked.values()];
}

/**
 * AC12 — every change of scoring version between consecutive MEASURED
 * buckets; `at` is the first bucket under the new version. A null (unmeasured)
 * bucket is skipped, so a gap between two versions still marks the change.
 */
export function versionChanges(labels: readonly string[], versions: readonly (string | null)[]): { at: string; from: string; to: string }[] {
  const changes: { at: string; from: string; to: string }[] = [];
  let previous: string | null = null;
  labels.forEach((label, index) => {
    const version = versions[index] ?? null;
    if (version === null) return;
    if (previous !== null && version !== previous) changes.push({ at: label, from: previous, to: version });
    previous = version;
  });
  return changes;
}

/** §13 — `prompt_set_change`: "≥ 10% of the prompt set added or removed in one day". */
export const PROMPT_SET_CHANGE_THRESHOLD = 0.1;

/**
 * Whether one day's additions and removals are a material change to the set
 * that existed at its start. A project's FIRST prompt set (nothing before) is
 * not a change to anything. Division rather than `before * 0.1`: the product
 * of an integer and 0.1 can land just above the true value (30 × 0.1 =
 * 3.0000000000000004) and miss an exact 10 %.
 */
export function isMaterialPromptSetChange(change: { before: number; added: number; removed: number }): boolean {
  if (change.before <= 0) return false;
  return (change.added + change.removed) / change.before >= PROMPT_SET_CHANGE_THRESHOLD;
}

/**
 * `engine_model_change` — one transition per change of the vendor-reported
 * fingerprint, in capture order. `previous` is the last fingerprint seen
 * before these captures; with none, the first one seen is where tracking
 * starts, not a change.
 */
export function fingerprintTransitions(
  previous: string | null,
  captures: readonly { fingerprint: string; at: Date }[],
): { from: string; to: string; at: Date }[] {
  const transitions: { from: string; to: string; at: Date }[] = [];
  let current = previous;
  for (const capture of captures) {
    if (current !== null && capture.fingerprint !== current) transitions.push({ from: current, to: capture.fingerprint, at: capture.at });
    current = capture.fingerprint;
  }
  return transitions;
}
