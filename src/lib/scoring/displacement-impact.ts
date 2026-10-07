// STORY-056 — `scoring-models.md` §9, the D1 displacement impact score.
//
// ⚠ THIS FILE IMPORTS NOTHING (scoring-purity.spec.ts). Every input is an
// argument; the clamp is local.

export type DisplacementKind = "presence_lost" | "position_lost" | "recommendation_lost" | "render_downgraded";
export type FunnelStage = "decision" | "consideration" | "awareness";
export type PositionClass = "recommendation" | "ranked" | "neutral_list" | "also_consider" | "caveat";

/** §9 — `commercial_intent(p)`. */
export const COMMERCIAL_INTENT = Object.freeze({ decision: 1.0, consideration: 0.7, awareness: 0.4 });

/** §9 — the impact weights. */
export const IMPACT_WEIGHTS = Object.freeze({
  positionLoss: 0.35,
  classPenalty: 0.25,
  promptWeight: 0.2,
  engineWeight: 0.1,
  recoverability: 0.1,
});

/** §9 — a gap of this many citations or more is wholly unrecoverable. */
export const RECOVERABILITY_GAP_CEILING = 5;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * §9 `class_penalty`. The table names five transitions; the rest follow the
 * kind. Unlisted transitions that change no class (a position-only loss inside
 * one class) carry 0, and `recommendation → neutral_list` is treated as the
 * `recommendation → ranked` demotion (0.55). Both are flagged for the spec.
 */
export function classPenalty(
  kind: DisplacementKind,
  beforeClass: PositionClass | null,
  afterClass: PositionClass | null,
): number {
  if (kind === "presence_lost") return 1.0;
  if (afterClass === "caveat") return 0.7;
  if (beforeClass === "recommendation" && (afterClass === "ranked" || afterClass === "neutral_list")) return 0.55;
  if (beforeClass === "ranked" && afterClass === "also_consider") return 0.4;
  if (kind === "render_downgraded") return 0.25;
  return 0;
}

export interface DisplacementImpactInput {
  readonly kind: DisplacementKind;
  readonly beforePosition: number | null;
  /** `null` when presence was lost entirely. */
  readonly afterPosition: number | null;
  readonly beforeClass: PositionClass | null;
  readonly afterClass: PositionClass | null;
  readonly funnel: FunnelStage;
  /** `rank_of_topic_by_intent`, 1-based. Topic clusters do not exist yet: callers pass 1. */
  readonly topicRank: number;
  readonly engineWeight: number;
  readonly maxEngineWeight: number;
  readonly citationGapCount: number;
}

/** §9 `impact_score`, 0..100. */
export function displacementImpact(input: DisplacementImpactInput): number {
  const positionLoss =
    input.afterPosition === null || input.kind === "presence_lost"
      ? 1
      : input.beforePosition === null || input.afterPosition <= 0
        ? 0
        : clamp01((input.afterPosition - input.beforePosition) / input.afterPosition);
  const penalty = classPenalty(input.kind, input.beforeClass, input.afterClass);
  const promptWeight =
    0.5 * COMMERCIAL_INTENT[input.funnel] + 0.5 * (1 / Math.max(1, input.topicRank));
  const engineWeight = input.maxEngineWeight > 0 ? clamp01(input.engineWeight / input.maxEngineWeight) : 0;
  const recoverability = 1 - Math.min(1, Math.abs(input.citationGapCount) / RECOVERABILITY_GAP_CEILING);

  return (
    100 *
    clamp01(
      IMPACT_WEIGHTS.positionLoss * positionLoss +
        IMPACT_WEIGHTS.classPenalty * penalty +
        IMPACT_WEIGHTS.promptWeight * promptWeight +
        IMPACT_WEIGHTS.engineWeight * engineWeight +
        IMPACT_WEIGHTS.recoverability * recoverability,
    )
  );
}
