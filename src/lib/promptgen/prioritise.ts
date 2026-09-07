import type { Candidate } from "./emit.js";

// STORY-045 — §4 step 7 PRIORITISE.
//
//   7. PRIORITISE  the priority subset = top N by (archetype weight x slot
//      commercial intent)
//
// *** NEITHER FACTOR HAS A DOCUMENTED VALUE, AND THAT IS WORTH KNOWING
//     BEFORE READING THE RANKING. ***
//
// `archetype weight` — no document assigns one. Derived in archetypes.ts
// from the only commercial-intent scale the specification states,
// `topic_clusters.commercial_intent`'s "decision 1.0 · consideration 0.7 ·
// awareness 0.4".
//
// `slot commercial intent` — §4 names the factor and no document assigns an
// intent to any slot. Implemented as a TIEBREAK on slot specificity rather
// than as an invented per-slot multiplier: a table saying `size_band` is
// worth 0.9 and `category` 0.6 would be three more numbers nobody can
// derive, and it would silently determine which prompts a customer's plan
// captures most often. Specificity is derivable from the data we already
// have — how many of the surface's slots came from the customer's real
// context rather than one of our derivations — and it is monotone in the
// direction the requirement wants: a prompt grounded in the customer's own
// vocabulary is the better candidate for the high-frequency cadence.
//
// This is a reasonable place to be provisionally wrong, which is why it is
// implemented rather than blocked on: `schemas/projects-and-prompts.md` says
// of `is_priority` that "The customer designates it", so generation proposes
// and the customer overrides in STORY-046. Both statements are then true,
// though neither document says so. Flagged for sign-off in the story.

export interface PrioritisedCandidate extends Candidate {
  /** `tracked_prompts.is_priority` — the high-frequency cadence subset. */
  readonly isPriority: boolean;
}

/**
 * Flags the top `subsetSize` candidates, WITHOUT reordering them.
 *
 * Order is preserved because `variants[]` order is what a client renders and
 * what the coverage chip row corresponds to — sorting by priority here would
 * change the response shape for every caller as a side effect of a flag.
 *
 * Ranking, in order of precedence:
 *   1. archetype weight, descending — the documented stage scale
 *   2. context-slot count, descending — the specificity tiebreak
 *   3. original position, ascending — §4's table order
 *
 * The third exists so the result is never arbitrary. Seven archetypes are
 * decision-stage and the documented subset size is six, so a tie reaches the
 * last rule regularly; without it the sixth slot would go to whichever
 * candidate an object iteration happened to yield first, which `FR-FAN-01d`
 * forbids.
 */
export function prioritise(candidates: readonly Candidate[], subsetSize: number): readonly PrioritisedCandidate[] {
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      if (a.candidate.weight !== b.candidate.weight) return b.candidate.weight - a.candidate.weight;
      if (a.candidate.contextSlotCount !== b.candidate.contextSlotCount) {
        return b.candidate.contextSlotCount - a.candidate.contextSlotCount;
      }
      return a.index - b.index;
    });

  // Clamped rather than trusted: `priority_subset_size` is bounded by the
  // contract, but a pass on thin context can produce fewer candidates than
  // the bound, and `slice` on a larger number silently flags everything —
  // which is the right outcome, so it is made explicit instead of implicit.
  const flagged = new Set(ranked.slice(0, Math.max(0, subsetSize)).map((entry) => entry.index));

  return candidates.map((candidate, index) => ({ ...candidate, isPriority: flagged.has(index) }));
}
