// STORY-169 — `scoring-models.md` §7, restated in full in
// `aux-and-geo-analysis.md` §4 ("AUX score") and §2 ("the 34 AUX rules").
//
// ⚠ IMPORTS NOTHING. See prominence.ts. `clamp01` is redefined locally
// rather than imported from a sibling — every file in this directory stands
// alone, which is what `scoring-purity.spec.ts` asserts.
//
// Nothing calls this yet. `refreshProjectAux` (src/lib/rollup) denormalises
// the ALREADY-COMPUTED `aux_audits.aux_score` onto the project row; this
// function is the formula the (not-yet-built) crawl.audit handler will use
// to produce that stored score in the first place — STORY-062/063. It ships
// now, pure and tested against the formula, so the handler has nothing left
// to invent when it lands.

/** Clamp to [0,1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `aux-and-geo-analysis.md` §2 — the six rule categories, verbatim. */
export type AuxCategory = "crawler_access" | "structured_data" | "context_fitness" | "render_mode" | "entity_clarity" | "freshness";

/** §7 — `W_cat`. Sums to 1.000 by construction; a unit test pins that. */
export const AUX_CATEGORY_WEIGHTS: Readonly<Record<AuxCategory, number>> = Object.freeze({
  crawler_access: 0.28,
  structured_data: 0.22,
  context_fitness: 0.2,
  render_mode: 0.15,
  entity_clarity: 0.09,
  freshness: 0.06,
});

/** §7 — `severity_factor`, verbatim, `info` included because the catalog's own CHECK allows it. */
export const AUX_SEVERITY_FACTOR = Object.freeze({
  critical: 1.0,
  high: 0.6,
  medium: 0.3,
  low: 0.1,
  info: 0.0,
});

export type AuxSeverity = keyof typeof AUX_SEVERITY_FACTOR;

/** §7 — `scope(f)` is floored here, never below this. */
export const AUX_SCOPE_FLOOR = 0.25;

/** §7 — the hard cap on any critical `crawler_access` finding. */
export const AUX_HARD_CAP = 72;

/**
 * §7 — `scope(f) = affected_pages(f) / pages_crawled, floored at 0.25`.
 *
 * `pages_crawled <= 0` cannot happen on a completed audit (`aux_audits`
 * requires at least one fetched page to reach `status='completed'`), but a
 * defensive floor here is cheaper than a division producing `Infinity` a
 * caller then has to special-case.
 */
export function auxScope(affectedPages: number, pagesCrawled: number): number {
  if (pagesCrawled <= 0) return AUX_SCOPE_FLOOR;
  return Math.max(AUX_SCOPE_FLOOR, affectedPages / pagesCrawled);
}

/**
 * One finding, already reduced to the pieces §7's formula weighs.
 *
 * `ruleWeight` is `W(f.rule)` — `aux_rule_catalog.weight`, the rule's
 * contribution WITHIN its category, not the category weight itself.
 *
 * ⚠ ONLY FINDINGS THAT COUNT TOWARD THE SCORE BELONG HERE. §7 says "open
 * findings", and `schemas/aux.md`'s own lifecycle table is the disambiguation
 * this story's Technical Notes asked to record: `resolved` and `stale` are
 * plainly not open, and `wont_fix`'s own row states it explicitly —
 * "Excludes the finding from the score with a visible annotation." That
 * leaves `open`, `acknowledged`, `in_progress` and `regressed` (a reopened
 * finding, scored like any other open one) as the set this function expects.
 * Filtering lifecycle state is the CALLER's job — a producer reading
 * `aux_findings` — because this function has no notion of a database status
 * enum; it only ever sees findings someone has already decided count.
 */
export interface AuxCountedFinding {
  readonly category: AuxCategory;
  readonly severity: AuxSeverity;
  readonly ruleWeight: number;
  readonly affectedPages: number;
}

export interface AuxScoreInput {
  readonly findings: readonly AuxCountedFinding[];
  readonly pagesCrawled: number;
  /**
   * `max_penalty(cat) = Σ_{r ∈ rules in cat} W(r)`. §7 states this is
   * `1.000 by construction` — `NFR-AUX-03`'s catalog-load assertion is what
   * makes that true — so a category with no override here is treated as
   * exactly 1, which is the formula's own stated value rather than a
   * fallback invented here.
   */
  readonly categoryMaxPenalty?: Partial<Record<AuxCategory, number>>;
  /**
   * OWNER DECISION 38 (2026-10-30). The categories at least one rule of which was MEASURED. When given, the headline is computed over these only:
   * `100 * sum(W_cat * sub_cat) / sum(W_cat)` for the listed categories, so a category no rule could measure neither adds points nor costs them, and
   * the result is labelled `partial`. Absent = all six categories (the reference's formula, unchanged). An empty list is refused: there is no
   * score of nothing, and `null` (not measured) must never be turned into `0` here.
   */
  readonly evaluatedCategories?: readonly AuxCategory[];
  /**
   * OWNER DECISION 52 (2026-11-02), rule level. The rules that went unmeasured in this audit (held, or with no input). A non-empty list makes the result
   * `partial` even when every category was evaluated: a category scored without a rule is not a full measurement. The list does not change the arithmetic -
   * `categoryMaxPenalty` (see `auxDecidedBasis`) is what keeps an undecided rule from counting as passed.
   */
  readonly unmeasuredRules?: readonly string[];
}

