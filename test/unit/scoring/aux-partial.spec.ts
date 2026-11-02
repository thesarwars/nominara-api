import { describe, expect, it } from "vitest";
import { AUX_CATEGORY_WEIGHTS, auxDecidedBasis, auxScore, type AuxCategory, type AuxCountedFinding } from "../../../src/lib/scoring/aux.js";

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

// OWNER DECISION 52 - a category is scored on the rules that were DECIDED. max_penalty(cat) is the sum of the decided rules' weights; a category with no
// decided rule is dropped; and the headline is partial whenever any rule went unmeasured. Worked by hand.
describe("AUXLIVE-5 round 5 · owner decision 52: the score is over decided rules", () => {
  const rule = (category: AuxCategory, weight: number) => ({ category, weight });

  it("D52 · auxDecidedBasis: max_penalty is the sum of the decided rules' weights per category, and a category with no decided rule is absent", () => {
    const basis = auxDecidedBasis([rule("render_mode", 0.16), rule("structured_data", 0.14), rule("structured_data", 0.1)]);
    expect(basis.categories).toEqual(["structured_data", "render_mode"]); // the reference's order
    expect(basis.categoryMaxPenalty.render_mode).toBeCloseTo(0.16, 9);
    expect(basis.categoryMaxPenalty.structured_data).toBeCloseTo(0.24, 9);
    expect(basis.categoryMaxPenalty.freshness).toBeUndefined();
  });

  it("D52 · auxDecidedBasis of nothing decided is empty (the caller drops every category)", () => {
    expect(auxDecidedBasis([])).toEqual({ categories: [], categoryMaxPenalty: {} });
  });

  it("D52 · an unmeasured rule does not count as passed: render_mode with one decided rule (weight 0.16) and a medium finding on it is 1 - 0.16*0.3/0.16 = 0.7, not 1 - 0.16*0.3 = 0.952", () => {
    const basis = auxDecidedBasis([rule("render_mode", 0.16)]);
    const out = auxScore({
      findings: [finding({ category: "render_mode", severity: "medium", ruleWeight: 0.16 })],
      pagesCrawled: 1,
      evaluatedCategories: basis.categories,
      categoryMaxPenalty: basis.categoryMaxPenalty,
    });
    expect(out.subscores.render_mode).toBeCloseTo(0.7, 9);
    expect(out.score).toBe(70);
  });

  it("D52 · a held rule (AUX-R-013) is left out of the denominator: the same finding weighs more against a category whose held rule is not counted", () => {
    // structured_data: decided 0.14 + 0.10 = 0.24; held 0.11 not counted. A critical 0.14 finding: 1 - 0.14/0.24 = 0.41667.
    const basis = auxDecidedBasis([rule("structured_data", 0.14), rule("structured_data", 0.1)]);
    const out = auxScore({ findings: [finding({ ruleWeight: 0.14 })], pagesCrawled: 1, evaluatedCategories: basis.categories, categoryMaxPenalty: basis.categoryMaxPenalty });
    expect(out.subscores.structured_data).toBeCloseTo(1 - 0.14 / 0.24, 9);
  });

  it("D52 · a fully measured category scores exactly as before: decided weights that sum to 1 give the same subscore as no override", () => {
    const basis = auxDecidedBasis([rule("context_fitness", 0.6), rule("context_fitness", 0.4)]);
    const input = { findings: [finding({ category: "context_fitness", severity: "high", ruleWeight: 0.4 })], pagesCrawled: 2 };
    const withBasis = auxScore({ ...input, evaluatedCategories: basis.categories, categoryMaxPenalty: basis.categoryMaxPenalty });
    const without = auxScore({ ...input, evaluatedCategories: ["context_fitness"] });
    expect(withBasis.subscores.context_fitness).toBeCloseTo(without.subscores.context_fitness, 9);
    expect(withBasis.score).toBe(without.score);
  });

  it("D52 · partial is true when any rule went unmeasured, even with all six categories evaluated", () => {
    const six = auxScore({ findings: [], pagesCrawled: 1, evaluatedCategories: SIX, unmeasuredRules: ["AUX-R-013"] });
    expect(six.partial).toBe(true);
    expect(six.unmeasured).toEqual([]); // no category is missing
    expect(auxScore({ findings: [], pagesCrawled: 1, evaluatedCategories: SIX, unmeasuredRules: [] }).partial).toBe(false);
  });
});
