import { describe, expect, it } from "vitest";
import {
  AUX_CATEGORY_WEIGHTS,
  AUX_HARD_CAP,
  AUX_SCOPE_FLOOR,
  AUX_SEVERITY_FACTOR,
  auxScope,
  auxScore,
  sourceCoverage,
  type AuxCountedFinding,
} from "../../../src/lib/scoring/index.js";

// STORY-169 — `scoring-models.md` §7 (AUX score) and §5/§7 (Source Coverage),
// restated in full in `aux-and-geo-analysis.md` §2 and §4.
//
// The reference gives the formula's pieces (the weight tables, the scope
// floor, the hard cap) but no published worked example carrying an expected
// output number — unlike STORY-041's visibility scenarios, which quote one.
// These tests are built directly from the formula's own stated constants
// instead, which is the literal reading the story's Technical Notes asked
// for when the spec does not supply a worked example.

function finding(over: Partial<AuxCountedFinding> = {}): AuxCountedFinding {
  return { category: "structured_data", severity: "medium", ruleWeight: 0.1, affectedPages: 1, ...over };
}

describe("STORY-169 · auxScore — the category weight table", () => {
  it("sums to exactly 1.000, as §7 states it must", () => {
    const total = Object.values(AUX_CATEGORY_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 9);
  });

  it("matches §7's six weights verbatim", () => {
    expect(AUX_CATEGORY_WEIGHTS).toEqual({
      crawler_access: 0.28,
      structured_data: 0.22,
      context_fitness: 0.2,
      render_mode: 0.15,
      entity_clarity: 0.09,
      freshness: 0.06,
    });
  });

  it("matches §7's severity_factor table verbatim", () => {
    expect(AUX_SEVERITY_FACTOR).toEqual({ critical: 1.0, high: 0.6, medium: 0.3, low: 0.1, info: 0.0 });
  });
});

describe("STORY-169 · auxScope — §7's floored ratio", () => {
  it("the exported floor is §7's literal 0.25", () => {
    // Pinned against the literal, not against itself — a test asserting a
    // mutated export equals that same mutated export catches nothing.
    expect(AUX_SCOPE_FLOOR).toBe(0.25);
  });

  it("is the raw ratio above the floor", () => {
    expect(auxScope(10, 40)).toBeCloseTo(0.25, 9); // exactly at the floor
    expect(auxScope(20, 40)).toBeCloseTo(0.5, 9);
  });

  it("floors at 0.25 for a small affected fraction", () => {
    expect(auxScope(1, 100)).toBe(0.25);
  });

  it("never divides by zero", () => {
    expect(auxScope(1, 0)).toBe(0.25);
  });
});

describe("STORY-169 · auxScore — a clean site scores 100", () => {
  it("no findings at all", () => {
    const result = auxScore({ findings: [], pagesCrawled: 10 });
    expect(result.score).toBe(100);
    expect(result.capped).toBe(false);
    for (const category of Object.keys(AUX_CATEGORY_WEIGHTS)) {
      expect(result.subscores[category as keyof typeof AUX_CATEGORY_WEIGHTS]).toBe(1);
    }
  });
});

describe("STORY-169 · auxScore — one category, hand-computed", () => {
  it("a single medium finding reduces only its own category's subscore", () => {
    // penalty(structured_data) = 0.5 (ruleWeight) * 0.3 (medium) * 1 (scope, 10/10 floored irrelevant)
    //                          = 0.15
    // subscore(structured_data) = 1 - 0.15/1 = 0.85
    // AUX = 100 * (0.22 * 0.85 + every other category's 1) = 100 * (1 - 0.22*0.15)
    const result = auxScore({
      findings: [finding({ category: "structured_data", severity: "medium", ruleWeight: 0.5, affectedPages: 10 })],
      pagesCrawled: 10,
    });
    expect(result.subscores.structured_data).toBeCloseTo(0.85, 9);
    expect(result.subscores.crawler_access).toBe(1);
    expect(result.score).toBeCloseTo(100 * (1 - 0.22 * 0.15), 1);
    expect(result.capped).toBe(false);
  });
});

