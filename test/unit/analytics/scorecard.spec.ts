import { describe, expect, it } from "vitest";
import {
  blendScorecards,
  BLENDED_KEY,
  EMPTY_WINDOW_METRICS,
  toScorecard,
  toWindowMetrics,
  type Scorecard,
  type WindowMetrics,
} from "../../../src/lib/analytics/scorecard.js";
import { blendAcrossEngines, DEFAULT_VISIBILITY_WEIGHTS, visibilityScore } from "../../../src/lib/scoring/index.js";
import type { DayAggregate } from "../../../src/lib/rollup/aggregate-day.js";

// STORY-136 — the window aggregation, where the null-as-zero bug would live
// if it lived anywhere.

function aggregate(over: Partial<DayAggregate> = {}): DayAggregate {
  return {
    engineKey: "chatgpt",
    entityType: "brand",
    entityId: "11111111-1111-4111-8111-111111111111",
    cellsTotal: 100,
    cellsPresent: 60,
    liveCells: 100,
    sovWeighted: 30,
    weightTotal: 100,
    prominenceSum: 40,
    mentionRows: 50,
    rankSum: 100,
    rankRows: 50,
    mentionsTotal: 50,
    mentionsPositive: 30,
    mentionsNeutral: 15,
    mentionsNegative: 5,
    sentWeighted: 20,
    citationsTotal: 10,
    citationsOwned: 4,
    citationOwnedPositionWeight: 2,
    citationPositionWeightTotal: 8,
    renderWeighted: 12,
    renderWeightTotal: 40,
    renderMentionRows: 20,
    ...over,
  };
}

function metrics(over: Partial<WindowMetrics> = {}): WindowMetrics {
  return { ...toWindowMetrics(aggregate()), ...over };
}

/**
 * Build from the AGGREGATE, not by patching the metrics.
 *
 * `metrics({ cellsPresent: 90 })` changes the count and leaves `presenceRate`
 * at the base fixture's value, so three "different" engines score
 * identically and a test that means to compare a weighted blend against a
 * plain mean compares two equal numbers and passes for the wrong reason.
 * Overriding the counts the ratio is derived from is the only way to move it.
 */
function windowFrom(over: Partial<DayAggregate>): WindowMetrics {
  return toWindowMetrics(aggregate(over));
}

describe("STORY-136 · toWindowMetrics — nothing coalesces", () => {
  it("derives every ratio from the window's own counts", () => {
    const m = toWindowMetrics(aggregate());
    expect(m.presenceRate).toBeCloseTo(0.6, 12);
    expect(m.shareOfVoice).toBeCloseTo(0.3, 12);
    expect(m.citationShare).toBeCloseTo(0.25, 12);
    // §6 — 50 · (20/40 + 1)
    expect(m.sentimentScore).toBeCloseTo(75, 12);
    // §8 — 100 · 12/40
    expect(m.renderingQuality).toBeCloseTo(30, 12);
  });

  it("scenario 2 — a window with cells and NO citations has a null citation share, not 0", () => {
    // 0 means "cited, and none of them were mine". Null means nothing cited
    // anything. `metric_daily.citation_share` stores 0 for both, which is
    // exactly why this reads the counts instead.
    const m = toWindowMetrics(aggregate({ citationsTotal: 0, citationOwnedPositionWeight: 0, citationPositionWeightTotal: 0 }));
    expect(m.citationShare).toBeNull();
  });

  it("keeps a MEASURED zero citation share as zero", () => {
    const m = toWindowMetrics(aggregate({ citationOwnedPositionWeight: 0, citationPositionWeightTotal: 8 }));
    expect(m.citationShare).toBe(0);
  });

  it("scenario 3 — a window with no mentions has a null sentiment, not 0", () => {
    // On a 0–100 scale, 0 is MAXIMALLY NEGATIVE. A project nobody discussed
    // would be published as the worst-regarded brand in the product.
    const m = toWindowMetrics(aggregate({ mentionsTotal: 0, prominenceSum: 0, sentWeighted: 0 }));
    expect(m.sentimentScore).toBeNull();
  });

  it("scenario 4 — an attribute-incapable engine has a null rendering quality", () => {
    const m = toWindowMetrics(aggregate({ renderMentionRows: 0, renderWeighted: 0, renderWeightTotal: 0 }));
    expect(m.renderingQuality).toBeNull();
  });

  it("has a null presence rate when nothing was measured, and 0 when everything was absent", () => {
    expect(toWindowMetrics(aggregate({ cellsTotal: 0, cellsPresent: 0 })).presenceRate).toBeNull();
    expect(toWindowMetrics(aggregate({ cellsPresent: 0 })).presenceRate).toBe(0);
  });

  it("scenario 1 — the window rate is Σpresent/Σtotal, NOT the mean of the daily rates", () => {
    // Two days: 90/100 and 1/10. The mean of the rates is 0.95; the window
    // rate is 91/110 = 0.827…. `aggregateRange` returns the summed counts, so
    // this function cannot produce the wrong one — the test pins the counts
    // it is handed and the arithmetic that follows.
    const windowed = toWindowMetrics(aggregate({ cellsTotal: 110, cellsPresent: 91 }));
    expect(windowed.presenceRate).toBeCloseTo(91 / 110, 12);
    expect(windowed.presenceRate).not.toBeCloseTo((0.9 + 0.1) / 2, 3);
  });
});

