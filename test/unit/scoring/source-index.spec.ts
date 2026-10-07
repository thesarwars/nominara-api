import { describe, expect, it } from "vitest";
import { gapSeverity, isSeedableSourceClass, sourceContextWeights } from "../../../src/lib/scoring/index.js";

// NEW-C-4 / STORY-054 — scoring-models.md §5 (context weight, breadth
// correction, gap severity) and aux-and-geo-analysis.md §10 (seedability).

describe("STORY-054 #4 · sourceContextWeights — the breadth correction", () => {
  it("40 citations over 25 prompts outrank 40 citations over 2", () => {
    const [broad, narrow] = sourceContextWeights(
      [
        { rawWeight: 40, distinctPrompts: 25 },
        { rawWeight: 40, distinctPrompts: 2 },
      ],
      25,
    );
    expect(broad!).toBeGreaterThan(narrow!);
  });

  it("applies raw · (0.70 + 0.30 · breadth) exactly, normalised to sum to 1", () => {
    const weights = sourceContextWeights(
      [
        { rawWeight: 10, distinctPrompts: 5 }, // 10 · (0.7 + 0.3·0.5) = 8.5
        { rawWeight: 10, distinctPrompts: 10 }, // 10 · 1.0 = 10
      ],
      10,
    );
    expect(weights[0]).toBeCloseTo(8.5 / 18.5, 12);
    expect(weights[1]).toBeCloseTo(10 / 18.5, 12);
    expect(weights[0]! + weights[1]!).toBeCloseTo(1, 12);
  });

  it("an empty set yields an empty result", () => {
    expect(sourceContextWeights([], 10)).toEqual([]);
  });

  it("zero total raw weight yields zeros, never NaN", () => {
    expect(sourceContextWeights([{ rawWeight: 0, distinctPrompts: 0 }], 0)).toEqual([0]);
  });

  it("zero prompts in the window does not divide by zero", () => {
    const weights = sourceContextWeights([{ rawWeight: 3, distinctPrompts: 0 }], 0);
    expect(weights).toEqual([1]);
  });

  it("breadth is capped at 1 when distinct prompts exceed the denominator", () => {
    const capped = sourceContextWeights([{ rawWeight: 1, distinctPrompts: 99 }, { rawWeight: 1, distinctPrompts: 10 }], 10);
    expect(capped[0]).toBeCloseTo(0.5, 12);
  });
});

describe("STORY-054 #8/#9 · gapSeverity — thresholds and the seedability gate", () => {
  const base = { brandPresent: false, isSeedable: true };
  it("critical at >= 0.15, high at >= 0.08 (boundaries inclusive)", () => {
    expect(gapSeverity({ ...base, contextWeight: 0.15 })).toBe("critical");
    expect(gapSeverity({ ...base, contextWeight: 0.1499 })).toBe("high");
    expect(gapSeverity({ ...base, contextWeight: 0.08 })).toBe("high");
    expect(gapSeverity({ ...base, contextWeight: 0.0799 })).toBe("medium");
  });
  it("medium at >= 0.03, low above 0, none at 0", () => {
    expect(gapSeverity({ ...base, contextWeight: 0.03 })).toBe("medium");
    expect(gapSeverity({ ...base, contextWeight: 0.0299 })).toBe("low");
    expect(gapSeverity({ ...base, contextWeight: 0.0001 })).toBe("low");
    expect(gapSeverity({ ...base, contextWeight: 0 })).toBe("none");
  });
  it("a non-seedable domain never reaches critical or high", () => {
    expect(gapSeverity({ contextWeight: 0.5, brandPresent: false, isSeedable: false })).toBe("medium");
    expect(gapSeverity({ contextWeight: 0.1, brandPresent: false, isSeedable: false })).toBe("medium");
    expect(gapSeverity({ contextWeight: 0.01, brandPresent: false, isSeedable: false })).toBe("low");
  });
  it("brand present is always none", () => {
    expect(gapSeverity({ contextWeight: 0.9, brandPresent: true, isSeedable: true })).toBe("none");
  });
  it("unverified presence (null) yields null — absence is never assumed", () => {
    expect(gapSeverity({ contextWeight: 0.9, brandPresent: null, isSeedable: true })).toBeNull();
  });
});

describe("STORY-054 #3 · isSeedableSourceClass", () => {
  it("matches the documented mapping", () => {
    for (const c of ["community_forum", "review_marketplace", "developer_platform", "news_media", "blog"]) {
      expect(isSeedableSourceClass(c, false)).toBe(true);
    }
    for (const c of ["vendor_owned", "academic", "government", "encyclopedic", "social", "other"]) {
      expect(isSeedableSourceClass(c, false)).toBe(false);
    }
  });
  it("a competitor-owned domain is never seedable, whatever its class", () => {
    expect(isSeedableSourceClass("community_forum", true)).toBe(false);
    expect(isSeedableSourceClass("review_marketplace", true)).toBe(false);
  });
});
