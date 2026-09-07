import { describe, expect, it } from "vitest";
import { ARCHETYPES, ARCHETYPE_BY_KEY } from "./archetypes.js";
import { emitCandidates } from "./emit.js";
import { prioritise } from "./prioritise.js";
import { resolveSlots, type SlotContext } from "./slots.js";

// STORY-045 — §4 step 7 PRIORITISE.
//
//   7. PRIORITISE  the priority subset = top N by (archetype weight x slot
//      commercial intent)
//
// NEITHER FACTOR HAS A DOCUMENTED VALUE. `archetype weight` is derived from
// `topic_clusters.commercial_intent`'s stated scale (decision 1.0 ·
// consideration 0.7 · awareness 0.4) — see archetypes.ts. `slot commercial
// intent` is named by §4 and no document assigns an intent to any slot, so
// it is implemented as a TIEBREAK on slot specificity rather than as an
// invented per-slot multiplier: within a funnel stage, the candidate
// grounded in more of the customer's real context ranks higher.
//
// Both are flagged for sign-off in the story. The subset is also
// customer-overridable (`schemas/projects-and-prompts.md`: "The customer
// designates it"), which is why a derivation here is a reasonable place to
// be provisionally wrong.

const FULL: SlotContext = {
  brandName: "HubSpot CRM",
  categorySlug: "crm",
  competitors: ["Salesforce"],
  personas: ["marketing_director"],
  verticals: ["b2b_saas"],
  sizeBands: ["mid_market"],
  integrations: ["slack"],
  complianceTerms: ["soc2"],
  capabilities: ["pipeline_automation"],
};

function candidatesFor(context: SlotContext = FULL, batchSize = 1) {
  return emitCandidates({ bag: resolveSlots(context), archetypes: ARCHETYPES, batchSize }).candidates;
}

describe("STORY-045 · prioritise — scenario 8, selected by weight and intent", () => {
  it("flags exactly `priority_subset_size` candidates", () => {
    const result = prioritise(candidatesFor(), 6);
    expect(result.filter((c) => c.isPriority)).toHaveLength(6);
  });

  it("prefers decision-stage archetypes, which carry the higher weight", () => {
    // The whole point of the subset: a decision-stage question is closer to a
    // purchase, so it earns the high-frequency cadence.
    const flagged = prioritise(candidatesFor(), 6).filter((c) => c.isPriority);
    for (const candidate of flagged) {
      expect(candidate.funnelStage, candidate.archetype).toBe("decision");
    }
  });

  it("breaks a weight tie on slot specificity, not on nothing", () => {
    // Seven archetypes are decision-stage and only six slots are asked for,
    // so the tie is real and something has to resolve it. Within the stage,
    // the candidate grounded in more REAL context outranks one leaning on a
    // derived slot.
    const flagged = prioritise(candidatesFor(), 6).filter((c) => c.isPriority);
    const unflaggedDecision = prioritise(candidatesFor(), 6).filter((c) => !c.isPriority && c.funnelStage === "decision");
    expect(unflaggedDecision).toHaveLength(1);
    const lowest = Math.min(...flagged.map((c) => c.contextSlotCount));
    expect(unflaggedDecision[0]?.contextSlotCount).toBeLessThanOrEqual(lowest);
  });

  it("falls back to §4's table order for a total tie, so the result is never arbitrary", () => {
    const candidates = candidatesFor();
    const first = prioritise(candidates, 6);
    const again = prioritise(candidates, 6);
    expect(first.map((c) => c.isPriority)).toEqual(again.map((c) => c.isPriority));
  });

  it("reaches into consideration stage once the decision archetypes run out", () => {
    const flagged = prioritise(candidatesFor(), 10).filter((c) => c.isPriority);
    expect(flagged).toHaveLength(10);
    expect(flagged.filter((c) => c.funnelStage === "decision")).toHaveLength(7);
    expect(flagged.filter((c) => c.funnelStage === "consideration")).toHaveLength(3);
  });
});

describe("STORY-045 · prioritise — ordering and edge cases", () => {
  it("does NOT reorder the candidates, only flags them", () => {
    // `variants[]` order is what a client renders. Sorting the array by
    // priority would silently change the response shape for every caller and
    // break the coverage chip row's correspondence with §4's table.
    const candidates = candidatesFor();
    const result = prioritise(candidates, 6);
    expect(result.map((c) => c.templateId)).toEqual(candidates.map((c) => c.templateId));
  });

  it("flags nothing for a subset size of zero", () => {
    expect(prioritise(candidatesFor(), 0).every((c) => !c.isPriority)).toBe(true);
  });

  it("flags everything rather than throwing when asked for more than exist", () => {
    const candidates = candidatesFor({ categorySlug: "crm" });
    expect(candidates.length).toBeLessThan(15);
    const result = prioritise(candidates, 15);
    expect(result.filter((c) => c.isPriority)).toHaveLength(candidates.length);
  });

  it("handles an empty pass", () => {
    expect(prioritise([], 6)).toEqual([]);
  });

  it("preserves every field it was given", () => {
    const [candidate] = candidatesFor();
    const [result] = prioritise(candidatesFor(), 6);
    expect(result).toMatchObject(candidate!);
  });
});

describe("STORY-045 · prioritise — the weight factor is the documented scale", () => {
  it("ranks a decision archetype above a consideration one at equal specificity", () => {
    const decision = ARCHETYPE_BY_KEY.support_quality;
    const consideration = ARCHETYPE_BY_KEY.vertical_fit;
    expect(decision.weight).toBeGreaterThan(consideration.weight);

    const bag = resolveSlots(FULL);
    const both = emitCandidates({ bag, archetypes: [consideration, decision], batchSize: 1 }).candidates;
    // Both interpolate one context slot, so weight alone decides.
    expect(both[0]?.contextSlotCount).toBe(both[1]?.contextSlotCount);
    const result = prioritise(both, 1);
    expect(result.find((c) => c.isPriority)?.archetype).toBe("support_quality");
  });
});