describe("STORY-136 · toScorecard", () => {
  it("scores the window through the shared library, to the last digit", () => {
    const current = metrics();
    const card = toScorecard("chatgpt", current, EMPTY_WINDOW_METRICS);
    expect(card.visibilityScore).toBe(
      visibilityScore(
        {
          presenceRate: current.presenceRate,
          shareOfVoice: current.shareOfVoice,
          citationShare: current.citationShare,
          sentimentScore: current.sentimentScore,
        },
        DEFAULT_VISIBILITY_WEIGHTS,
      ),
    );
  });

  it("scenario 5 — a delta is NULL when the current window is under 30 cells", () => {
    const card = toScorecard("chatgpt", metrics({ cellsTotal: 29, cellsPresent: 20 }), metrics());
    expect(card.visibilityDelta).toBeNull();
    expect(card.confidence).toBe("low");
  });

  it("scenario 6 — a delta is NULL when the PRIOR window is under 30 cells", () => {
    const card = toScorecard("chatgpt", metrics(), metrics({ cellsTotal: 29, cellsPresent: 20 }));
    expect(card.visibilityDelta).toBeNull();
  });

  it("scenario 7 — both windows at 30+ cells give the difference of the two scores", () => {
    const current = windowFrom({});
    const prior = windowFrom({ cellsPresent: 30 });
    const card = toScorecard("chatgpt", current, prior);
    expect(card.visibilityDelta).not.toBeNull();
    expect(card.visibilityDelta).toBeGreaterThan(0);
  });

  it("bands confidence at §3's thresholds and reports the Wald half-width", () => {
    expect(toScorecard("e", metrics({ cellsTotal: 29 }), EMPTY_WINDOW_METRICS).confidence).toBe("low");
    expect(toScorecard("e", metrics({ cellsTotal: 30 }), EMPTY_WINDOW_METRICS).confidence).toBe("medium");
    expect(toScorecard("e", metrics({ cellsTotal: 120 }), EMPTY_WINDOW_METRICS).confidence).toBe("high");
    expect(toScorecard("e", metrics(), EMPTY_WINDOW_METRICS).confidenceHalfWidth).toBeGreaterThan(0);
  });

  it("scenario 10 — an engine with no rows scores null and reports zero cells", () => {
    // NOT omitted. "We did not measure this engine" is a fact the screen has
    // to show, and an absent row would read as an engine that is not enabled.
    const card = toScorecard("gemini", EMPTY_WINDOW_METRICS, EMPTY_WINDOW_METRICS);
    expect(card).toMatchObject({ visibilityScore: null, visibilityDelta: null, measuredCells: 0, confidence: "low" });
    expect(card.confidenceHalfWidth).toBeNull();
  });
});

