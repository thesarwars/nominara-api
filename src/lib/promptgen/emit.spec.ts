import { describe, expect, it } from "vitest";
import { ARCHETYPES, ARCHETYPE_BY_KEY } from "./archetypes.js";
import { emitCandidates, minimumAnonymous } from "./emit.js";
import { resolveSlots, type SlotContext } from "./slots.js";

// STORY-045 — §4 step 3 TEMPLATE EMIT, with step 6 CLASSIFY folded in
// (funnel stage and the two entity flags are pure functions of the chosen
// template, so a separate pass over them would only add a place for the two
// to disagree).
//
//   3. TEMPLATE EMIT  15 archetypes x best-fit template = 15 deterministic
//      candidates. Archetype coverage is guaranteed: an archetype whose
//      required slots are unfillable falls back to its brand-anonymous
//      variant, never to nothing.

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

function emitFor(context: SlotContext, batchSize = 1) {
  return emitCandidates({ bag: resolveSlots(context), archetypes: ARCHETYPES, batchSize });
}

describe("STORY-045 · emitCandidates — scenario 1, a well-populated project", () => {
  it("emits fifteen candidates with all fifteen archetypes represented", () => {
    // FR-FAN-01a and FR-FAN-01b together.
    const result = emitFor(FULL);
    expect(result.candidates).toHaveLength(15);
    expect(new Set(result.candidates.map((c) => c.archetype)).size).toBe(15);
    expect(result.coverage.filter((c) => c.represented)).toHaveLength(15);
  });

  it("interpolates every placeholder — no candidate leaks a literal brace", () => {
    for (const candidate of emitFor(FULL).candidates) {
      expect(candidate.text, candidate.templateId).not.toMatch(/[{}]/);
      expect(candidate.text.length, candidate.templateId).toBeGreaterThan(10);
    }
  });

  it("records the slot values it actually used, so a prompt is auditable", () => {
    const recommendation = emitFor(FULL).candidates.find((c) => c.archetype === "recommendation");
    expect(recommendation?.slots).toEqual({ category: "crm", segment: "mid market b2b saas teams" });
    expect(recommendation?.text).toBe("Which crm do you recommend for mid market b2b saas teams?");
  });

  it("prefers each archetype's documented `.a1` when its slots are fillable", () => {
    const result = emitFor(FULL);
    for (const candidate of result.candidates) {
      const preferred = ARCHETYPE_BY_KEY[candidate.archetype].templates[0];
      // `scale_fit.a1` needs a numeric headcount, which a qualitative size
      // band does not provide — so it is the one archetype expected to skip
      // its documented surface here.
      if (candidate.archetype === "scale_fit") continue;
      expect(candidate.templateId, candidate.archetype).toBe(preferred?.id);
    }
  });

  it("takes `.a1` for scale_fit once the size band IS a head count", () => {
    const numeric = emitFor({ ...FULL, sizeBands: ["50-200"] });
    const scaleFit = numeric.candidates.find((c) => c.archetype === "scale_fit");
    expect(scaleFit?.templateId).toBe("scale_fit.a1");
    expect(scaleFit?.text).toBe("Best crm for a team of 50-200?");
  });
});

describe("STORY-045 · emitCandidates — scenario 2, the anonymous fallback", () => {
  it("falls back to the anonymous variant when the preferred slots are unfillable", () => {
    // No competitors, so `alternatives.a1` ("alternatives to {competitor}")
    // cannot fill. §4: falls back to its brand-anonymous variant, NEVER to
    // nothing.
    const result = emitFor({ brandName: "HubSpot CRM", categorySlug: "crm", verticals: ["b2b_saas"] });
    const alternatives = result.candidates.find((c) => c.archetype === "alternatives");
    expect(alternatives).toBeDefined();
    expect(alternatives?.brandAnonymous).toBe(true);
    expect(alternatives?.competitorNamed).toBe(false);
    expect(alternatives?.usedAnonymousFallback).toBe(true);
  });

  it("flags the fallback in coverage, so thin context is visible rather than silent", () => {
    const result = emitFor({ brandName: "HubSpot CRM", categorySlug: "crm", verticals: ["b2b_saas"] });
    const row = result.coverage.find((c) => c.intent_archetype === "alternatives");
    expect(row).toEqual({ intent_archetype: "alternatives", represented: true, variant_count: 1, used_anonymous_fallback: true });
  });

  it("does NOT flag a fallback when the preferred template was anonymous all along", () => {
    // `used_anonymous_fallback` means "represented only because we retreated
    // from a branded surface". An archetype whose `.a1` is already anonymous
    // has not fallen back to anything, and marking it so would make thin
    // context look like the normal case.
    const result = emitFor(FULL);
    const row = result.coverage.find((c) => c.intent_archetype === "support_quality");
    expect(row?.used_anonymous_fallback).toBe(false);
  });

  it("reports an archetype as unrepresented rather than emitting a half-filled prompt", () => {
    // With only a brand name, nothing that needs a category can fill. §4's
    // guarantee is coverage "when their slots are fillable" — an archetype
    // with no fillable surface must be reported absent, not papered over.
    const result = emitFor({ brandName: "Acme" });
    const objection = result.candidates.find((c) => c.archetype === "objection_risk");
    expect(objection?.templateId).toBe("objection_risk.a1");
    const compliance = result.coverage.find((c) => c.intent_archetype === "compliance_security");
    expect(compliance).toEqual({
      intent_archetype: "compliance_security",
      represented: false,
      variant_count: 0,
      used_anonymous_fallback: false,
    });
    for (const candidate of result.candidates) expect(candidate.text).not.toMatch(/[{}]/);
  });
});

