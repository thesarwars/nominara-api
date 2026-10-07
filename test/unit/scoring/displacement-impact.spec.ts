import { describe, expect, it } from "vitest";
import { CLASS_PENALTY, classPenaltyKindFor, displacementImpact, displacementImpactForEvent } from "../../../src/lib/scoring/displacement-impact.js";

// STORY-056 — scoring-models.md §9 (D1). Every expectation is a hand-computed
// value from the formula, never read back from the implementation.

const base = {
  presenceLost: false,
  beforePosition: 2,
  afterPosition: 5 as number | null,
  classPenalty: "recommendation_to_ranked" as "recommendation_to_ranked" | "recommendation_to_absent" | null,
  funnelStage: "decision" as "decision" | "consideration" | "awareness",
  topicRankByIntent: 1,
  engineWeight: 1,
  maxEngineWeight: 2,
  citationGap: 2,
};

describe("STORY-056 · displacement impact (D1)", () => {
  it("scenario 6 — a known pair matches the hand-computed value", () => {
    // position_loss 3/5 = 0.6 · class 0.55 · prompt 0.5·1.0+0.5·(1/1) = 1.0
    // engine 1/2 = 0.5 · recoverability 1 − 2/5 = 0.6
    // 100·(0.35·0.6 + 0.25·0.55 + 0.20·1 + 0.10·0.5 + 0.10·0.6) = 65.75
    expect(displacementImpact(base)).toBeCloseTo(65.75, 9);
  });

  it("scenario 7 — a smaller citation gap scores higher (recoverability raises the score)", () => {
    const small = displacementImpact({ ...base, citationGap: 2 });
    const large = displacementImpact({ ...base, citationGap: 40 });
    expect(small).toBeGreaterThan(large);
    // 0.10 · (0.6 − 0) · 100
    expect(small - large).toBeCloseTo(6, 9);
  });

  it("recoverability saturates at a gap of 5 and a zero gap is fully recoverable", () => {
    const five = displacementImpact({ ...base, citationGap: 5 });
    const nine = displacementImpact({ ...base, citationGap: 9 });
    expect(five).toBeCloseTo(nine, 9);
    expect(displacementImpact({ ...base, citationGap: 0 }) - five).toBeCloseTo(10, 9);
  });

  it("presence lost entirely has position_loss 1 and class penalty 1.00", () => {
    // 100·(0.35 + 0.25 + 0.20 + 0.05 + 0.06) = 91
    const score = displacementImpact({ ...base, presenceLost: true, afterPosition: null, classPenalty: "recommendation_to_absent" });
    expect(score).toBeCloseTo(91, 9);
  });

  it("prompt weight uses the funnel weights and 1/rank", () => {
    // awareness 0.40, rank 2 → 0.5·0.4 + 0.5·0.5 = 0.45 vs decision/rank 1 = 1.0
    const delta = displacementImpact(base) - displacementImpact({ ...base, funnelStage: "awareness", topicRankByIntent: 2 });
    expect(delta).toBeCloseTo(100 * 0.2 * (1 - 0.45), 9);
    const consideration = displacementImpact({ ...base, funnelStage: "consideration" });
    expect(displacementImpact(base) - consideration).toBeCloseTo(100 * 0.2 * 0.5 * 0.3, 9);
  });

  it("the score is clamped to [0, 100]", () => {
    const score = displacementImpact({ ...base, engineWeight: 5, maxEngineWeight: 1 });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("a zero max engine weight does not produce NaN", () => {
    expect(Number.isFinite(displacementImpact({ ...base, engineWeight: 0, maxEngineWeight: 0 }))).toBe(true);
  });

  it("a null class penalty (no table row) contributes 0", () => {
    expect(displacementImpact(base) - displacementImpact({ ...base, classPenalty: null })).toBeCloseTo(100 * 0.25 * 0.55, 9);
  });

  it("which table row a detected kind falls under", () => {
    expect(classPenaltyKindFor("presence_lost", "recommendation", null)).toBe("recommendation_to_absent");
    expect(classPenaltyKindFor("recommendation_lost", "recommendation", "ranked")).toBe("recommendation_to_ranked");
    expect(classPenaltyKindFor("recommendation_lost", "recommendation", "neutral_list")).toBe("recommendation_to_ranked");
    expect(classPenaltyKindFor("position_lost", "ranked", "also_consider")).toBe("ranked_to_also_consider");
    expect(classPenaltyKindFor("position_lost", "ranked", "caveat")).toBe("any_to_caveat");
    expect(classPenaltyKindFor("render_downgraded", "ranked", "ranked")).toBe("render_downgrade_only");
    expect(classPenaltyKindFor("position_lost", "ranked", "ranked")).toBeNull();
  });

  it("scenario 6b — every §9 class_penalty constant is pinned exactly", () => {
    expect(CLASS_PENALTY.recommendation_to_absent).toBeCloseTo(1.0, 9);
    expect(CLASS_PENALTY.recommendation_to_ranked).toBeCloseTo(0.55, 9);
    expect(CLASS_PENALTY.ranked_to_also_consider).toBeCloseTo(0.4, 9);
    expect(CLASS_PENALTY.any_to_caveat).toBeCloseTo(0.7, 9);
    expect(CLASS_PENALTY.render_downgrade_only).toBeCloseTo(0.25, 9);
  });

  it("a caveat-to-caveat move is not a new caveat demotion (row null)", () => {
    expect(classPenaltyKindFor("position_lost", "caveat", "caveat")).toBeNull();
  });

  it("a render_downgraded event takes the render-only row even when the class also changed", () => {
    expect(classPenaltyKindFor("render_downgraded", "recommendation", "ranked")).toBe("render_downgrade_only");
    expect(classPenaltyKindFor("render_downgraded", "ranked", "caveat")).toBe("render_downgrade_only");
  });

  it("presence_lost keeps the recommendation_to_absent row for every before class (flagged reading, pinned)", () => {
    for (const before of ["recommendation", "ranked", "also_consider", "caveat", null]) {
      expect(classPenaltyKindFor("presence_lost", before, null)).toBe("recommendation_to_absent");
    }
  });

  it("a multi-kind change is scored per event: render-only 0.25 with no position loss, recommendation_lost with no position loss", () => {
    const common = { funnelStage: "decision" as const, topicRankByIntent: 1, engineWeight: 1, maxEngineWeight: 2, citationGap: 2 };
    const before = { class: "recommendation", position: 1 };
    const after = { class: "ranked", position: 4 };
    const kinds = ["position_lost", "recommendation_lost", "render_downgraded"] as const;
    const scores = Object.fromEntries(
      kinds.map((kind) => [kind, scoreDetected(kind, before, after, common)]),
    ) as Record<(typeof kinds)[number], number>;
    // shared tail: 0.20·1 + 0.10·0.5 + 0.10·0.6 = 0.31
    expect(scores.render_downgraded).toBeCloseTo(100 * (0.25 * 0.25 + 0.31), 9); // 37.25
    expect(scores.recommendation_lost).toBeCloseTo(100 * (0.25 * 0.55 + 0.31), 9); // 44.75
    expect(scores.position_lost).toBeCloseTo(100 * (0.35 * 0.75 + 0.25 * 0.55 + 0.31), 9); // 71
  });
});

function scoreDetected(
  kind: "position_lost" | "recommendation_lost" | "render_downgraded",
  before: { class: string; position: number },
  after: { class: string; position: number },
  common: { funnelStage: "decision"; topicRankByIntent: number; engineWeight: number; maxEngineWeight: number; citationGap: number },
): number {
  return displacementImpactForEvent({
    kind,
    beforePosition: before.position,
    afterPosition: after.position,
    beforeClass: before.class,
    afterClass: after.class,
    ...common,
  });
}