describe("STORY-136 · blendScorecards", () => {
  const weighted = (engineKey: string, over: Partial<WindowMetrics>, weight: number) => ({
    scorecard: toScorecard(engineKey, metrics(over), EMPTY_WINDOW_METRICS),
    weight,
  });

  const weightedFrom = (engineKey: string, over: Partial<DayAggregate>, weight: number) => ({
    scorecard: toScorecard(engineKey, windowFrom(over), EMPTY_WINDOW_METRICS),
    weight,
  });

  it("scenario 8 — the blend is blendAcrossEngines exactly, not the mean", () => {
    const entries = [
      weightedFrom("chatgpt", { cellsPresent: 90 }, 1),
      weightedFrom("perplexity", { cellsPresent: 30 }, 3),
      weightedFrom("claude", { cellsPresent: 60 }, 2),
    ];
    const blended = blendScorecards(entries, []);

    expect(blended.visibilityScore).toBe(
      blendAcrossEngines(entries.map((e) => ({ score: e.scorecard.visibilityScore, engineWeight: e.weight }))),
    );
    const mean = entries.reduce((t, e) => t + e.scorecard.visibilityScore!, 0) / entries.length;
    expect(blended.visibilityScore).not.toBeCloseTo(mean, 6);
  });

  it("scenario 9 — an engine scoring null is LEFT OUT, not blended in at zero", () => {
    const scored = weighted("chatgpt", {}, 1);
    const unmeasured = { scorecard: toScorecard("gemini", EMPTY_WINDOW_METRICS, EMPTY_WINDOW_METRICS), weight: 1 };
    const blended = blendScorecards([scored, unmeasured], []);
    expect(blended.visibilityScore).toBe(scored.scorecard.visibilityScore);
  });

  it("SUMS the cell counts rather than blending them — AC3's 'cell count behind it'", () => {
    // A weighted mean of counts is not a count of anything.
    const blended = blendScorecards([weighted("a", {}, 1), weighted("b", {}, 9)], []);
    expect(blended.measuredCells).toBe(200);
    expect(blended.metrics.cellsTotal).toBe(200);
  });

  it("derives the blended presence rate from the summed counts", () => {
    const blended = blendScorecards(
      [weightedFrom("a", { cellsPresent: 90 }, 1), weightedFrom("b", { cellsPresent: 10 }, 1)],
      [],
    );
    expect(blended.metrics.presenceRate).toBeCloseTo(100 / 200, 12);
  });

  it("keeps a blended metric null when NO engine measured it", () => {
    const none: Partial<WindowMetrics> = { citationShare: null };
    const blended = blendScorecards([weighted("a", none, 1), weighted("b", none, 1)], []);
    expect(blended.metrics.citationShare).toBeNull();
  });

  it("weights a blended metric over the engines that HAVE it", () => {
    const blended = blendScorecards(
      [weighted("a", { citationShare: 0.8 }, 3), weighted("b", { citationShare: null }, 1)],
      [],
    );
    expect(blended.metrics.citationShare).toBeCloseTo(0.8, 12);
  });

  it("carries the cross-engine key the rollup's second pass uses", () => {
    expect(blendScorecards([weighted("a", {}, 1)], []).engineKey).toBe(BLENDED_KEY);
  });

  it("suppresses the blended delta when the prior blended window is under-sampled", () => {
    const current = [weightedFrom("a", {}, 1)];
    const prior = [weightedFrom("a", { cellsTotal: 10, cellsPresent: 6 }, 1)];
    expect(blendScorecards(current, prior).visibilityDelta).toBeNull();
  });

  it("returns a null score and a low band for a project with no engines at all", () => {
    const blended: Scorecard = blendScorecards([], []);
    expect(blended).toMatchObject({ visibilityScore: null, measuredCells: 0, confidence: "low" });
  });
});
