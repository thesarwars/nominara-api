// STORY-051 AC6 — the AUX rule-catalog loader and its weight assertion (aux-and-geo-analysis.md section 4, NFR-AUX-03).
//
// A category whose weights sum below 1 cannot reach its full penalty, so every
// audited page silently scores better than it should: no error, nothing in the
// output, visible only in the catalog. The catalog is versioned DATA, so the
// check runs here, on load, and not only in CI. It covers every rule's weight
// within its category AND the six category weights, and it requires all six
// categories by default: a category with no rules is refused, not passed.
//
// Pure: it takes rows the caller already read, so it neither reads the table
// (the audit service does) nor holds a clock.

import { AUX_CATEGORY_WEIGHTS } from "../scoring/aux.js";

export interface AuxCatalogRule {
  readonly code: string;
  readonly category: string;
  readonly weight: number;
  readonly ruleVersion: string;
  /** The catalog's own claim; the engine refuses a rule whose code disagrees (STORY-051 AC12). */
  readonly autoFixable: boolean;
  readonly thresholds: Readonly<Record<string, unknown>>;
}

export interface AuxCatalog {
  readonly rules: readonly AuxCatalogRule[];
  readonly byCode: ReadonlyMap<string, AuxCatalogRule>;
}

/** NFR-AUX-03: Σ W(r) = 1.000 ± 0.001. */
export const AUX_WEIGHT_TOLERANCE = 0.001;
export const DEFAULT_REQUIRED_CATEGORIES: readonly string[] = Object.keys(AUX_CATEGORY_WEIGHTS);

export class AuxCatalogWeightError extends Error {
  constructor(
    readonly category: string,
    readonly sum: number | null,
    reason: string,
  ) {
    super(`aux rule catalog refused: category ${category} ${reason}`);
    this.name = "AuxCatalogWeightError";
  }
}

export function assertCatalogWeights(
  rules: readonly AuxCatalogRule[],
  requiredCategories: readonly string[] = DEFAULT_REQUIRED_CATEGORIES,
): void {
  const sums = new Map<string, number>();
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.code)) throw new AuxCatalogWeightError(rule.category, null, `lists rule ${rule.code} twice`);
    seen.add(rule.code);
    if (!Number.isFinite(rule.weight)) throw new AuxCatalogWeightError(rule.category, null, `has a non-finite weight on rule ${rule.code}`);
    sums.set(rule.category, (sums.get(rule.category) ?? 0) + rule.weight);
  }
  for (const category of requiredCategories) {
    const sum = sums.get(category);
    if (sum === undefined) throw new AuxCatalogWeightError(category, null, "has no rules");
    if (Math.abs(sum - 1) > AUX_WEIGHT_TOLERANCE + 1e-9) {
      throw new AuxCatalogWeightError(category, sum, `weights sum to ${sum.toFixed(4)}, expected 1.000 ± ${AUX_WEIGHT_TOLERANCE}`);
    }
  }
}

/**
 * NFR-AUX-03: Σ W_cat = 1.000 ± 0.001. W_cat lives in code (AUX_CATEGORY_WEIGHTS), not in the catalog, so this checks the code constants and
 * a data change cannot trip it: the load-time guarantee against bad DATA covers the per-rule weights (assertCatalogWeights) only.
 */
export function assertCategoryWeights(weights: Readonly<Record<string, number>> = AUX_CATEGORY_WEIGHTS): void {
  const sum = Object.values(weights).reduce((total, w) => total + w, 0);
  if (Math.abs(sum - 1) > AUX_WEIGHT_TOLERANCE + 1e-9) {
    throw new AuxCatalogWeightError("(all categories)", sum, `category weights sum to ${sum.toFixed(4)}, expected 1.000 ± ${AUX_WEIGHT_TOLERANCE}`);
  }
}

export function loadAuxCatalog(
  rules: readonly AuxCatalogRule[],
  requiredCategories: readonly string[] = DEFAULT_REQUIRED_CATEGORIES,
  categoryWeights: Readonly<Record<string, number>> = AUX_CATEGORY_WEIGHTS,
): AuxCatalog {
  assertCategoryWeights(categoryWeights);
  assertCatalogWeights(rules, requiredCategories);
  return { rules, byCode: new Map(rules.map((r) => [r.code, r])) };
}
