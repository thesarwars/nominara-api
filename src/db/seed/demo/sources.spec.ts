import { describe, expect, it } from "vitest";
import { deriveGapSeverity } from "./sources.js";

// STORY-169 review — `deriveGapSeverity` is scoring-models.md §5's formula,
// applied verbatim:
//
//   'critical' if context_weight(d) >= 0.15 and not brand_present and is_seedable(d)
//   'high'     if context_weight(d) >= 0.08 and not brand_present and is_seedable(d)
//   'medium'   if context_weight(d) >= 0.03 and not brand_present
//   'low'      if context_weight(d) >  0    and not brand_present
//   'none'     otherwise
//
// Before this existed, the seed picked `gap_severity` at random, independent
// of `context_weight`/`is_seedable` — a non-seedable encyclopedic/news
// domain could come back `critical` and generate a `TG-SOURCE-ABSENCE`
// authority task for a domain §5 says must never get one ("escalating a
// domain the brand cannot legitimately contribute to... is noise").

describe("STORY-169 review · deriveGapSeverity — scoring-models.md §5, verbatim", () => {
  it("brand present is 'none' regardless of weight or seedability", () => {
    expect(deriveGapSeverity(0.9, true, true)).toBe("none");
    expect(deriveGapSeverity(0.5, false, true)).toBe("none");
  });

  it("'critical' requires weight >= 0.15 AND seedable", () => {
    expect(deriveGapSeverity(0.15, true, false)).toBe("critical");
    expect(deriveGapSeverity(0.2, true, false)).toBe("critical");
  });

  it("weight >= 0.15 but NOT seedable never reaches critical — falls to medium (the only weight-gated tier with no seedable term)", () => {
    expect(deriveGapSeverity(0.2, false, false)).toBe("medium");
  });

  it("just under the critical threshold is 'high' (>= 0.08), still gated on seedable", () => {
    expect(deriveGapSeverity(0.14999, true, false)).toBe("high");
    expect(deriveGapSeverity(0.08, true, false)).toBe("high");
  });

  it("weight in the high band but NOT seedable never reaches high — falls to medium", () => {
    expect(deriveGapSeverity(0.1, false, false)).toBe("medium");
  });

  it("'medium' (>= 0.03) applies to ANY domain, seedable or not — no seedable term on this branch", () => {
    expect(deriveGapSeverity(0.03, true, false)).toBe("medium");
    expect(deriveGapSeverity(0.03, false, false)).toBe("medium");
    expect(deriveGapSeverity(0.07999, false, false)).toBe("medium");
  });

  it("'low' (> 0) applies to any domain", () => {
    expect(deriveGapSeverity(0.001, true, false)).toBe("low");
    expect(deriveGapSeverity(0.029, false, false)).toBe("low");
  });

  it("exactly zero weight, not present, is 'none'", () => {
    expect(deriveGapSeverity(0, true, false)).toBe("none");
  });
});
