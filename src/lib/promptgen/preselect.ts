import type { GeneratableArchetype } from "../../../contracts/prompts/index.js";

// STORY-046 — `FR-CRD-07`: "Pre-selection maximises archetype breadth — one
// per family before any second pick."
//
// §10's worked example is the whole requirement:
//
//   "This topic generated 15 conversational prompts. You have 8 of 40 slots
//    left. We've pre-selected 8 that preserve the widest buyer-intent
//    coverage."
//
// WHY BREADTH BEATS RANK, in the story's own words: "Filling by rank alone
// would take five recommendation variants before the first comparison
// prompt, which is worse coverage from the same number of slots." A prompt
// set missing the comparison and objection archetypes measures a DIFFERENT
// THING than one that has them — so a capped project must lose depth, not
// coverage, or its Visibility Score is not comparable to anyone else's.
//
// PURE, and deliberately separate from the activation service: this is the
// one piece of that story with a non-obvious algorithm, and it is worth being
// able to test it over a hand-built candidate set rather than through a
// transaction.

export interface ActivatableCandidate {
  readonly promptId: string;
  readonly archetype: GeneratableArchetype;
  /** STORY-045's archetype weight — the documented funnel-stage scale. */
  readonly weight: number;
  /** STORY-045's specificity tiebreak — slots filled from real context. */
  readonly contextSlotCount: number;
}

/**
 * The subset to activate, at most `slots` long.
 *
 * ROUND-ROBIN OVER ARCHETYPES, not a sort. Every archetype contributes its
 * best remaining candidate before any archetype contributes a second — which
 * is what "one per family before any second pick" says, and what a single
 * `sort` by rank cannot express however the comparator is written.
 *
 * Within a round the STORY-045 ranking still decides which family goes next:
 * weight first (the documented funnel-stage scale), then slot specificity,
 * then input order. That last rule matters more than it looks — without it
 * the final slot goes to whichever candidate an iteration happened to yield
 * first, and a customer who re-opens the activation dialog sees a different
 * pre-selection over identical data.
 */
export function preselectForActivation(
  candidates: readonly ActivatableCandidate[],
  slots: number,
): readonly ActivatableCandidate[] {
  // `cap - active` goes negative when a plan downgrade lowers a cap below the
  // current active count. Clamped rather than trusted: that must not throw in
  // the activation dialog, it means no slots, and the prompts already active
  // are NOT retroactively deactivated.
  const available = Math.max(0, Math.trunc(slots));
  if (available === 0 || candidates.length === 0) return [];

  // Grouped in first-appearance order, and each group's members ranked once.
  // `index` is carried so the final tiebreak is the caller's own ordering
  // rather than anything this function invents.
  const groups = new Map<GeneratableArchetype, { candidate: ActivatableCandidate; index: number }[]>();
  candidates.forEach((candidate, index) => {
    const group = groups.get(candidate.archetype);
    if (group === undefined) groups.set(candidate.archetype, [{ candidate, index }]);
    else group.push({ candidate, index });
  });

  for (const group of groups.values()) group.sort(rank);

  const chosen: ActivatableCandidate[] = [];
  let round = 0;

  // Each pass takes the `round`-th best of every archetype that still has
  // one, in the order those archetypes rank against each other. Terminates
  // because `round` only advances and every group is finite.
  while (chosen.length < available) {
    const contenders = [...groups.values()]
      .map((group) => group[round])
      .filter((entry): entry is { candidate: ActivatableCandidate; index: number } => entry !== undefined)
      .sort(rank);

    if (contenders.length === 0) break;

    for (const entry of contenders) {
      if (chosen.length >= available) break;
      chosen.push(entry.candidate);
    }
    round += 1;
  }

  return chosen;
}

/** STORY-045's ordering: weight, then specificity, then the caller's order. */
function rank(
  a: { candidate: ActivatableCandidate; index: number },
  b: { candidate: ActivatableCandidate; index: number },
): number {
  if (a.candidate.weight !== b.candidate.weight) return b.candidate.weight - a.candidate.weight;
  if (a.candidate.contextSlotCount !== b.candidate.contextSlotCount) {
    return b.candidate.contextSlotCount - a.candidate.contextSlotCount;
  }
  return a.index - b.index;
}