describe("STORY-045 · emitCandidates — classification, §4 step 6", () => {
  it("takes the funnel stage from the archetype, never from the template", () => {
    const result = emitFor(FULL);
    for (const candidate of result.candidates) {
      expect(candidate.funnelStage, candidate.archetype).toBe(ARCHETYPE_BY_KEY[candidate.archetype].funnelStage);
    }
  });

  it("sets brand_named and competitor_named from the slots the surface interpolates", () => {
    const result = emitFor(FULL);
    const headToHead = result.candidates.find((c) => c.archetype === "head_to_head");
    expect(headToHead?.brandNamed).toBe(true);
    expect(headToHead?.competitorNamed).toBe(true);

    const objection = result.candidates.find((c) => c.archetype === "objection_risk");
    expect(objection?.brandNamed).toBe(true);
    expect(objection?.competitorNamed).toBe(false);

    const support = result.candidates.find((c) => c.archetype === "support_quality");
    expect(support?.brandNamed).toBe(false);
    expect(support?.competitorNamed).toBe(false);
  });

  it("keeps brandAnonymous exactly the negation of naming either entity", () => {
    for (const candidate of emitFor(FULL).candidates) {
      expect(candidate.brandAnonymous, candidate.templateId).toBe(!candidate.brandNamed && !candidate.competitorNamed);
    }
  });
});

