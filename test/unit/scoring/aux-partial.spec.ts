import { describe, expect, it } from "vitest";
import { AUX_CATEGORY_WEIGHTS, auxScore, type AuxCategory, type AuxCountedFinding } from "../../../src/lib/scoring/aux.js";

// AUXLIVE-5 (owner decision 38) - the headline AUX score over the categories that were MEASURED, renormalised to 100 and labelled partial.
// Every figure below is worked by hand from scoring-models.md section 7's weights (0.28 / 0.22 / 0.20 / 0.15 / 0.09 / 0.06), not read back from the code.

const FIVE: readonly AuxCategory[] = ["crawler_access", "structured_data", "context_fitness", "render_mode", "freshness"];
const SIX: readonly AuxCategory[] = [...FIVE, "entity_clarity"];
const finding = (over: Partial<AuxCountedFinding>): AuxCountedFinding => ({ category: "structured_data", severity: "critical", ruleWeight: 0.1, affectedPages: 1, ...over });

describe("AUXLIVE-5 · auxScore over the evaluated categories (owner decision 38)", () => {
  it("AUXLIVE-5 · all six categories evaluated: the full score, partial false, nothing unmeasured - and identical to the call with no list", () => {
    const input = { findings: [finding({})], pagesCrawled: 1 };
    const full = auxScore({ ...input, evaluatedCategories: SIX });
    // 0.28 + 0.22 * 0.9 + 0.20 + 0.15 + 0.09 + 0.06 = 0.978
    expect(full.score).toBe(97.8);
    expect(full.partial).toBe(false);
    expect(full.unmeasured).toEqual([]);
    expect(auxScore(input).score).toBe(97.8);
    expect(auxScore(input).partial).toBe(false);
  });

  it("AUXLIVE-5 · five categories, entity_clarity not measured: sum(W * sub) / sum(W) * 100, 1 decimal - 0.888 / 0.91 = 97.6", () => {
    const out = auxScore({ findings: [finding({})], pagesCrawled: 1, evaluatedCategories: FIVE });
    // numerator 0.28 + 0.22 * 0.9 + 0.20 + 0.15 + 0.06 = 0.888; denominator 0.28 + 0.22 + 0.20 + 0.15 + 0.06 = 0.91
    expect(out.score).toBe(97.6);
    expect(out.partial).toBe(true);
    expect(out.unmeasured).toEqual(["entity_clarity"]);
  });

  it("AUXLIVE-5 · a clean site measured over five categories is 100, not 91: renormalised, so the unmeasured category neither adds nor costs points", () => {
    const out = auxScore({ findings: [], pagesCrawled: 1, evaluatedCategories: FIVE });
    expect(out.score).toBe(100);
    expect(out.partial).toBe(true);
  });

  it("AUXLIVE-5 · the 72 cap still applies to the renormalised figure: a critical crawler_access finding (sub 0.7) gives 0.826 / 0.91 = 90.8, capped to 72", () => {
    const out = auxScore({ findings: [finding({ category: "crawler_access", ruleWeight: 0.3 })], pagesCrawled: 1, evaluatedCategories: FIVE });
    expect(out.score).toBe(72);
    expect(out.capped).toBe(true);
    expect(out.partial).toBe(true);
  });

  it("AUXLIVE-5 · a finding in an UNMEASURED category cannot move the score (it is ignored, not counted)", () => {
    const out = auxScore({ findings: [finding({ category: "entity_clarity", ruleWeight: 0.5 })], pagesCrawled: 1, evaluatedCategories: FIVE });
    expect(out.score).toBe(100);
  });

  it("AUXLIVE-5 · a single measured category is that category's subscore times 100", () => {
    const out = auxScore({ findings: [finding({ category: "crawler_access", severity: "high", ruleWeight: 0.2 })], pagesCrawled: 1, evaluatedCategories: ["crawler_access"] });
    // sub = 1 - 0.2 * 0.6 = 0.88
    expect(out.score).toBe(88);
    expect(out.unmeasured).toHaveLength(5);
  });

  it("AUXLIVE-5 · an empty evaluated set is refused: there is no score of nothing (null is not 0)", () => {
    expect(() => auxScore({ findings: [], pagesCrawled: 1, evaluatedCategories: [] })).toThrow(RangeError);
  });

  it("AUXLIVE-5 · the category weights are untouched", () => {
    expect(Object.values(AUX_CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});
