import type { FunnelStage, GeneratableArchetype } from "../../../contracts/prompts/index.js";

// STORY-045 — the archetype grammar. tracking-engine.md §4 "Archetype
// grammar — the 15 templates".
//
// AUTHORED CONTENT, and the only file in the pipeline that is. §4's table
// gives each archetype its funnel stage, its required slots and ONE example
// surface; it also says "each archetype has 2-4 surface templates", so the
// second and third surfaces here are written to that instruction. §4's own
// example is always `.a1` — it is the documented phrasing, not one option
// among several.
//
// WHY EVERY ARCHETYPE HAS AN ANONYMOUS SURFACE. `FR-FAN-01c` requires at
// least 6 of 15 variants to name no brand and no competitor, "because
// brand-named prompts systematically overstate visibility". Four archetypes
// —`head_to_head`, `alternatives`, `objection_risk`, `migration_switching` —
// are inherently about a named entity, so their `.a1` cannot be anonymous.
// Each therefore carries an anonymous sibling that asks the same question of
// the category instead of the brand. Without those, only eleven archetypes
// could contribute to the minimum and a project with thin context could fall
// below it with nothing downstream able to fix it.

/** Every slot the resolver knows how to fill. */
export const SLOT_NAMES = [
  // From §4 step 2's resolve list.
  "category",
  "competitor",
  "persona",
  "vertical",
  "size_band",
  "integration",
  "compliance_term",
  "capability",
  // The brand itself, which §4's templates use and step 2 assumes.
  "brand",
  // DERIVED. §4's template table uses these three and step 2's resolve list
  // does not mention them, so slots.ts derives them — `segment` from persona
  // and vertical and size_band, `headcount` from `size_band`, `use_case`
  // from `capabilities[]` — and records each derivation in `generator_meta`
  // so a prompt's provenance stays auditable.
  "segment",
  "use_case",
  "headcount",
] as const;

export type SlotName = (typeof SLOT_NAMES)[number];

/**
 * The grammar version.
 *
 * `FR-FAN-01d` only claims determinism for a given (topic, context, GRAMMAR
 * VERSION), and §8's L5 cache key is `sha256(topic_norm|locale|
 * grammar_version)` — so editing any surface below without bumping this
 * serves the old wording from cache for thirty days.
 *
 * Bump it for ANY change to a surface, a required-slot list, a template id,
 * or the ordering within an archetype. Adding a whole new archetype also
 * counts: coverage changes what a pass produces.
 */
export const GRAMMAR_VERSION = "g1";

export interface SurfaceTemplate {
  /** `<archetype>.a<n>`. Goes on the wire and into `generator_meta`. */
  readonly id: string;
  readonly surface: string;
  readonly requiredSlots: readonly SlotName[];
  /** True when the surface names neither the brand nor a competitor (`FR-FAN-01c`). */
  readonly brandAnonymous: boolean;
}

export interface Archetype {
  readonly key: GeneratableArchetype;
  readonly funnelStage: FunnelStage;
  /**
   * The `archetype weight` factor of §4 step 7's priority selection.
   *
   * UNDOCUMENTED IN THE REFERENCES — §4 names the factor and no document
   * gives a value. Derived from the one commercial-intent scale the
   * specification does state, `schemas/projects-and-prompts.md`'s
   * `topic_clusters.commercial_intent`: "decision 1.0 · consideration 0.7 ·
   * awareness 0.4". A decision-stage question is closer to a purchase than a
   * consideration-stage one, which is the ordering the priority subset is
   * for.
   *
   * Kept as an explicit per-archetype number rather than computed from
   * `funnelStage` so that a later sign-off can weight two decision-stage
   * archetypes differently without restructuring anything — see
   * `prioritise.ts` for the other factor.
   */
  readonly weight: number;
  /** 2-4 surfaces, most preferred first. §4's example is always index 0. */
  readonly templates: readonly SurfaceTemplate[];
}

/** `{category}` -> `category`, in order of first appearance, deduplicated. */
export function templateSlots(surface: string): SlotName[] {
  const found: SlotName[] = [];
  for (const match of surface.matchAll(/\{([a-z_]+)\}/g)) {
    const slot = match[1] as SlotName;
    if (!found.includes(slot)) found.push(slot);
  }
  return found;
}

/** The documented commercial-intent scale, by funnel stage. */
const INTENT_BY_STAGE = { decision: 1.0, consideration: 0.7, awareness: 0.4 } as const;

function template(id: string, surface: string): SurfaceTemplate {
  const requiredSlots = templateSlots(surface);
  return {
    id,
    surface,
    requiredSlots,
    // DERIVED, never hand-declared. A template is anonymous exactly when it
    // interpolates no entity name — asserting it by hand is how a
    // brand-naming surface ends up counted toward FR-FAN-01c's minimum.
    brandAnonymous: !requiredSlots.includes("brand") && !requiredSlots.includes("competitor"),
  };
}

