import type { DayAggregate } from "../rollup/aggregate-day.js";
import {
  blendAcrossEngines,
  confidenceFor,
  confidenceHalfWidth,
  visibilityDelta,
  visibilityScore,
  type Confidence,
} from "../scoring/index.js";

// STORY-136 — one window's facts become one scorecard entry.
//
// ⚠ THIS IS NOT `toMetricRow`, AND THE DIFFERENCE IS THE POINT.
//
// `roll-up-day.ts` coalesces four ratios to `0` before writing them, because
// `metric_daily` declares them `NOT NULL DEFAULT 0`. That is survivable for a
// storage row nothing reads back; it is NOT survivable on the wire. A window
// with cells and no citations would publish `citation_share: 0`, which reads
// as "cited, and none of them were mine" rather than "nothing cited
// anything" — the null-as-zero conflation the corpus names as one of the two
// highest-risk correctness bugs in the product, and the exact thing
// STORY-090 AC5 forbids the screen from rendering.
//
// So NOTHING HERE COALESCES. Every ratio is null when its denominator is
// zero, and stays null all the way to the client.

/** A ratio, or null when its denominator is zero. Never a zero standing in for "no data". */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export interface WindowMetrics {
  /** §3 — `PresenceRate(T)` in [0,1]. */
  readonly presenceRate: number | null;
  /** §2.3 — `SoV(b, T)` in [0,1]. */
  readonly shareOfVoice: number | null;
  /** §6 — `SentimentScore(T)` in [0,100]. */
  readonly sentimentScore: number | null;
  /** §4 — owned share of the cited corpus, position-weighted, in [0,1]. */
  readonly citationShare: number | null;
  /** §8 — in [0,100], over attribute-capable engines only. */
  readonly renderingQuality: number | null;
  readonly cellsTotal: number;
  readonly cellsPresent: number;
  readonly mentionsTotal: number;
  readonly citationsTotal: number;
  readonly citationsOwned: number;
}

/**
 * The window's components, from the window's own counts.
 *
 * Every formula is the one `toMetricRow` uses, minus the coalescing. They
 * agree by construction on any window where nothing is null, which is what
 * makes a daily rollup and a one-day scorecard the same number.
 */
export function toWindowMetrics(aggregate: DayAggregate): WindowMetrics {
  // §6 — `50 · (raw + 1)`, prominence-weighted. Null when there is nothing to
  // weight: on a 0–100 scale, 0 is maximally negative, not "no data".
  const sentimentRaw = ratio(aggregate.sentWeighted, aggregate.prominenceSum);
  // §8 — prominence-weighted rendering, over attribute-capable engines only.
  const renderingRaw = ratio(aggregate.renderWeighted, aggregate.renderWeightTotal);

  return {
    presenceRate: ratio(aggregate.cellsPresent, aggregate.cellsTotal),
    shareOfVoice: ratio(aggregate.sovWeighted, aggregate.weightTotal),
    sentimentScore: sentimentRaw === null ? null : 50 * (sentimentRaw + 1),
    citationShare: ratio(aggregate.citationOwnedPositionWeight, aggregate.citationPositionWeightTotal),
    renderingQuality: aggregate.renderMentionRows === 0 || renderingRaw === null ? null : 100 * renderingRaw,
    cellsTotal: aggregate.cellsTotal,
    cellsPresent: aggregate.cellsPresent,
    mentionsTotal: aggregate.mentionsTotal,
    citationsTotal: aggregate.citationsTotal,
    citationsOwned: aggregate.citationsOwned,
  };
}

/** A window with no facts at all — every ratio null, every count zero. */
export const EMPTY_WINDOW_METRICS: WindowMetrics = Object.freeze({
  presenceRate: null,
  shareOfVoice: null,
  sentimentScore: null,
  citationShare: null,
  renderingQuality: null,
  cellsTotal: 0,
  cellsPresent: 0,
  mentionsTotal: 0,
  citationsTotal: 0,
  citationsOwned: 0,
});

export interface Scorecard {
  readonly engineKey: string;
  readonly visibilityScore: number | null;
  readonly visibilityDelta: number | null;
  readonly confidence: Confidence;
  readonly confidenceHalfWidth: number | null;
  readonly measuredCells: number;
  readonly metrics: WindowMetrics;
}

/**
 * One engine's entry, current window against the prior aligned one.
 *
 * The delta comes from `visibilityDelta`, which returns NULL when either
 * window has fewer than 30 measured cells — `NFR-ANL-03`, and §3's rule for
 * the delta specifically. A zero delta is a claim that nothing changed, and
 * on a four-cell project it is a claim nobody is entitled to make.
 */
