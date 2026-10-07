// STORY-056 — `scoring-models.md` §9, the D1 displacement impact score.
// (The formula was first written under STORY-041 in visibility.ts; moved here
// verbatim so the story's named file owns it. Public names are unchanged.)
//
// ⚠ THIS FILE IMPORTS NOTHING (scoring-purity.spec.ts).

/** §9's `class_penalty` table, verbatim. */
export const CLASS_PENALTY = Object.freeze({
  recommendation_to_absent: 1.0,
  recommendation_to_ranked: 0.55,
  ranked_to_also_consider: 0.4,
  any_to_caveat: 0.7,
  render_downgrade_only: 0.25,
});

export type ClassPenaltyKind = keyof typeof CLASS_PENALTY;

/** §4 of `schemas/projects-and-prompts.md`, restated in §9: decision 1.00 · consideration 0.70 · awareness 0.40. */
export const COMMERCIAL_INTENT = Object.freeze({ decision: 1.0, consideration: 0.7, awareness: 0.4 });

export type FunnelStage = keyof typeof COMMERCIAL_INTENT;

export const IMPACT_WEIGHTS = Object.freeze({
  positionLoss: 0.35,
  classPenalty: 0.25,
  promptWeight: 0.2,
  engineWeight: 0.1,
  recoverability: 0.1,
});

export interface DisplacementInput {
  /** True when the brand left the answer entirely, rather than moving down it. */
  readonly presenceLost: boolean;
  readonly beforePosition: number | null;
  readonly afterPosition: number | null;
  /** `null` = the §9 table has no row for this transition; the term is 0. */
  readonly classPenalty: ClassPenaltyKind | null;
  readonly funnelStage: FunnelStage;
  /** 1-based rank of the prompt's topic by intent, for `1 / rank`. */
  readonly topicRankByIntent: number;
  readonly engineWeight: number;
  readonly maxEngineWeight: number;
  /** How many citations the brand would need to close the gap. */
  readonly citationGap: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * §9 — how much a displacement is worth acting on.
 *
 * **`recoverability` RAISES the score rather than lowering it**, and §9
 * explains the apparent inversion: "The feed exists to drive action. A loss
 * the brand can plausibly recover — a two-citation gap on a seedable domain —
 * deserves more attention than a loss to an incumbent with forty citations.
 * Unrecoverable losses are still recorded and still visible; they simply do
 * not crowd the top of the queue."
 */
export function displacementImpact(input: DisplacementInput): number {
  const positionLoss = input.presenceLost
    ? 1
    : input.afterPosition !== null && input.beforePosition !== null && input.afterPosition !== 0
      ? clamp01((input.afterPosition - input.beforePosition) / input.afterPosition)
      : 0;

  const promptWeight =
    0.5 * COMMERCIAL_INTENT[input.funnelStage] + 0.5 * (1 / Math.max(1, input.topicRankByIntent));
  const engineWeight = input.maxEngineWeight === 0 ? 0 : input.engineWeight / input.maxEngineWeight;
  const recoverability = 1 - Math.min(1, Math.abs(input.citationGap) / 5);

  return (
    100 *
    clamp01(
      IMPACT_WEIGHTS.positionLoss * positionLoss +
        IMPACT_WEIGHTS.classPenalty * (input.classPenalty === null ? 0 : CLASS_PENALTY[input.classPenalty]) +
        IMPACT_WEIGHTS.promptWeight * promptWeight +
        IMPACT_WEIGHTS.engineWeight * engineWeight +
        IMPACT_WEIGHTS.recoverability * recoverability,
    )
  );
}

export type DisplacementKind = "presence_lost" | "position_lost" | "recommendation_lost" | "render_downgraded";

/**
 * Which row of §9's `class_penalty` table a detected displacement falls under.
 *
 * `null` means the table has no row for it and the penalty term is 0. Two
 * readings are FLAGGED FOR THE SPEC: `recommendation -> neutral_list` is taken
 * as the `recommendation_to_ranked` demotion, and a position-only loss inside
 * one class has no row (0). A THIRD is flagged too: `presence_lost` from ANY
 * before class takes `recommendation_to_absent` (1.00), because §9 has a row only
 * for recommendation -> absent. A brand leaving a negative caveat therefore scores
 * the maximum. Spec-owner ruling needed; behaviour is pinned by a test until then.
 *
 * Each kind is scored on its own dimension: `render_downgraded` is the "render
 * downgrade only" row (and carries no position loss, see
 * `displacementImpactForEvent`); `any_to_caveat` needs the class to CHANGE.
 */
export function classPenaltyKindFor(
  kind: DisplacementKind,
  beforeClass: string | null,
  afterClass: string | null,
): ClassPenaltyKind | null {
  if (kind === "presence_lost") return "recommendation_to_absent";
  if (kind === "render_downgraded") return "render_downgrade_only";
  if (afterClass === "caveat" && beforeClass !== "caveat") return "any_to_caveat";
  if (beforeClass === "recommendation" && (afterClass === "ranked" || afterClass === "neutral_list")) {
    return "recommendation_to_ranked";
  }
  if (beforeClass === "ranked" && afterClass === "also_consider") return "ranked_to_also_consider";
  return null;
}

export interface DisplacementEventInput {
  readonly kind: DisplacementKind;
  readonly beforePosition: number | null;
  readonly afterPosition: number | null;
  readonly beforeClass: string | null;
  readonly afterClass: string | null;
  readonly funnelStage: FunnelStage;
  readonly topicRankByIntent: number;
  readonly engineWeight: number;
  readonly maxEngineWeight: number;
  readonly citationGap: number;
}

/**
 * §9 position_loss is "if position only": only a `position_lost` (or a lost
 * presence) event carries it. `recommendation_lost` and `render_downgraded` are
 * scored on their class row alone, so one answer change is not counted three times.
 */
export function displacementImpactForEvent(e: DisplacementEventInput): number {
  const carriesPosition = e.kind === "presence_lost" || e.kind === "position_lost";
  return displacementImpact({
    presenceLost: e.kind === "presence_lost",
    beforePosition: carriesPosition ? e.beforePosition : null,
    afterPosition: carriesPosition ? e.afterPosition : null,
    classPenalty: classPenaltyKindFor(e.kind, e.beforeClass, e.afterClass),
    funnelStage: e.funnelStage,
    topicRankByIntent: e.topicRankByIntent,
    engineWeight: e.engineWeight,
    maxEngineWeight: e.maxEngineWeight,
    citationGap: e.citationGap,
  });
}
