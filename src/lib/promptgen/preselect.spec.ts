import { describe, expect, it } from "vitest";
import { GENERATABLE_ARCHETYPES } from "../../../contracts/prompts/index.js";
import { preselectForActivation, type ActivatableCandidate } from "./preselect.js";

// STORY-046 — `FR-CRD-07`: "Pre-selection maximises archetype breadth — one
// per family before any second pick."
//
// §10's worked example is the requirement in one sentence:
//
//   "This topic generated 15 conversational prompts. You have 8 of 40 slots
//    left. We've pre-selected 8 that preserve the widest buyer-intent
//    coverage."
//
// THE FAILURE THIS PREVENTS is named in the story: "Filling by rank alone
// would take five recommendation variants before the first comparison
// prompt, which is worse coverage from the same number of slots." A capped
// project should lose DEPTH, not COVERAGE.

function candidate(archetype: string, index: number, weight = 1.0, contextSlotCount = 2): ActivatableCandidate {
  return {
    promptId: `p-${archetype}-${String(index)}`,
    archetype: archetype as ActivatableCandidate["archetype"],
    weight,
    contextSlotCount,
  };
}

/** One variant per archetype — what a `batch_size: 1` pass produces. */
function onePerArchetype(): ActivatableCandidate[] {
  return GENERATABLE_ARCHETYPES.map((archetype, index) => candidate(archetype, index));
}

/** Four variants of one archetype and one of another — the lopsided case. */
function lopsided(): ActivatableCandidate[] {
  return [
    candidate("recommendation", 1),
    candidate("recommendation", 2),
    candidate("recommendation", 3),
    candidate("recommendation", 4),
    candidate("head_to_head", 1),
    candidate("head_to_head", 2),
    candidate("objection_risk", 1),
  ];
}

describe("STORY-046 · preselectForActivation — FR-CRD-07, breadth before depth", () => {
  it("takes one per archetype before any second pick", () => {
    // THE HEADLINE. Four recommendation variants are available and only one
    // may be taken while another archetype is still unrepresented.
    const chosen = preselectForActivation(lopsided(), 3);
    expect(chosen).toHaveLength(3);
    expect(new Set(chosen.map((c) => c.archetype)).size).toBe(3);
  });

  it("only takes a second variant of an archetype once every family has one", () => {
    const chosen = preselectForActivation(lopsided(), 5);
    const byArchetype = new Map<string, number>();
    for (const c of chosen) byArchetype.set(c.archetype, (byArchetype.get(c.archetype) ?? 0) + 1);
    // Three families exist; with five slots, all three are covered first and
    // the two extras are the second round.
    expect(byArchetype.size).toBe(3);
    expect([...byArchetype.values()].every((n) => n >= 1)).toBe(true);
    expect(chosen).toHaveLength(5);
  });

  it("scenario 6 — with fewer slots than archetypes, no archetype is doubled", () => {
    const chosen = preselectForActivation(onePerArchetype(), 8);
    expect(chosen).toHaveLength(8);
    expect(new Set(chosen.map((c) => c.archetype)).size).toBe(8);
  });

  it("does NOT take five of one archetype before the first of another — the named failure", () => {
    // Rank-only filling, with the five best all from one family.
    const rankOnly: ActivatableCandidate[] = [
      candidate("recommendation", 1, 1.0, 4),
      candidate("recommendation", 2, 1.0, 4),
      candidate("recommendation", 3, 1.0, 4),
      candidate("recommendation", 4, 1.0, 4),
      candidate("head_to_head", 1, 0.7, 1),
      candidate("objection_risk", 1, 0.7, 1),
    ];
    const chosen = preselectForActivation(rankOnly, 3);
    expect(chosen.filter((c) => c.archetype === "recommendation")).toHaveLength(1);
    expect(new Set(chosen.map((c) => c.archetype)).size).toBe(3);
  });
});

describe("STORY-046 · preselectForActivation — ranking within a round", () => {
  it("picks the higher-weighted archetype first when breadth is equal", () => {
    // Breadth decides WHICH family gets a slot next; within that constraint
    // the STORY-045 ranking still applies, so a decision-stage question
    // outranks a consideration-stage one.
    const mixed = [candidate("vertical_fit", 1, 0.7), candidate("support_quality", 1, 1.0)];
    expect(preselectForActivation(mixed, 1)[0]?.archetype).toBe("support_quality");
  });

  it("breaks a weight tie on slot specificity", () => {
    const tied = [candidate("support_quality", 1, 1.0, 1), candidate("pricing_value", 1, 1.0, 3)];
    expect(preselectForActivation(tied, 1)[0]?.archetype).toBe("pricing_value");
  });

  it("is deterministic — the same input selects the same subset", () => {
    const candidates = onePerArchetype();
    expect(preselectForActivation(candidates, 8).map((c) => c.promptId)).toEqual(
      preselectForActivation(candidates, 8).map((c) => c.promptId),
    );
  });

  it("preserves input order among fully tied candidates", () => {
    // Otherwise the eighth slot goes to whichever candidate an iteration
    // happened to yield first, and a customer who re-opens the dialog sees a
    // different pre-selection over the same data.
    const tied = [candidate("recommendation", 1), candidate("head_to_head", 1), candidate("alternatives", 1)];
    expect(preselectForActivation(tied, 2).map((c) => c.promptId)).toEqual(["p-recommendation-0", "p-head_to_head-0"]);
  });
});

describe("STORY-046 · preselectForActivation — the slot arithmetic", () => {
  it("takes everything when there are more slots than candidates", () => {
    const candidates = onePerArchetype();
    expect(preselectForActivation(candidates, 40)).toHaveLength(15);
  });

  it("takes nothing when there are no slots — never a partial charge", () => {
    // A project at its cap gets an empty pre-selection and §10's three paths,
    // not one prompt activated as a consolation.
    expect(preselectForActivation(onePerArchetype(), 0)).toEqual([]);
  });

  it("treats a negative slot count as zero rather than throwing", () => {
    // `cap - active` can go negative if a cap was lowered below the current
    // active count — a plan downgrade. That must not crash the dialog; it
    // means no slots, and the existing prompts are not retroactively
    // deactivated.
    expect(preselectForActivation(onePerArchetype(), -5)).toEqual([]);
  });

  it("handles an empty candidate set", () => {
    expect(preselectForActivation([], 8)).toEqual([]);
  });
});