/** A rule that was DECIDED in this audit, reduced to what the basis needs: its category and its catalog weight. */
export interface AuxDecidedRule {
  readonly category: AuxCategory;
  readonly weight: number;
}

/**
 * OWNER DECISION 52. A category is scored only on the rules that were actually decided: `max_penalty(cat)` is the sum of the DECIDED rules' weights in it, so a
 * rule nobody could judge is out of the denominator and so cannot count as passed. A category with no decided rule is absent from `categories` (it is
 * dropped, as decision 38 already did for a whole category). The result feeds `auxScore` as `evaluatedCategories` and `categoryMaxPenalty`.
 */
export function auxDecidedBasis(rules: readonly AuxDecidedRule[]): { readonly categories: readonly AuxCategory[]; readonly categoryMaxPenalty: Partial<Record<AuxCategory, number>> } {
  // Integer basis points (weights carry four decimals at most): the sum is exact and independent of the order of `rules`, so identical inputs give identical output.
  const basisPoints: Partial<Record<AuxCategory, number>> = {};
  for (const rule of rules) basisPoints[rule.category] = (basisPoints[rule.category] ?? 0) + Math.round(rule.weight * 10_000);
  const categoryMaxPenalty: Partial<Record<AuxCategory, number>> = {};
  for (const c of AUX_CATEGORIES) if ((basisPoints[c] ?? 0) > 0) categoryMaxPenalty[c] = basisPoints[c]! / 10_000;
  return { categories: AUX_CATEGORIES.filter((c) => (categoryMaxPenalty[c] ?? 0) > 0), categoryMaxPenalty };
}

export interface AuxScoreResult {
  /** 0–100, rounded to one decimal — §7's `round(..., 1)`. */
  readonly score: number;
  /** True only when the hard cap actually changed the value. */
  readonly capped: boolean;
  readonly subscores: Readonly<Record<AuxCategory, number>>;
  /** True when `score` leaves categories out (`evaluatedCategories` named fewer than six) OR any rule went unmeasured (`unmeasuredRules`, decision 52). */
  readonly partial: boolean;
  /** The categories left out of `score`, in the reference's order. */
  readonly unmeasured: readonly AuxCategory[];
}

const AUX_CATEGORIES = Object.keys(AUX_CATEGORY_WEIGHTS) as readonly AuxCategory[];

/**
 * §7 — the full AUX score computation.
 *
 * `penalty(cat)` sums `W(f.rule) · severity_factor(f.severity) · scope(f)`
 * over the counted findings in that category; `subscore(cat)` is
 * `clamp01(1 − penalty(cat) / max_penalty(cat))`; the headline score is the
 * category-weighted sum of the six subscores, rounded, THEN capped at 72 if
 * any counted `crawler_access` finding is `critical` — the cap applies to
 * the rounded figure, not the raw one, matching §7's own statement order.
 */
export function auxScore(input: AuxScoreInput): AuxScoreResult {
  const evaluated = input.evaluatedCategories === undefined ? AUX_CATEGORIES : AUX_CATEGORIES.filter((c) => input.evaluatedCategories!.includes(c));
  if (evaluated.length === 0) throw new RangeError("auxScore needs at least one evaluated category: there is no score of nothing");
  const unmeasured = AUX_CATEGORIES.filter((c) => !evaluated.includes(c));
  const subscores = {} as Record<AuxCategory, number>;
  let hasCriticalCrawlerAccess = false;

  for (const category of AUX_CATEGORIES) {
    const categoryFindings = input.findings.filter((finding) => finding.category === category);
    // A finding in a category nobody measured does not move the score (the category is out of it); its subscore is still reported, as it always was.
    const maxPenalty = input.categoryMaxPenalty?.[category] ?? 1;
    const penalty = categoryFindings.reduce(
      (total, finding) =>
        total + finding.ruleWeight * AUX_SEVERITY_FACTOR[finding.severity] * auxScope(finding.affectedPages, input.pagesCrawled),
      0,
    );
    subscores[category] = clamp01(1 - penalty / maxPenalty);

    if (category === "crawler_access" && evaluated.includes(category) && categoryFindings.some((finding) => finding.severity === "critical")) {
      hasCriticalCrawlerAccess = true;
    }
  }

  const weighted = evaluated.reduce((total, category) => total + AUX_CATEGORY_WEIGHTS[category] * subscores[category], 0);
  // With all six evaluated the sum is 1.000 by construction (a unit test pins it): use 1 itself so the full score is the reference's formula to the bit.
  const weightSum = unmeasured.length === 0 ? 1 : evaluated.reduce((total, category) => total + AUX_CATEGORY_WEIGHTS[category], 0);
  const rounded = Number(((100 * weighted) / weightSum).toFixed(1));
  const score = hasCriticalCrawlerAccess ? Math.min(rounded, AUX_HARD_CAP) : rounded;

  return { score, capped: hasCriticalCrawlerAccess && rounded > AUX_HARD_CAP, subscores, partial: unmeasured.length > 0 || (input.unmeasuredRules?.length ?? 0) > 0, unmeasured };
}
