import { describe, expect, it } from "vitest";
import { ALIGNMENT } from "./constants.js";
import { blendAlpha, diminishedSum, diminishingFactor, priorityScore, typeMultiplier } from "./gain.js";

// aux-and-geo-analysis.md section 7, "Projected gain" - the scalar half. The vector half (blend, normalise, cosine) is SQL
// (compute.ts) and is tested against the database.

describe("STORY-059 - the documented constants, exactly", () => {
  it("AC9 - cap 0.25, kappa 3.5, diminishing returns 0.85, prevalence 0.30, presence 0.90, dedupe 0.93, band p50-p85, multiplier 1.15", () => {
    expect(ALIGNMENT.alphaCap).toBe(0.25);
    expect(ALIGNMENT.kappa).toBe(3.5);
    expect(ALIGNMENT.diminishing).toBe(0.85);
    expect(ALIGNMENT.minDocRatio).toBe(0.3);
    expect(ALIGNMENT.presenceCosine).toBe(0.9);
    expect(ALIGNMENT.dedupeCosine).toBe(0.93);
    expect([ALIGNMENT.bandLowPercentile, ALIGNMENT.bandHighPercentile]).toEqual([0.5, 0.85]);
    expect(ALIGNMENT.claimMultiplier).toBe(1.15);
    expect([ALIGNMENT.minPhraseTokens, ALIGNMENT.maxPhraseTokens]).toEqual([2, 5]);
  });
});

describe("STORY-059 scenario 8 - alpha = min(0.25, t_e / (t_v + t_e) * kappa)", () => {
  it("a 4-token phrase in a 100-token chunk: 4/104 * 3.5", () => {
    expect(blendAlpha(4, 100)).toBeCloseTo((4 / 104) * 3.5, 12);
  });
  it("is capped at 0.25: a long phrase in a short chunk is never modelled as rewriting the chunk", () => {
    expect(blendAlpha(5, 10)).toBe(0.25);
    expect(blendAlpha(1000, 1)).toBe(0.25);
  });
  it("boundary: exactly the cap is the cap, and just under it is not", () => {
    // t_e/(t_v+t_e)*3.5 = 0.25  <=>  t_e/(t_v+t_e) = 1/14  <=>  t_v = 13 t_e
    expect(blendAlpha(1, 13)).toBeCloseTo(0.25, 12);
    expect(blendAlpha(1, 14)).toBeLessThan(0.25);
  });
  it("is monotone: a longer phrase moves the chunk at least as far", () => {
    let last = 0;
    for (let te = 1; te <= 5; te += 1) {
      const a = blendAlpha(te, 200);
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
  });
  it("a phrase of no tokens moves nothing, and an empty chunk is capped, not divided by zero", () => {
    expect(blendAlpha(0, 100)).toBe(0);
    expect(blendAlpha(3, 0)).toBe(0.25);
    expect(blendAlpha(0, 0)).toBe(0);
  });
});

describe("STORY-059 scenario 9 - diminishing returns 0.85^(i-1), not a naive sum", () => {
  it("the first node counts in full and each later one is weighted by 0.85 more", () => {
    expect(diminishingFactor(1)).toBe(1);
    expect(diminishingFactor(2)).toBeCloseTo(0.85, 12);
    expect(diminishingFactor(3)).toBeCloseTo(0.7225, 12);
  });
  it("the sum of equal gains is below the naive sum from the second node on", () => {
    expect(diminishedSum([0.02])).toBeCloseTo(0.02, 12);
    expect(diminishedSum([0.02, 0.02])).toBeCloseTo(0.02 + 0.02 * 0.85, 12);
    const gains = Array.from({ length: 10 }, () => 0.01);
    expect(diminishedSum(gains)).toBeLessThan(0.1);
    expect(diminishedSum(gains)).toBeCloseTo(0.01 * ((1 - 0.85 ** 10) / (1 - 0.85)), 12);
  });
  it("empty in, zero out (a sum, not an absent figure)", () => {
    expect(diminishedSum([])).toBe(0);
  });
  it("a rank below 1 is a bug, not a bonus", () => {
    expect(() => diminishingFactor(0)).toThrow();
    expect(() => diminishingFactor(1.5)).toThrow();
  });
});

describe("STORY-059 AC13 - priority = projected_gain x corpus_doc_ratio x severity multiplier", () => {
  it("compliance and metric carry 1.15; every other type carries 1", () => {
    expect(typeMultiplier("compliance")).toBe(1.15);
    expect(typeMultiplier("metric")).toBe(1.15);
    for (const type of ["capability", "integration", "persona", "industry", "pricing_term", "entity", "differentiator"] as const) expect(typeMultiplier(type)).toBe(1);
  });
  it("multiplies the three factors", () => {
    expect(priorityScore(0.04, 0.5, "compliance")).toBeCloseTo(0.04 * 0.5 * 1.15, 12);
    expect(priorityScore(0.04, 0.5, "capability")).toBeCloseTo(0.02, 12);
  });
  it("a node with no modeled gain has no priority (null, not 0)", () => {
    expect(priorityScore(null, 0.5, "capability")).toBeNull();
  });
});
