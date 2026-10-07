import { describe, expect, it } from "vitest";
import { classPenalty, displacementImpact } from "../../../src/lib/scoring/displacement-impact.js";

// STORY-056 — scoring-models.md §9 (D1). Every expectation is a hand-computed
// value from the formula, never read back from the implementation.

const base = {
  beforePosition: 2,
  afterPosition: 5 as number | null,
  kind: "position_lost" as const,
  beforeClass: "recommendation" as const,
  afterClass: "ranked" as const,
  funnel: "decision" as const,
  topicRank: 1,
  engineWeight: 1,
  maxEngineWeight: 2,
  citationGapCount: 2,
};

describe("STORY-056 · displacement impact (D1)", () => {
  it("scenario 6 — a known pair matches the hand-computed value", () => {
    // position_loss 3/5 = 0.6 · class 0.55 · prompt 0.5·1.0+0.5·(1/1) = 1.0
    // engine 1/2 = 0.5 · recoverability 1 − 2/5 = 0.6
    // 100·(0.35·0.6 + 0.25·0.55 + 0.20·1 + 0.10·0.5 + 0.10·0.6) = 65.75
    expect(displacementImpact(base)).toBeCloseTo(65.75, 9);
  });

  it("scenario 7 — a smaller citation gap scores higher (recoverability raises the score)", () => {
    const small = displacementImpact({ ...base, citationGapCount: 2 });
    const large = displacementImpact({ ...base, citationGapCount: 40 });
    expect(small).toBeGreaterThan(large);
    // 0.10 · (0.6 − 0) · 100
    expect(small - large).toBeCloseTo(6, 9);
  });

  it("recoverability saturates at a gap of 5 and a zero gap is fully recoverable", () => {
    const five = displacementImpact({ ...base, citationGapCount: 5 });
    const nine = displacementImpact({ ...base, citationGapCount: 9 });
    expect(five).toBeCloseTo(nine, 9);
    expect(displacementImpact({ ...base, citationGapCount: 0 }) - five).toBeCloseTo(10, 9);
  });

  it("presence lost entirely has position_loss 1 and class penalty 1.00", () => {
    // 100·(0.35 + 0.25 + 0.20 + 0.05 + 0.06) = 91
    const score = displacementImpact({ ...base, kind: "presence_lost", afterPosition: null, afterClass: null });
    expect(score).toBeCloseTo(91, 9);
  });

  it("prompt weight uses the funnel weights and 1/rank", () => {
    // awareness 0.40, rank 2 → 0.5·0.4 + 0.5·0.5 = 0.45 vs decision/rank 1 = 1.0
    const delta = displacementImpact(base) - displacementImpact({ ...base, funnel: "awareness", topicRank: 2 });
    expect(delta).toBeCloseTo(100 * 0.2 * (1 - 0.45), 9);
    const consideration = displacementImpact({ ...base, funnel: "consideration" });
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

  it("class penalty table", () => {
    expect(classPenalty("presence_lost", "recommendation", null)).toBe(1.0);
    expect(classPenalty("recommendation_lost", "recommendation", "ranked")).toBe(0.55);
    expect(classPenalty("recommendation_lost", "recommendation", "neutral_list")).toBe(0.55);
    expect(classPenalty("position_lost", "ranked", "also_consider")).toBe(0.4);
    expect(classPenalty("position_lost", "ranked", "caveat")).toBe(0.7);
    expect(classPenalty("render_downgraded", "ranked", "ranked")).toBe(0.25);
    expect(classPenalty("position_lost", "ranked", "ranked")).toBe(0);
  });
});
