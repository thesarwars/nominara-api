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
}

export interface AuxScoreResult {
  /** 0–100, rounded to one decimal — §7's `round(..., 1)`. */
  readonly score: number;
  /** True only when the hard cap actually changed the value. */
  readonly capped: boolean;
  readonly subscores: Readonly<Record<AuxCategory, number>>;
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
  const subscores = {} as Record<AuxCategory, number>;
  let hasCriticalCrawlerAccess = false;

  for (const category of AUX_CATEGORIES) {
    const categoryFindings = input.findings.filter((finding) => finding.category === category);
    const maxPenalty = input.categoryMaxPenalty?.[category] ?? 1;
    const penalty = categoryFindings.reduce(
      (total, finding) =>
        total + finding.ruleWeight * AUX_SEVERITY_FACTOR[finding.severity] * auxScope(finding.affectedPages, input.pagesCrawled),
      0,
    );
    subscores[category] = clamp01(1 - penalty / maxPenalty);

    if (category === "crawler_access" && categoryFindings.some((finding) => finding.severity === "critical")) {
      hasCriticalCrawlerAccess = true;
    }
  }

  const weighted = AUX_CATEGORIES.reduce((total, category) => total + AUX_CATEGORY_WEIGHTS[category] * subscores[category], 0);
  const rounded = Number((100 * weighted).toFixed(1));
  const score = hasCriticalCrawlerAccess ? Math.min(rounded, AUX_HARD_CAP) : rounded;

  return { score, capped: hasCriticalCrawlerAccess && rounded > AUX_HARD_CAP, subscores };
}
