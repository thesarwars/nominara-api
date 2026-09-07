import { describe, expect, it } from "vitest";
import { GENERATABLE_ARCHETYPES } from "../../../contracts/prompts/index.js";
import { ARCHETYPES, ARCHETYPE_BY_KEY, GRAMMAR_VERSION, SLOT_NAMES, templateSlots } from "./archetypes.js";

// STORY-045 — the grammar itself, before anything uses it.
// tracking-engine.md §4 "Archetype grammar — the 15 templates".
//
// These are structural assertions over authored content, which is exactly
// where authored content goes wrong: a template referencing a slot that
// cannot be resolved, an archetype with only one surface so FR-FAN-01a's
// backfill has nothing to fall back to, or a "brand-anonymous" template that
// quietly interpolates the brand name.

describe("STORY-045 · the archetype grammar", () => {
  it("covers exactly the fifteen generatable archetypes, once each", () => {
    expect(ARCHETYPES).toHaveLength(15);
    expect(ARCHETYPES.map((a) => a.key).sort()).toEqual([...GENERATABLE_ARCHETYPES].sort());
  });

  it("assigns each archetype the funnel stage §4's table gives it", () => {
    // Transcribed, not chosen. §4's table is the source.
    expect(ARCHETYPE_BY_KEY.recommendation.funnelStage).toBe("consideration");
    expect(ARCHETYPE_BY_KEY.head_to_head.funnelStage).toBe("decision");
    expect(ARCHETYPE_BY_KEY.alternatives.funnelStage).toBe("consideration");
    expect(ARCHETYPE_BY_KEY.use_case_fit.funnelStage).toBe("consideration");
    expect(ARCHETYPE_BY_KEY.pricing_value.funnelStage).toBe("decision");
    expect(ARCHETYPE_BY_KEY.integration_capability.funnelStage).toBe("consideration");
    expect(ARCHETYPE_BY_KEY.objection_risk.funnelStage).toBe("decision");
    expect(ARCHETYPE_BY_KEY.migration_switching.funnelStage).toBe("decision");
    expect(ARCHETYPE_BY_KEY.compliance_security.funnelStage).toBe("decision");
    expect(ARCHETYPE_BY_KEY.scale_fit.funnelStage).toBe("consideration");
    expect(ARCHETYPE_BY_KEY.vertical_fit.funnelStage).toBe("consideration");
    expect(ARCHETYPE_BY_KEY.feature_specific.funnelStage).toBe("consideration");
    expect(ARCHETYPE_BY_KEY.implementation_effort.funnelStage).toBe("decision");
    expect(ARCHETYPE_BY_KEY.support_quality.funnelStage).toBe("decision");
    expect(ARCHETYPE_BY_KEY.buyer_shortlist.funnelStage).toBe("decision");
  });

  it("gives every archetype 2–4 surface templates", () => {
    // §4: "Each archetype has 2–4 surface templates with typed slots."
    // The lower bound is load-bearing: FR-FAN-01a backfills from SECONDARY
    // templates when dedupe rejects a candidate, and an archetype with one
    // surface has nothing to backfill from.
    for (const archetype of ARCHETYPES) {
      expect(archetype.templates.length, archetype.key).toBeGreaterThanOrEqual(2);
      expect(archetype.templates.length, archetype.key).toBeLessThanOrEqual(4);
    }
  });

  it("keeps §4's example surface as each archetype's first template", () => {
    // The table's example is the documented phrasing, so it is the preferred
    // one — not one of several alternatives buried in the list.
    expect(ARCHETYPE_BY_KEY.recommendation.templates[0]?.surface).toBe("Which {category} do you recommend for {segment}?");
    expect(ARCHETYPE_BY_KEY.head_to_head.templates[0]?.surface).toBe("Is {brand} or {competitor} better for {persona}?");
    expect(ARCHETYPE_BY_KEY.support_quality.templates[0]?.surface).toBe("Which {category} vendor has the most responsive support?");
    expect(ARCHETYPE_BY_KEY.buyer_shortlist.templates[0]?.surface).toBe(
      "Shortlist 3 {category} options for {segment} and explain the trade-offs.",
    );
  });

  it("declares required slots that match the placeholders in the surface", () => {
    // A template whose declared slots disagree with its text either leaves a
    // literal `{use_case}` in a customer-visible prompt or refuses to emit
    // for a slot it never needed.
    for (const archetype of ARCHETYPES) {
      for (const template of archetype.templates) {
        expect(templateSlots(template.surface).sort(), template.id).toEqual([...template.requiredSlots].sort());
      }
    }
  });

  it("only references slots the resolver knows how to fill", () => {
    for (const archetype of ARCHETYPES) {
      for (const template of archetype.templates) {
        for (const slot of template.requiredSlots) {
          expect(SLOT_NAMES, `${template.id} -> ${slot}`).toContain(slot);
        }
      }
    }
  });

  it("marks a template brand-anonymous only when it names neither brand nor competitor", () => {
    // FR-FAN-01c's minimum is counted off this flag, so a mislabelled
    // template inflates the anonymous count — which is precisely the
    // measurement dishonesty the requirement exists to prevent.
    for (const archetype of ARCHETYPES) {
      for (const template of archetype.templates) {
        const namesAnEntity = template.requiredSlots.includes("brand") || template.requiredSlots.includes("competitor");
        expect(template.brandAnonymous, template.id).toBe(!namesAnEntity);
      }
    }
  });

  it("gives every archetype at least one brand-anonymous surface", () => {
    // This is what makes the anonymous minimum reachable at all: an
    // archetype whose every template names an entity can never contribute to
    // it, and three such archetypes would put six of fifteen out of reach.
    for (const archetype of ARCHETYPES) {
      expect(archetype.templates.some((t) => t.brandAnonymous), archetype.key).toBe(true);
    }
  });

  it("can reach FR-FAN-01c's minimum of six brand-anonymous variants", () => {
    // Asserted on the GRAMMAR, not just on a generated pass: if fewer than
    // six archetypes can be phrased anonymously, no amount of selection
    // logic can meet the requirement and the failure belongs here.
    const anonymousCapable = ARCHETYPES.filter((a) => a.templates.some((t) => t.brandAnonymous));
    expect(anonymousCapable.length).toBeGreaterThanOrEqual(6);
  });

  it("gives every template a unique, stable id", () => {
    // `template_id` goes on the wire and into `generator_meta`. A duplicate
    // makes a variant's provenance ambiguous; an unstable one breaks the L5
    // cache and FR-FAN-01d's reproducibility.
    const ids = ARCHETYPES.flatMap((a) => a.templates.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z_]+\.[a-z][0-9]$/);
  });

  it("prefixes every template id with its own archetype key", () => {
    for (const archetype of ARCHETYPES) {
      for (const template of archetype.templates) {
        expect(template.id, template.id).toMatch(new RegExp(`^${archetype.key}\\.`));
      }
    }
  });

  it("versions the grammar, because determinism is only claimed per version", () => {
    // FR-FAN-01d: deterministic given (topic, project context, GRAMMAR
    // VERSION). It is also part of the L5 cache key, so a grammar edit must
    // invalidate the cache rather than serve prompts from the old wording.
    expect(GRAMMAR_VERSION).toMatch(/^g[0-9]+$/);
  });

  it("leaves no template surface unpunctuated or empty", () => {
    for (const archetype of ARCHETYPES) {
      for (const template of archetype.templates) {
        expect(template.surface.length, template.id).toBeGreaterThan(10);
        expect(template.surface, template.id).toMatch(/[?.]$/);
      }
    }
  });
});
