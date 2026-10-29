import { describe, expect, it } from "vitest";
import { CORPUS } from "./constants.js";
import { centroidWeight, isLowConfidence, suppressRecommendations, expiresAtFrom } from "./weights.js";

describe("passage weight and confidence - STORY-058", () => {
  it("AC8 - centroid_weight = log1p(citation_frequency) * avg_position_weight", () => {
    expect(centroidWeight(1, 0.5)).toBeCloseTo(Math.log(2) * 0.5, 10);
    expect(centroidWeight(10, 1)).toBeCloseTo(Math.log(11), 10);
  });
  it("AC8 - a never-cited or zero-position URL has weight 0, not NaN", () => {
    expect(centroidWeight(0, 0.9)).toBe(0);
    expect(centroidWeight(5, 0)).toBe(0);
  });
  it("AC8 - a frequently cited, high-slot source outweighs a rare low-slot one", () => {
    expect(centroidWeight(20, 0.9)).toBeGreaterThan(centroidWeight(2, 0.3));
  });
  it("AC11 - the documented minimum is 8 passages: 7 is low-confidence, 8 is not", () => {
    expect(CORPUS.minPassages).toBe(8);
    expect(isLowConfidence(7)).toBe(true);
    expect(isLowConfidence(8)).toBe(false);
    expect(isLowConfidence(0)).toBe(true);
  });
  it("AC11 - scenario 10: low confidence suppresses recommendations past priority_rank 3", () => {
    const recs = [1, 2, 3, 4, 5].map((priority_rank) => ({ priority_rank }));
    expect(suppressRecommendations(recs, true).map((r) => r.priority_rank)).toEqual([1, 2, 3]);
    expect(suppressRecommendations(recs, false)).toHaveLength(5);
  });
  it("AC11 - fail closed: under low confidence a recommendation with no rank is suppressed", () => {
    expect(suppressRecommendations([{ priority_rank: null }, { priority_rank: 1 }], true)).toEqual([{ priority_rank: 1 }]);
  });
  it("AC12 - expiry is 30 days after fetch", () => {
    expect(CORPUS.ttlDays).toBe(30);
    expect(expiresAtFrom(new Date("2026-10-01T00:00:00Z")).toISOString()).toBe("2026-10-31T00:00:00.000Z");
  });
  it("AC1 - the reference window and cap: 90 days, top 25", () => {
    expect(CORPUS.windowDays).toBe(90);
    expect(CORPUS.topUrls).toBe(25);
  });
});
