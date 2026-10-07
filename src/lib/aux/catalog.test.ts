import { describe, expect, it } from "vitest";
import { AuxCatalogWeightError, assertCatalogWeights, loadAuxCatalog, type AuxCatalogRule } from "./catalog.js";

// NEW-C-8 AC3 — NFR-AUX-03: the loader asserts Σ W(r) = 1.000 ± 0.001 per
// category, on load, before any audit runs.

const rule = (code: string, weight: number, category = "crawler_access"): AuxCatalogRule => ({
  code, category, weight, ruleVersion: "t", thresholds: {},
});
const CRAWLER = [
  rule("AUX-R-001", 0.3), rule("AUX-R-002", 0.08), rule("AUX-R-003", 0.12), rule("AUX-R-004", 0.06),
  rule("AUX-R-005", 0.24), rule("AUX-R-006", 0.12), rule("AUX-R-007", 0.08),
];

describe("NEW-C-8 AC3 · catalog weight assertion", () => {
  it("NEW-C-8 AC3.1 · the specified crawler_access weights load", () => {
    const catalog = loadAuxCatalog(CRAWLER);
    expect(catalog.rules).toHaveLength(7);
    expect(catalog.byCode.get("AUX-R-005")?.weight).toBe(0.24);
  });

  it("NEW-C-8 AC3.2 · a category summing below one is refused", () => {
    const broken = CRAWLER.map((r) => (r.code === "AUX-R-001" ? { ...r, weight: 0.2 } : r));
    expect(() => loadAuxCatalog(broken)).toThrow(AuxCatalogWeightError);
  });

  it("NEW-C-8 AC3.3 · a category summing above one is refused", () => {
    expect(() => loadAuxCatalog([...CRAWLER, rule("AUX-R-099", 0.05)])).toThrow(AuxCatalogWeightError);
  });

  it("NEW-C-8 AC3.4 · tolerance is ±0.001 inclusive of float noise: 0.9995 and 1.0005 pass, 0.998 and 1.002 fail", () => {
    const withFirst = (w: number): AuxCatalogRule[] => CRAWLER.map((r) => (r.code === "AUX-R-001" ? { ...r, weight: w } : r));
    expect(() => assertCatalogWeights(withFirst(0.2995), ["crawler_access"])).not.toThrow();
    expect(() => assertCatalogWeights(withFirst(0.3005), ["crawler_access"])).not.toThrow();
    expect(() => assertCatalogWeights(withFirst(0.298), ["crawler_access"])).toThrow(AuxCatalogWeightError);
    expect(() => assertCatalogWeights(withFirst(0.302), ["crawler_access"])).toThrow(AuxCatalogWeightError);
  });

  it("NEW-C-8 AC3.5 · an empty catalog, or a required category with no rules, is refused (not a vacuous pass)", () => {
    expect(() => loadAuxCatalog([])).toThrow(AuxCatalogWeightError);
    expect(() => loadAuxCatalog(CRAWLER, ["crawler_access", "structured_data"])).toThrow(AuxCatalogWeightError);
  });

  it("NEW-C-8 AC3.6 · the error names the category and the sum, never a rule's text", () => {
    try {
      loadAuxCatalog([rule("AUX-R-001", 0.5)]);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AuxCatalogWeightError);
      expect((e as AuxCatalogWeightError).category).toBe("crawler_access");
      expect((e as AuxCatalogWeightError).sum).toBeCloseTo(0.5, 6);
    }
  });

  it("NEW-C-8 AC3.7 · a category not required is not asserted (the partial catalog of the demo seed)", () => {
    const partial = [...CRAWLER, rule("AUX-R-008", 0.14, "structured_data")];
    expect(() => loadAuxCatalog(partial)).not.toThrow();
  });
});
