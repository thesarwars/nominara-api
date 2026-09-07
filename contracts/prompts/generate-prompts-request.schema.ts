import { z } from "zod";
import { generatableArchetypeSchema, GENERATABLE_ARCHETYPES } from "./archetype.schema.js";

// STORY-045 — POST /v1/projects/{id}/prompts/generate. api-specification.md §5.
//
// `.strict()` on every object here is security-and-tenancy.md §9's
// mass-assignment control: an unknown key is a 400, never silently ignored.
// It matters more than usual on this endpoint, because several members are
// tuning knobs — a typo'd `naturalizer_enabled` that was quietly dropped
// would leave the naturaliser on and make FR-FAN-01d's determinism guarantee
// fail intermittently, which is the worst kind of failure to debug.

const trimmedString = (max: number) => z.string().trim().min(1).max(max);

/**
 * The brand context slots are resolved from.
 *
 * Supplied by the caller rather than read from the project row, because §5
 * documents it on the wire and onboarding generates BEFORE the discovery
 * confirm step has written anything. Where a key is absent the service falls
 * back to the project's stored value, so a caller who sends nothing but
 * `topic_hint` still gets a full pass.
 */
export const brandContextSchema = z
  .object({
    brand_name: trimmedString(200).optional(),
    brand_aliases: z.array(trimmedString(200)).max(50).optional(),
    root_domain: trimmedString(253).optional(),
    category_slug: trimmedString(100).optional(),
    verticals: z.array(trimmedString(100)).max(20).optional(),
    competitors: z
      .array(
        z
          .object({
            name: trimmedString(200),
            aliases: z.array(trimmedString(200)).max(50).optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    personas: z.array(trimmedString(100)).max(20).optional(),
    size_bands: z.array(trimmedString(100)).max(20).optional(),
    integrations: z.array(trimmedString(100)).max(50).optional(),
    compliance_terms: z.array(trimmedString(100)).max(50).optional(),
    capabilities: z.array(trimmedString(100)).max(50).optional(),
  })
  .strict();

/**
 * Which archetypes this pass covers.
 *
 * `mode` carries the ONE value §5 documents. It is a single-member enum
 * rather than a boolean or an omitted key so that a second mode is an
 * additive change to an input enum — which is backwards-compatible — instead
 * of a new key. Narrowing is done with `include`/`exclude`, so
 * `full_coverage` means "every archetype this plan does not exclude", not
 * "all fifteen regardless".
 */
export const archetypePlanSchema = z
  .object({
    mode: z.enum(["full_coverage"]).default("full_coverage"),
    include: z.array(generatableArchetypeSchema).min(1).max(GENERATABLE_ARCHETYPES.length).optional(),
    exclude: z.array(generatableArchetypeSchema).max(GENERATABLE_ARCHETYPES.length).optional(),
  })
  .strict();

/**
 * How the candidates are phrased.
 *
 * `template_only` is not a degraded mode — it is `FR-FAN-01d`'s determinism
 * guarantee and the fallback when the naturaliser's circuit is open, and §5
 * requires it to still yield a full pass with no model call at all.
 *
 * `model_first` is documented as "reserved for custom grammars". It is in the
 * enum for contract fidelity and refused by the service, not by a refinement
 * here — see the note on `options.auto_activate` below for why that
 * distinction is deliberate.
 */
export const generationOptionsSchema = z
  .object({
    strategy: z.enum(["template_first", "template_only", "model_first"]).default("template_first"),
    naturalizer_enabled: z.boolean().default(true),
    temperature: z.number().min(0).max(2).default(0.35),
    single_batched_call: z.boolean().default(true),
  })
  .strict();

/**
 * Duplicate rejection.
 *
 * `similarity_threshold` defaults to §4 step 5's 0.92. It is bounded but
 * adjustable because §5 puts it on the wire; a caller cannot set it to 0,
 * which would reject every candidate against any existing prompt.
 */
export const dedupeOptionsSchema = z
  .object({
    method: z.enum(["pgvector_cosine"]).default("pgvector_cosine"),
    similarity_threshold: z.number().gt(0).max(1).default(0.92),
    scope: z.enum(["project"]).default("project"),
  })
  .strict();

/**
 * Post-generation handling.
 *
 * `auto_activate` stays in the contract because §5 documents it, and the
 * service refuses `true` with `422 precondition_unmet` until prompt
 * activation exists (STORY-046 owns the cap binding). Refused rather than
 * ignored: a caller who asked for activation and received `activated: 0`
 * cannot tell that apart from activation running and selecting nothing.
 *
 * Refused in the SERVICE and not by a `.refine()` here, unlike a shape rule,
 * because it is a capability gap rather than an invalid request — when
 * STORY-046 lands the refusal is deleted and the contract does not move.
 */
export const passOptionsSchema = z
  .object({
    auto_activate: z.boolean().default(false),
    priority_subset_size: z.number().int().min(0).max(GENERATABLE_ARCHETYPES.length).default(6),
  })
  .strict();

export const generatePromptsFieldsSchema = z
  .object({
    /**
     * Variants PER INCLUDED ARCHETYPE, not per pass.
     *
     * §5's example shows `"batch_size": 5` beside `mode: "full_coverage"` and
     * all fifteen archetypes, which contradicts `FR-FAN-01a`'s "exactly 15
     * accepted variants per pass" — no reading makes that example internally
     * consistent, and the guarantee outranks an illustration.
     *
     * Per-archetype is the reading where the default gives fifteen by
     * construction (15 x 1) rather than by a validation rule bolted on top,
     * and where the key still means something for a narrower `include` — which
     * is what STORY-080's prompt research needs.
     *
     * Capped at 4 because §4 gives each archetype "2-4 surface templates":
     * asking for a fifth has no distinct template to draw on, and a caller
     * asking for something unsatisfiable should be told so rather than handed
     * a short pass to work out for themselves.
     */
    batch_size: z.number().int().min(1).max(4).default(1),

    /** Normalised into the dedupe key and the L5 cache key (§4 step 1). */
    topic_hint: trimmedString(200).optional(),

    brand_context: brandContextSchema.optional(),
    archetype_plan: archetypePlanSchema.optional(),
    generation: generationOptionsSchema.optional(),
    dedupe: dedupeOptionsSchema.optional(),
    options: passOptionsSchema.optional(),
  })
  .strict();

// `include` and `exclude` naming the same archetype is a request that cannot
// be satisfied either way. A refinement rather than a service check so it
// fails as `400 validation_failed` with the offending path, like every other
// shape error — the precedent create-project-request.schema.ts sets for its
// `kind`/`parent_project_id` rule.
export const generatePromptsRequestSchema = generatePromptsFieldsSchema
  .refine(
    (value) => {
      const include = value.archetype_plan?.include;
      const exclude = value.archetype_plan?.exclude;
      if (include === undefined || exclude === undefined) return true;
      return !include.some((archetype) => exclude.includes(archetype));
    },
    { message: "archetype_plan.include and archetype_plan.exclude must not name the same archetype", path: ["archetype_plan", "exclude"] },
  )
  .refine(
    (value) => {
      // An empty effective set is a pass that can produce nothing. Caught
      // here so the caller learns why, instead of receiving a valid-looking
      // response with zero variants and full coverage over no archetypes.
      const include = value.archetype_plan?.include ?? GENERATABLE_ARCHETYPES;
      const exclude = value.archetype_plan?.exclude ?? [];
      return include.some((archetype) => !exclude.includes(archetype));
    },
    { message: "archetype_plan excludes every archetype, so the pass would produce nothing", path: ["archetype_plan"] },
  );

export type GeneratePromptsRequest = z.infer<typeof generatePromptsFieldsSchema>;
export type BrandContext = z.infer<typeof brandContextSchema>;
export type ArchetypePlan = z.infer<typeof archetypePlanSchema>;
export type GenerationOptions = z.infer<typeof generationOptionsSchema>;
export type DedupeOptions = z.infer<typeof dedupeOptionsSchema>;
export type PassOptions = z.infer<typeof passOptionsSchema>;
