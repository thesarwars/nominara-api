// NEW-C-8 (STORY-051 subset) — the AUX rule-catalog loader and its weight
// assertion (aux-and-geo-analysis.md §4, NFR-AUX-03).
//
// A category whose weights sum below 1 cannot reach its full penalty, so every
// audited page silently scores better than it should: no error, nothing in the
// output, visible only in the catalog. The catalog is versioned DATA, so the
// check runs here, on load, and not only in CI.
//
// Pure: it takes rows the caller already read, so it neither reads the table
// (the audit service will) nor holds a clock. Only `crawler_access` is
// required by default because that is the one category the catalog is
// complete for today; the demo seed's partial rows in other categories are not
// asserted until the story that completes them lists them in `required`.

export interface AuxCatalogRule {
  readonly code: string;
  readonly category: string;
  readonly weight: number;
  readonly ruleVersion: string;
  readonly thresholds: Readonly<Record<string, unknown>>;
}

export interface AuxCatalog {
  readonly rules: readonly AuxCatalogRule[];
  readonly byCode: ReadonlyMap<string, AuxCatalogRule>;
}

/** NFR-AUX-03: Σ W(r) = 1.000 ± 0.001. */
export const AUX_WEIGHT_TOLERANCE = 0.001;
export const DEFAULT_REQUIRED_CATEGORIES: readonly string[] = ["crawler_access"];

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

export function loadAuxCatalog(
  rules: readonly AuxCatalogRule[],
  requiredCategories: readonly string[] = DEFAULT_REQUIRED_CATEGORIES,
): AuxCatalog {
  assertCatalogWeights(rules, requiredCategories);
  return { rules, byCode: new Map(rules.map((r) => [r.code, r])) };
}
