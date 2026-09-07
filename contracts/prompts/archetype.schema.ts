import { z } from "zod";

// STORY-045 — the intent archetypes, shared by the generate request and its
// response. tracking-engine.md §4 "Archetype grammar — the 15 templates".
//
// TWO UNIONS, DELIBERATELY, and the difference is load-bearing.
// `schemas/projects-and-prompts.md`'s CHECK on `tracked_prompts
// .intent_archetype` permits sixteen values — the fifteen below plus
// `custom` — but `custom` is not something the generator can emit: it is what
// a manually created prompt carries (`POST /projects/{id}/prompts`,
// `generation_source='manual'`). So the generatable fifteen are what an
// `archetype_plan` may name, and the persisted sixteen are what a stored row
// may hold. Collapsing them into one enum would let a caller ask the
// generator for `custom` and get either an empty pass or an invented
// template.

/** The fifteen the generator emits. Ordered as §4's table lists them. */
export const GENERATABLE_ARCHETYPES = [
  "recommendation",
  "head_to_head",
  "alternatives",
  "use_case_fit",
  "pricing_value",
  "integration_capability",
  "objection_risk",
  "migration_switching",
  "compliance_security",
  "scale_fit",
  "vertical_fit",
  "feature_specific",
  "implementation_effort",
  "support_quality",
  "buyer_shortlist",
] as const;

export const generatableArchetypeSchema = z.enum(GENERATABLE_ARCHETYPES);
export type GeneratableArchetype = z.infer<typeof generatableArchetypeSchema>;

/** Every value a stored row may carry — the fifteen plus manual creation's `custom`. */
export const intentArchetypeSchema = z.enum([...GENERATABLE_ARCHETYPES, "custom"]);
export type IntentArchetype = z.infer<typeof intentArchetypeSchema>;

// `awareness` is permitted by the column's CHECK and no archetype maps to it.
// §4's grammar text says the selector prefers "brand-anonymous phrasing for
// awareness-stage archetypes", which is a rule with nothing to apply to: the
// fifteen are eight `consideration` and seven `decision`. Kept in the union
// because the column permits it and a future archetype will need it — NOT
// removed to make the enum match today's fifteen, which would make adding one
// a contract change.
export const funnelStageSchema = z.enum(["awareness", "consideration", "decision"]);
export type FunnelStage = z.infer<typeof funnelStageSchema>;
