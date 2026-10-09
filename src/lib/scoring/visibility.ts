// STORY-041 — `scoring-models.md` §3 and §9.
//
// ⚠ IMPORTS NOTHING. See prominence.ts.

/**
 * §3's weights.
 *
 * AC8 — "weights read from CONFIGURATION rather than hardcoded". The
 * reference puts them in `plans.entitlements.scoring_weights`, and the story
 * says why it matters: "an override is surfaced in the interface and stamped
 * into every export rather than being invisible." So this is the DEFAULT, and
 * `visibilityScore` takes weights as an argument.
 *
 * **Weight rationale, from §3, because a reviewer will ask.** "Presence
 * dominates because being absent is the failure mode that matters. Share of
 * voice refines presence into competitive standing. Citation share measures
 * whether the brand's own properties are entering the corpus — the actionable
 * lever. Sentiment quality guards against 'visible but disparaged'."
 */
export interface VisibilityWeights {
  readonly presence: number;
  readonly shareOfVoice: number;
  readonly citationShare: number;
  readonly sentimentQuality: number;
}

/**
 * DECLARED AS AN INTERFACE, not inferred from the default.
 *
 * `typeof DEFAULT_VISIBILITY_WEIGHTS` on a frozen literal narrows every field
 * to its own value — `presence: 0.4` rather than `presence: number` — so an
 * Enterprise override would not type-check against it. That would make AC8's
 * "weights read from configuration" impossible to satisfy while looking
 * correct. Caught by the test that passes a presence-heavy override.
 */
export const DEFAULT_VISIBILITY_WEIGHTS: VisibilityWeights = Object.freeze({
  presence: 0.4,
  shareOfVoice: 0.25,
  citationShare: 0.2,
  sentimentQuality: 0.15,
});

export interface VisibilityComponents {
  /** §3 — `PresenceRate(T)`, in [0,1]. */
  readonly presenceRate: number | null;
  /** §2.3 — `SoV(b, T)`, in [0,1]. */
  readonly shareOfVoice: number | null;
  /** §4 — `citation_share`, in [0,1]. */
  readonly citationShare: number | null;
  /** §6 — `SentimentScore(T)` in [0,100]; §3 divides it by 100. */
  readonly sentimentScore: number | null;
}

/**
 * §3 — the headline 0–100 composite.
 *
 * A NULL COMPONENT CONTRIBUTES NOTHING AND TAKES ITS WEIGHT WITH IT. The
 * reference gives four weights summing to 1 and assumes four numbers; it does
 * not say what to do when a component has no data, and three of them can
 * legitimately be null — a project with no citations has no citation share, a
 * project with no mentions has no sentiment.
 *
 * The alternatives are worse in the same way: substituting 0 for a null
 * component states that the brand scored zero on it, which for citation share
 * means "cited, none of them mine" rather than "nothing cited anything".
 * Substituting 0.5 invents a measurement. RENORMALISING over the components
 * that exist is the only option that neither invents data nor penalises its
 * absence — a project with presence and share but no citations is scored on
 * presence and share.
 *
 * NULL WHEN NOTHING IS MEASURABLE, never 0. A score of 0 is a real, terrible
 * result; no data is not a result at all.
 */
export function visibilityScore(
  components: VisibilityComponents,
  weights: VisibilityWeights = DEFAULT_VISIBILITY_WEIGHTS,
): number | null {
  const parts: { value: number; weight: number }[] = [];
  if (components.presenceRate !== null) parts.push({ value: components.presenceRate, weight: weights.presence });
  if (components.shareOfVoice !== null) parts.push({ value: components.shareOfVoice, weight: weights.shareOfVoice });
  if (components.citationShare !== null) parts.push({ value: components.citationShare, weight: weights.citationShare });
  if (components.sentimentScore !== null) {
    parts.push({ value: components.sentimentScore / 100, weight: weights.sentimentQuality });
  }

  const weightTotal = parts.reduce((total, part) => total + part.weight, 0);
  if (parts.length === 0 || weightTotal === 0) return null;

  const weighted = parts.reduce((total, part) => total + part.weight * part.value, 0);
  return 100 * (weighted / weightTotal);
}

/**
 * §3 — the `engine_key='all'` row, computed in a second pass from the
 * per-engine rows.
 *
 * `VisibilityScore(T, all) = Σ_e w_e · VisibilityScore(T, e) / Σ_e w_e`.
 * An engine whose own score is null is not blended in at zero — it is left
 * out, for the same reason a failed cell is.
 */
export function blendAcrossEngines(
  perEngine: readonly { readonly score: number | null; readonly engineWeight: number }[],
): number | null {
  const scored = perEngine.filter((engine) => engine.score !== null);
  const weightTotal = scored.reduce((total, engine) => total + engine.engineWeight, 0);
  if (scored.length === 0 || weightTotal === 0) return null;
  return scored.reduce((total, engine) => total + engine.engineWeight * engine.score!, 0) / weightTotal;
}

// ───────────────────────── §3's confidence band ─────────────────────────

export type Confidence = "low" | "medium" | "high";

/** §3 — `low` under 30 cells, `medium` to 120, `high` above. */
export const CONFIDENCE_THRESHOLDS = Object.freeze({ medium: 30, high: 120 });

export function confidenceFor(measuredCells: number): Confidence {
  if (measuredCells < CONFIDENCE_THRESHOLDS.medium) return "low";
  if (measuredCells < CONFIDENCE_THRESHOLDS.high) return "medium";
  return "high";
}

/**
 * §3 — `half_width = 1.96 · 100 · sqrt(PresenceRate·(1 − PresenceRate) / n)`,
 * "a Wald interval on the dominant component".
 *
 * Null when there is nothing to bound. A zero half-width would claim
 * certainty about a score derived from no cells, which is the opposite of
 * what a confidence band is for.
 */
export function confidenceHalfWidth(presenceRate: number | null, measuredCells: number): number | null {
  if (presenceRate === null || measuredCells <= 0) return null;
  return 1.96 * 100 * Math.sqrt((presenceRate * (1 - presenceRate)) / measuredCells);
}

/**
 * §3's Deltas — `visibility_delta_30d = VisibilityScore(last 30d) −
 * VisibilityScore(prior 30d)`, on aligned window lengths.
 *
 * ⚠ **NULL, NOT ZERO, WHEN EITHER WINDOW IS UNDER-SAMPLED.** `NFR-ANL-03`
 * forbids emitting a trend delta at `n < 30`, and §3 spells out the rule for
 * the delta specifically: "If either window has `n < 30`, the delta is
 * `null`, not `0`."
 *
 * A zero delta is a claim that nothing changed. On a four-cell project it is
 * a claim nobody is entitled to make, and it renders as a flat trend arrow —
 * the most confident-looking thing in the interface.
 */
export function visibilityDelta(
  current: { readonly score: number | null; readonly measuredCells: number },
  prior: { readonly score: number | null; readonly measuredCells: number },
): number | null {
  if (current.score === null || prior.score === null) return null;
  if (current.measuredCells < CONFIDENCE_THRESHOLDS.medium) return null;
  if (prior.measuredCells < CONFIDENCE_THRESHOLDS.medium) return null;
  return current.score - prior.score;
}

// ───────────────────────── §9 displacement impact ─────────────────────────