describe("STORY-045 · emitCandidates — scenario 7, the anonymous minimum", () => {
  it("reaches FR-FAN-01c's six brand-anonymous variants on a full context", () => {
    const anonymous = emitFor(FULL).candidates.filter((c) => c.brandAnonymous);
    expect(anonymous.length).toBeGreaterThanOrEqual(6);
  });

  it("holds the minimum as a SHARE on a thin context, where a full fifteen is impossible", () => {
    // FR-FAN-01c reads "at least 6 of the 15 variants". A context that can
    // only fill four surfaces has no fifteen for the ratio to be taken of,
    // so the requirement is applied as the share it expresses — 6/15 — and
    // this is where the first draft of this test was simply wrong: it
    // demanded six anonymous variants out of a four-candidate pass.
    const thin = emitFor({ categorySlug: "crm" });
    expect(thin.candidates.length).toBeLessThan(15);
    expect(thin.candidates.filter((c) => c.brandAnonymous).length).toBeGreaterThanOrEqual(minimumAnonymous(thin.candidates.length));
  });

  it("holds the share across every context between thin and full", () => {
    const contexts: SlotContext[] = [
      { categorySlug: "crm" },
      { categorySlug: "crm", competitors: ["Salesforce"] },
      { categorySlug: "crm", brandName: "HubSpot CRM", competitors: ["Salesforce"] },
      { categorySlug: "crm", brandName: "HubSpot CRM", competitors: ["Salesforce"], verticals: ["b2b_saas"] },
      FULL,
    ];
    for (const context of contexts) {
      const result = emitFor(context);
      const anonymous = result.candidates.filter((c) => c.brandAnonymous).length;
      expect(anonymous, JSON.stringify(context)).toBeGreaterThanOrEqual(minimumAnonymous(result.candidates.length));
    }
  });

  it("gives exactly the documented six at a full fifteen", () => {
    expect(minimumAnonymous(15)).toBe(6);
  });

  it("keeps a branded `.a1` when the pass is already above the floor", () => {
    // The preference yields to the guarantee, not the other way round: on a
    // full context there is anonymous headroom, so every documented surface
    // stays.
    const substituted = emitFor(FULL).candidates.filter((c) => c.anonymousSubstitution);
    expect(substituted).toHaveLength(0);
  });

  it("substitutes rather than reporting a false fallback when the floor binds", () => {
    // A swap for the quota is NOT thin context, and the two must not be
    // conflated: a customer reading a coverage row should not be told their
    // context was insufficient when the real reason was the anonymous floor.
    const result = emitFor({ categorySlug: "crm", brandName: "HubSpot CRM", competitors: ["Salesforce"] });
    const swapped = result.candidates.filter((c) => c.anonymousSubstitution);
    expect(swapped.length).toBeGreaterThan(0);
    for (const candidate of swapped) expect(candidate.usedAnonymousFallback).toBe(false);
  });

  // *** A REAL GAP, PINNED SO IT CANNOT BE REDISCOVERED BY A CUSTOMER. ***
  //
  // `category` is load-bearing for FR-FAN-01c: EVERY brand-anonymous surface
  // in the grammar interpolates it, because asking a category-free anonymous
  // question ("what should I look at instead?") carries no measurable
  // subject. So a project with a brand and competitors but NO category emits
  // an entirely brand-named prompt set — precisely the "systematically
  // overstate visibility" failure the requirement exists to prevent.
  //
  // Not worked around here. `category_slug` is set at creation or by
  // discovery and is almost always present, and the 180-category taxonomy is
  // itself an unowned gap in dev-plan.md. The pipeline reports the anonymous
  // share so this is visible rather than silent; making category mandatory
  // for a generation pass is a product decision.
  it("documents that a context with no category cannot produce an anonymous variant", () => {
    const noCategory = emitFor({ brandName: "HubSpot CRM", competitors: ["Salesforce"], personas: ["marketing_director"] });
    expect(noCategory.candidates.length).toBeGreaterThan(0);
    expect(noCategory.candidates.every((c) => c.brandNamed || c.competitorNamed)).toBe(true);
    expect(noCategory.candidates.filter((c) => c.brandAnonymous)).toHaveLength(0);
  });
});

describe("STORY-045 · emitCandidates — scenario 5, determinism (FR-FAN-01d)", () => {
  it("produces byte-identical output for the same context", () => {
    expect(JSON.stringify(emitFor(FULL))).toBe(JSON.stringify(emitFor(FULL)));
  });

  it("orders candidates by §4's archetype table, not by object iteration", () => {
    const keys = emitFor(FULL).candidates.map((c) => c.archetype);
    expect(keys).toEqual(ARCHETYPES.map((a) => a.key));
  });
});

describe("STORY-045 · emitCandidates — batch_size and the archetype plan", () => {
  it("emits `batch_size` variants per archetype, from DIFFERENT templates", () => {
    // Per-archetype is the reading the contract adopted; two variants from
    // one template would be byte-identical and rejected by text_hash dedupe
    // immediately after being generated.
    const result = emitCandidates({ bag: resolveSlots(FULL), archetypes: [ARCHETYPE_BY_KEY.support_quality], batchSize: 3 });
    expect(result.candidates).toHaveLength(3);
    expect(new Set(result.candidates.map((c) => c.templateId)).size).toBe(3);
    expect(result.coverage[0]?.variant_count).toBe(3);
  });

  it("returns fewer than asked rather than repeating a template", () => {
    // §4 gives each archetype 2-4 surfaces; asking for 4 where only 3 can
    // fill yields 3. FR-FAN-01a's `templates_exhausted` is the reporting
    // side of this, in the pipeline.
    const result = emitCandidates({ bag: resolveSlots(FULL), archetypes: [ARCHETYPE_BY_KEY.support_quality], batchSize: 4 });
    expect(result.candidates.length).toBeLessThanOrEqual(3);
    expect(new Set(result.candidates.map((c) => c.templateId)).size).toBe(result.candidates.length);
  });

  it("covers only the archetypes it was given", () => {
    const result = emitCandidates({
      bag: resolveSlots(FULL),
      archetypes: [ARCHETYPE_BY_KEY.recommendation, ARCHETYPE_BY_KEY.support_quality],
      batchSize: 1,
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.coverage).toHaveLength(2);
  });
});