function archetype(key: GeneratableArchetype, funnelStage: FunnelStage, surfaces: readonly string[]): Archetype {
  return {
    key,
    funnelStage,
    weight: INTENT_BY_STAGE[funnelStage],
    templates: surfaces.map((surface, index) => template(`${key}.a${index + 1}`, surface)),
  };
}

export const ARCHETYPES: readonly Archetype[] = [
  archetype("recommendation", "consideration", [
    "Which {category} do you recommend for {segment}?",
    "What {category} should {persona} be looking at?",
    "If you had to pick one {category} for {segment}, which would it be?",
  ]),
  archetype("head_to_head", "decision", [
    "Is {brand} or {competitor} better for {persona}?",
    // Anonymous sibling — the same comparison asked of the category, so this
    // archetype can contribute to FR-FAN-01c's minimum.
    "Which {category} comes out ahead for {persona}, and on what?",
    "How do the leading {category} options compare for {segment}?",
  ]),
  archetype("alternatives", "consideration", [
    "What are the strongest alternatives to {competitor}?",
    "What should I look at instead of the best-known {category}?",
    "Which {category} options are worth considering beyond the obvious ones?",
  ]),
  archetype("use_case_fit", "consideration", [
    "Best {category} for {use_case}?",
    "Which {category} handles {use_case} well?",
    "What do teams use for {use_case}?",
  ]),
  archetype("pricing_value", "decision", [
    "Which {category} gives the best value for a {size_band} team?",
    "What does {category} actually cost for a {size_band} company?",
    "Which {category} is worth the money at {size_band} scale?",
  ]),
  archetype("integration_capability", "consideration", [
    "Which {category} integrates cleanly with {integration}?",
    "What {category} works with {integration} without custom work?",
    "Which {category} has the best {integration} integration?",
  ]),
  archetype("objection_risk", "decision", [
    "What complaints do teams have about {brand}?",
    // Anonymous sibling.
    "What goes wrong with {category} tools?",
    "What do teams regret about their {category} choice?",
  ]),
  archetype("migration_switching", "decision", [
    "How hard is migrating from {competitor} to {brand}?",
    // Anonymous sibling.
    "How hard is it to switch between {category} platforms?",
    "What breaks when a {size_band} team changes {category}?",
  ]),
  archetype("compliance_security", "decision", [
    "Which {category} tools are {compliance_term} compliant?",
    "What {category} meets {compliance_term} requirements?",
    "Which {category} can I use in a {compliance_term} environment?",
  ]),
  archetype("scale_fit", "consideration", [
    // §4's documented surface needs a NUMERIC headcount, and no document
    // enumerates size bands or maps one to a head count — so `.a1` fires only
    // when the caller supplies a numeric band, and `.a2`/`.a3` keep the
    // archetype coverable on the qualitative band alone. Inventing a
    // band-to-range table (mid_market -> "200-1000") would put a number we
    // cannot derive into customer-visible prompt text.
    "Best {category} for a team of {headcount}?",
    "Which {category} holds up at {size_band} scale?",
    "What {category} do {size_band} teams settle on?",
  ]),
  archetype("vertical_fit", "consideration", [
    "Best {category} for {vertical} companies?",
    "Which {category} is built for {vertical}?",
    "What do {vertical} teams use for {category}?",
  ]),
  archetype("feature_specific", "consideration", [
    "Which {category} has the best {capability}?",
    "What {category} is strongest on {capability}?",
    "Which {category} should I pick if {capability} matters most?",
  ]),
  archetype("implementation_effort", "decision", [
    "How long does {category} implementation take for a {size_band} company?",
    "What does rolling out {category} involve at {size_band} scale?",
    "How much work is {category} setup for a team of {headcount}?",
  ]),
  archetype("support_quality", "decision", [
    "Which {category} vendor has the most responsive support?",
    "Whose {category} support actually helps?",
    "Which {category} vendor do {segment} rate for support?",
  ]),
  archetype("buyer_shortlist", "decision", [
    "Shortlist 3 {category} options for {segment} and explain the trade-offs.",
    "Give me three {category} candidates for {persona} with the trade-offs.",
    "What is a realistic {category} shortlist for a {size_band} team?",
  ]),
];

export const ARCHETYPE_BY_KEY: Readonly<Record<GeneratableArchetype, Archetype>> = Object.freeze(
  Object.fromEntries(ARCHETYPES.map((entry) => [entry.key, entry])) as Record<GeneratableArchetype, Archetype>,
);
