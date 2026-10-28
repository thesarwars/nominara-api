import { describe, expect, it } from "vitest";
import { readCatalogSql } from "../../../test/support/aux-catalog-sql.js";
import { AUX_CATEGORY_WEIGHTS } from "../scoring/aux.js";
import { AuxCatalogWeightError, assertCategoryWeights, loadAuxCatalog, type AuxCatalogRule } from "./catalog.js";

// STORY-051 AC6 — the loader asserts every category's weight sum AND the category weight sum, on load. These run against the
// catalog the migrations define, so a weight typo in the data is what fails, not a constant in a test.

const FULL = readCatalogSql();
const withWeight = (code: string, w: number): AuxCatalogRule[] => FULL.map((r) => (r.code === code ? { ...r, weight: w } : r));

describe("STORY-051 · full catalog load", () => {
  it("STORY-051 AC6 · the migrated catalog holds 34 rules in six categories and loads", () => {
    expect(FULL).toHaveLength(34);
    const catalog = loadAuxCatalog(FULL);
    expect(new Set(catalog.rules.map((r) => r.category))).toEqual(new Set(Object.keys(AUX_CATEGORY_WEIGHTS)));
  });

  it("STORY-051 #4 · reducing any category's weight sum below one makes the loader refuse", () => {
    for (const code of ["AUX-R-001", "AUX-R-008", "AUX-R-019", "AUX-R-026", "AUX-R-030", "AUX-R-032"]) {
      const w = FULL.find((r) => r.code === code)!.weight;
      expect(() => loadAuxCatalog(withWeight(code, w - 0.01)), code).toThrow(AuxCatalogWeightError);
    }
  });

  it("STORY-051 #5 · raising a category's weight sum above one makes the loader refuse", () => {
    for (const code of ["AUX-R-008", "AUX-R-021", "AUX-R-029", "AUX-R-031", "AUX-R-034"]) {
      const w = FULL.find((r) => r.code === code)!.weight;
      expect(() => loadAuxCatalog(withWeight(code, w + 0.01)), code).toThrow(AuxCatalogWeightError);
    }
  });

  it("STORY-051 AC6 · a category missing from the catalog is refused by default, not passed vacuously", () => {
    expect(() => loadAuxCatalog(FULL.filter((r) => r.category !== "freshness"))).toThrow(/freshness.*no rules/);
  });

  it("STORY-051 AC6 · the category weights are asserted to sum to 1.000 +/- 0.001", () => {
    expect(() => assertCategoryWeights(AUX_CATEGORY_WEIGHTS)).not.toThrow();
    expect(() => assertCategoryWeights({ ...AUX_CATEGORY_WEIGHTS, freshness: 0.0605 })).not.toThrow();
    expect(() => assertCategoryWeights({ ...AUX_CATEGORY_WEIGHTS, freshness: 0.058 })).toThrow(AuxCatalogWeightError);
    expect(() => assertCategoryWeights({ ...AUX_CATEGORY_WEIGHTS, freshness: 0.062 })).toThrow(AuxCatalogWeightError);
  });

  it("STORY-051 AC6 · loadAuxCatalog applies the category-weight assertion too", () => {
    expect(() => loadAuxCatalog(FULL, undefined, { ...AUX_CATEGORY_WEIGHTS, render_mode: 0.2 })).toThrow(AuxCatalogWeightError);
  });

  it("STORY-051 AC12 · the catalog's auto-fix flags are exactly the twenty fixable rules; the fourteen others are guidance rules", () => {
    expect(FULL.filter((r) => !r.autoFixable)).toHaveLength(14);
  });
});