describe("STORY-169 · auxScore — the hard cap", () => {
  it("the exported cap is §7's literal 72", () => {
    expect(AUX_HARD_CAP).toBe(72);
  });

  it("caps at 72 when a critical crawler_access finding is present and the raw score exceeds it", () => {
    // A single, small crawler_access finding alone would leave the raw score
    // well above 72 — the cap is what pulls it down, not the penalty itself.
    const result = auxScore({
      findings: [finding({ category: "crawler_access", severity: "critical", ruleWeight: 0.3, affectedPages: 1, ...{} })],
      pagesCrawled: 100,
    });
    expect(result.score).toBe(AUX_HARD_CAP);
    expect(result.capped).toBe(true);
  });

  it("does NOT report capped when the critical finding's own arithmetic already lands at or below 72", () => {
    // Every category maximally penalised drives the score well under 72
    // without the cap doing any work — `capped` says whether the cap CHANGED
    // the value, not merely whether a critical crawler_access finding exists.
    const findings: AuxCountedFinding[] = (Object.keys(AUX_CATEGORY_WEIGHTS) as (keyof typeof AUX_CATEGORY_WEIGHTS)[]).map(
      (category) => finding({ category, severity: "critical", ruleWeight: 1, affectedPages: 100 }),
    );
    const result = auxScore({ findings, pagesCrawled: 100 });
    expect(result.score).toBe(0);
    expect(result.capped).toBe(false); // the arithmetic alone already reached the floor
  });

  it("does not cap a score that never reaches 72 in the first place", () => {
    // A NON-critical crawler_access finding never sets the cap flag, however
    // low the arithmetic score is.
    const result = auxScore({
      findings: [finding({ category: "crawler_access", severity: "high", ruleWeight: 1, affectedPages: 100 })],
      pagesCrawled: 100,
    });
    expect(result.capped).toBe(false);
  });
});

describe("STORY-169 · auxScore — lifecycle filtering is the caller's job", () => {
  it("a resolved or wont_fix finding must never be passed in — the function has no status field to filter on", () => {
    // Documented in the type's own comment; asserted here as the executable
    // form of that contract. An `info`-severity finding contributes zero
    // penalty by the table itself, which is the one lifecycle-adjacent case
    // this function DOES handle, because severity_factor.info = 0.
    const result = auxScore({
      findings: [finding({ severity: "info", ruleWeight: 1, affectedPages: 100 })],
      pagesCrawled: 100,
    });
    expect(result.score).toBe(100);
  });
});

describe("STORY-169 · sourceCoverage — §7's formula", () => {
  it("is null when there are no domains at all — not 100", () => {
    expect(sourceCoverage([])).toBeNull();
  });

  it("is 100 when no domain has a critical or high gap", () => {
    expect(
      sourceCoverage([
        { contextWeight: 0.6, gapSeverity: "none" },
        { contextWeight: 0.3, gapSeverity: "low" },
        { contextWeight: 0.1, gapSeverity: "medium" },
      ]),
    ).toBe(100);
  });

  it("subtracts exactly the critical/high context weight, ignoring medium and low", () => {
    const value = sourceCoverage([
      { contextWeight: 0.4, gapSeverity: "critical" },
      { contextWeight: 0.2, gapSeverity: "high" },
      { contextWeight: 0.25, gapSeverity: "medium" },
      { contextWeight: 0.15, gapSeverity: "none" },
    ]);
    expect(value).toBeCloseTo(100 * (1 - 0.6), 9);
  });

  it("is 0 when every domain is a critical or high gap summing to full weight", () => {
    expect(
      sourceCoverage([
        { contextWeight: 0.7, gapSeverity: "critical" },
        { contextWeight: 0.3, gapSeverity: "high" },
      ]),
    ).toBe(0);
  });
});