export function toScorecard(engineKey: string, current: WindowMetrics, prior: WindowMetrics): Scorecard {
  const score = visibilityScore({
    presenceRate: current.presenceRate,
    shareOfVoice: current.shareOfVoice,
    citationShare: current.citationShare,
    sentimentScore: current.sentimentScore,
  });
  const priorScore = visibilityScore({
    presenceRate: prior.presenceRate,
    shareOfVoice: prior.shareOfVoice,
    citationShare: prior.citationShare,
    sentimentScore: prior.sentimentScore,
  });

  return {
    engineKey,
    visibilityScore: score,
    visibilityDelta: visibilityDelta(
      { score, measuredCells: current.cellsTotal },
      { score: priorScore, measuredCells: prior.cellsTotal },
    ),
    confidence: confidenceFor(current.cellsTotal),
    confidenceHalfWidth: confidenceHalfWidth(current.presenceRate, current.cellsTotal),
    measuredCells: current.cellsTotal,
    metrics: current,
  };
}

/** `all` — §3's cross-engine key, the same one the rollup's second pass writes. */
export const BLENDED_KEY = "all";

/**
 * §3 — `VisibilityScore(T, all) = Σ_e w_e · VisibilityScore(T, e) / Σ_e w_e`.
 *
 * ⚠ BLENDED FROM THE WINDOW'S PER-ENGINE SCORES, never re-aggregated from
 * `metric_daily`'s `engine_key='all'` rows. Those are a weighted mean whose
 * denominator (`Σ_e w_e · cells_e`) is not stored, so re-weighting them
 * across days is impossible without assuming every engine weighs the same.
 * This is the same function the rollup's second pass calls and needs nothing
 * that was thrown away.
 *
 * The COUNTS are summed rather than blended: the blend's `measured_cells` is
 * how many cells stand behind it — STORY-090 AC3's "the cell count behind
 * it" — and a weighted mean of counts is not a count of anything.
 */
export function blendScorecards(
  entries: readonly { readonly scorecard: Scorecard; readonly weight: number }[],
  priorEntries: readonly { readonly scorecard: Scorecard; readonly weight: number }[],
): Scorecard {
  const sum = (of: (m: WindowMetrics) => number): number =>
    entries.reduce((total, entry) => total + of(entry.scorecard.metrics), 0);

  const cellsTotal = sum((m) => m.cellsTotal);
  const cellsPresent = sum((m) => m.cellsPresent);
  const citationsTotal = sum((m) => m.citationsTotal);
  const citationsOwned = sum((m) => m.citationsOwned);
  const priorCells = priorEntries.reduce((total, entry) => total + entry.scorecard.metrics.cellsTotal, 0);

  const score = blendAcrossEngines(
    entries.map((entry) => ({ score: entry.scorecard.visibilityScore, engineWeight: entry.weight })),
  );
  const priorScore = blendAcrossEngines(
    priorEntries.map((entry) => ({ score: entry.scorecard.visibilityScore, engineWeight: entry.weight })),
  );

  // The blend's own components are weighted the same way as its score, over
  // the engines that HAVE each one. Averaging a null in at zero would drag
  // the blended figure toward "measured, and terrible" — the rollup's
  // second pass makes the same choice for the same reason.
  const weightedMean = (of: (m: WindowMetrics) => number | null): number | null => {
    const present = entries.filter((entry) => of(entry.scorecard.metrics) !== null);
    const weightTotal = present.reduce((total, entry) => total + entry.weight, 0);
    if (present.length === 0 || weightTotal === 0) return null;
    return present.reduce((total, entry) => total + entry.weight * of(entry.scorecard.metrics)!, 0) / weightTotal;
  };

  const presenceRate = ratio(cellsPresent, cellsTotal);

  return {
    engineKey: BLENDED_KEY,
    visibilityScore: score,
    visibilityDelta: visibilityDelta(
      { score, measuredCells: cellsTotal },
      { score: priorScore, measuredCells: priorCells },
    ),
    confidence: confidenceFor(cellsTotal),
    confidenceHalfWidth: confidenceHalfWidth(presenceRate, cellsTotal),
    measuredCells: cellsTotal,
    metrics: {
      presenceRate,
      shareOfVoice: weightedMean((m) => m.shareOfVoice),
      sentimentScore: weightedMean((m) => m.sentimentScore),
      citationShare: weightedMean((m) => m.citationShare),
      renderingQuality: weightedMean((m) => m.renderingQuality),
      cellsTotal,
      cellsPresent,
      mentionsTotal: sum((m) => m.mentionsTotal),
      citationsTotal,
      citationsOwned,
    },
  };
}
