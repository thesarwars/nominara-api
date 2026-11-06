import { MEASURED_IMPACT_CAVEAT, type MeasuredImpact } from "../../../contracts/tasks/task-verification.schema.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { visibilityDelta } from "../scoring/visibility.js";

// STORY-067 - impact attribution (`scoring-models.md` section 13). PURE: no I/O, no clock. The rows it reads and the milestone counts
// come from `verification-measure.ts`; everything that decides a number or a label is here, where it can be tested without a database.
//
//   visibility_before = mean VisibilityScore over [T-14d, T)      visibility_after = mean over (T, T+14d]
//   delta             = visibility_after - visibility_before
//
// ALIGNED WINDOWS. Both windows are `windowDays` whole workspace-local days (the rollup's `metric_date`s), one either side of the
// completion DAY. That day is in neither: it is part work, part not, and counting it on either side would let the completion itself
// colour the before or the after.
//
// NO DELTA ON A THIN SAMPLE. The sample floor is the one the rest of the product uses (`scoring-models.md` section 3, NFR-ANL-03): a
// window under 30 measured cells yields NO delta - not 0, and not a delta with a wide interval. This function asks `visibilityDelta`
// rather than restating that floor, so the two cannot drift.
//
// "MEASURED CELLS" are `metric_daily.cells_total`. A day with no measured cells is a GAP, not a zero (NFR-ANL-06: a metric we did not
// measure is never interpolated), so it contributes to neither a mean nor the sample.

/** One day of the project's all-engine Visibility Score (`metric_daily`, `engine_key = 'all'`, the brand entity). */
export interface DayPoint {
  /** `YYYY-MM-DD`, workspace-local. */
  readonly date: string;
  readonly score: number;
  /** `cells_total`: the measured cells behind the day's score. */
  readonly cells: number;
}

export interface WindowDates {
  readonly from: string;
  readonly to: string;
}

const DAY_MS = 86_400_000;

export function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(day) + by * DAY_MS).toISOString().slice(0, 10);
}

/** The two aligned windows around a completion day, both ends inclusive: `windowDays` days before it and `windowDays` days after. */
export function impactWindowDates(completionDay: string, windowDays: number): { readonly before: WindowDates; readonly after: WindowDates } {
  return {
    before: { from: shiftDay(completionDay, -windowDays), to: shiftDay(completionDay, -1) },
    after: { from: shiftDay(completionDay, 1), to: shiftDay(completionDay, windowDays) },
  };
}

export type Confidence = MeasuredImpact["confidence"];

/**
 * The label, from `scoring-models.md` section 13:
 *
 *   high   - the separation is clear and NO other milestone falls in [T-7d, T+7d]
 *   medium - the separation is clear and at most ONE other milestone falls in the window
 *   low    - otherwise
 *
 * THE LABEL NEVER LOOKS AT THE SIZE OF THE DELTA. That is the point (STORY-067 AC5): two changes in one window means the delta belongs
 * to both or to neither, and calling it high because it is large is the overclaim the product is positioned against.
 *
 * ONE DEVIATION FROM THE LETTER, in the conservative direction: two or more others anywhere in the window is `low`. The reference as
 * written would call a milestone high with five others at day 8 to 14 (none within 7 days), which is not "several changes nearby is
 * low" (the story's AC5). This label is never higher than the reference's, only ever equal or lower.
 * OWNER DECISION 65a/b: confidence is low with 2 or more nearby milestones, and clear separation is a Welch test at 1.96 SE with at least
 * 2 days per window.
 */
export function impactConfidence(input: {
  readonly clearSeparation: boolean;
  readonly otherMilestonesWithin7d: number;
  readonly otherMilestonesInWindow: number;
}): Confidence {
  if (!input.clearSeparation) return "low";
  if (input.otherMilestonesInWindow > 1) return "low";
  // At most one other in the window from here on: `high` if it is not within 7 days of the completion, `medium` if it is.
  return input.otherMilestonesWithin7d === 0 ? "high" : "medium";
}

/**
 * Whether the two windows separate: the delta exceeds 1.96 standard errors of the difference of the two means (Welch), taken over the
 * windows' own daily scores. ABSENT FROM THE REFERENCE, which says "clear" without defining it - this is the builder's reading, and
 * the owner decides it. Fewer than two measured days in a window gives no variance to judge by, so it is not clear.
 */
function separationIsClear(before: readonly DayPoint[], after: readonly DayPoint[], delta: number): boolean {
  if (before.length < 2 || after.length < 2 || delta === 0) return false;
  const se = Math.sqrt(sampleVariance(before) / before.length + sampleVariance(after) / after.length);
  return Math.abs(delta) > 1.96 * se;
}

function sampleVariance(points: readonly DayPoint[]): number {
  const mean = points.reduce((sum, p) => sum + p.score, 0) / points.length;
  return points.reduce((sum, p) => sum + (p.score - mean) ** 2, 0) / (points.length - 1);
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export type ImpactResult =
  | { readonly status: "measured"; readonly impact: MeasuredImpact }
  | { readonly status: "insufficient_sample"; readonly n_before: number; readonly n_after: number };

/** The method string written beside every impact, so a later method is distinguishable from this one. */
export const IMPACT_METHOD = "metric_daily_window_mean_v1";

export function computeImpact(input: {
  readonly before: readonly DayPoint[];
  readonly after: readonly DayPoint[];
  readonly windowDays: number;
  readonly otherMilestonesWithin7d: number;
  readonly otherMilestonesInWindow: number;
}): ImpactResult {
  const before = input.before.filter((p) => p.cells > 0);
  const after = input.after.filter((p) => p.cells > 0);
  const nBefore = before.reduce((sum, p) => sum + p.cells, 0);
  const nAfter = after.reduce((sum, p) => sum + p.cells, 0);
  const mean = (points: readonly DayPoint[]): number | null => (points.length === 0 ? null : points.reduce((sum, p) => sum + p.score, 0) / points.length);
  const beforeMean = mean(before);
  const afterMean = mean(after);

  // `visibilityDelta` is the one definition of "enough": null when either side has no score or under 30 cells.
  const rawDelta = visibilityDelta({ score: afterMean, measuredCells: nAfter }, { score: beforeMean, measuredCells: nBefore });
  if (rawDelta === null || beforeMean === null || afterMean === null) {
    return { status: "insufficient_sample", n_before: nBefore, n_after: nAfter };
  }

  const visibilityBefore = round3(beforeMean);
  const visibilityAfter = round3(afterMean);
  return {
    status: "measured",
    impact: {
      visibility_before: visibilityBefore,
      visibility_after_14d: visibilityAfter,
      delta: round3(visibilityAfter - visibilityBefore),
      window_days: input.windowDays,
      confidence: impactConfidence({
        clearSeparation: separationIsClear(before, after, rawDelta),
        otherMilestonesWithin7d: input.otherMilestonesWithin7d,
        otherMilestonesInWindow: input.otherMilestonesInWindow,
      }),
      method: IMPACT_METHOD,
      scoring_version: SCORING_VERSION,
      caveat: MEASURED_IMPACT_CAVEAT,
      n_before: nBefore,
      n_after: nAfter,
      other_milestones_nearby: input.otherMilestonesInWindow,
    },
  };
}
