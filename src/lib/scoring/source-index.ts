// NEW-C-4 / STORY-054 — `scoring-models.md` §5 (source context weight and
// gap severity) and `aux-and-geo-analysis.md` §10 (seedability).
//
// ⚠ IMPORTS NOTHING. See prominence.ts.

export interface SourceWeightInput {
  /** `raw(d)` — Σ position_weight over the domain's citations in the window. */
  readonly rawWeight: number;
  /** Distinct prompts that cited the domain in the window. */
  readonly distinctPrompts: number;
}

/**
 * §5 — `context_weight(d) = raw(d)·(0.70 + 0.30·breadth(d)) / Σ raw(d')·(…)`,
 * `breadth(d) = distinct_prompts(d) / |P(T)|`, normalised to sum to 1.
 *
 * Breadth is capped at 1 (a caller passing a denominator smaller than the
 * numerator should not inflate a domain past the formula's range) and is 0
 * when the window has no prompts. A zero total yields all zeros, never NaN.
 * Output order matches input order.
 */
export function sourceContextWeights(domains: readonly SourceWeightInput[], totalPrompts: number): number[] {
  const scaled = domains.map((domain) => {
    const breadth = totalPrompts > 0 ? Math.min(1, domain.distinctPrompts / totalPrompts) : 0;
    return domain.rawWeight * (0.7 + 0.3 * breadth);
  });
  const total = scaled.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return scaled.map(() => 0);
  return scaled.map((value) => value / total);
}

export interface GapSeverityInput {
  readonly contextWeight: number;
  /** `null` = not yet verified by fetching. Absence is never assumed. */
  readonly brandPresent: boolean | null;
  readonly isSeedable: boolean;
}

/**
 * §5 — critical >= 0.15 and high >= 0.08 only on SEEDABLE domains; medium
 * >= 0.03; low > 0; none otherwise or when the brand is present.
 *
 * `null` when presence is unverified: the spec says presence is verified by
 * fetching, never assumed, so neither "gap" nor "no gap" may be asserted.
 */
export function gapSeverity(input: GapSeverityInput): "none" | "low" | "medium" | "high" | "critical" | null {
  if (input.brandPresent === null) return null;
  if (input.brandPresent) return "none";
  const weight = input.contextWeight;
  if (weight >= 0.15 && input.isSeedable) return "critical";
  if (weight >= 0.08 && input.isSeedable) return "high";
  if (weight >= 0.03) return "medium";
  if (weight > 0) return "low";
  return "none";
}

const SEEDABLE_CLASSES: ReadonlySet<string> = new Set([
  "community_forum",
  "review_marketplace",
  "developer_platform",
  "news_media",
  "blog",
]);

/**
 * §10 table. `encyclopedic` is "partial" in the reference (edits only via
 * talk-page suggestion) and is treated as NOT seedable, so it can never raise
 * an authority task. A competitor-owned domain is never seedable.
 */
export function isSeedableSourceClass(sourceClass: string, isCompetitorOwned: boolean): boolean {
  if (isCompetitorOwned) return false;
  return SEEDABLE_CLASSES.has(sourceClass);
}
