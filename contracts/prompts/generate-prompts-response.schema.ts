import { z } from "zod";
import { funnelStageSchema, generatableArchetypeSchema } from "./archetype.schema.js";

// STORY-045 — the response for POST /v1/projects/{id}/prompts/generate.
// api-specification.md §5 names every member below; nothing here is invented.

/** `sha256:<64 hex>` — the same wire form §6's `capture.content_hash` uses. */
const sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * How close a candidate came to an existing prompt.
 *
 * BOTH MEMBERS ARE NULLABLE, and that is the honest shape rather than a
 * convenience. Vector dedupe needs an embedding, and nothing computes one
 * yet (`G3`, STORY-133) — so today `max_cosine_to_existing` is `null`,
 * meaning "not measured". Reporting `0` instead would say "measured, and
 * maximally distant from everything", which is a stronger claim than we can
 * make and one that reads as a passing novelty check.
 *
 * `nearest_prompt_id` is null when nothing was near, and also when nothing
 * was compared. A caller distinguishes the two by `max_cosine_to_existing`.
 */
export const promptNoveltySchema = z
  .object({
    max_cosine_to_existing: z.number().min(0).max(1).nullable(),
    nearest_prompt_id: z.string().uuid().nullable(),
  })
  .strict();

/**
 * One accepted candidate.
 *
 * `slots` is the resolved slot values this variant's template consumed —
 * echoed back because it is what makes a prompt auditable: "Best CRM for
 * mid-market teams?" is only checkable against the project if you can see
 * that `category` resolved to "CRM" and `size_band` to "mid-market". Three
 * of the slots §4's templates use (`segment`, `use_case`, `headcount`) are
 * DERIVED rather than resolved directly, so this member is also where a
 * derivation becomes visible instead of implicit.
 */
export const generatedVariantSchema = z
  .object({
    prompt_id: z.string().uuid(),
    text: z.string().min(1).max(500),
    text_hash: sha256HashSchema,
    intent_archetype: generatableArchetypeSchema,
    funnel_stage: funnelStageSchema,
    template_id: z.string().min(1).max(100),
    naturalized: z.boolean(),
    brand_named: z.boolean(),
    competitor_named: z.boolean(),
    slots: z.record(z.string(), z.string()),
    novelty: promptNoveltySchema,
    is_priority: z.boolean(),
    status: z.enum(["active", "paused", "archived"]),
  })
  .strict();

/**
 * One candidate that did not make it, and why.
 *
 * `conflicting_prompt_id` is the prompt that was KEPT — §4 step 5 rejects the
 * later one — so a caller can show what the duplicate collided with rather
 * than only that it collided.
 *
 * `rejected_duplicate` covers both an exact `text_hash` collision and a
 * vector near-duplicate; the two are the same outcome to a caller and
 * `novelty` on the accepted set is where the distinction is visible.
 * `templates_exhausted` is `FR-FAN-01a`'s other ending: backfill ran out of
 * secondary templates before reaching the target, and the pass returns fewer
 * rather than repeating one.
 */
export const rejectedCandidateSchema = z
  .object({
    text: z.string().min(1).max(500),
    text_hash: sha256HashSchema,
    intent_archetype: generatableArchetypeSchema,
    template_id: z.string().min(1).max(100),
    reason: z.enum(["rejected_duplicate", "templates_exhausted"]),
    conflicting_prompt_id: z.string().uuid().nullable(),
  })
  .strict();

/**
 * `FR-FAN-01b` — coverage is asserted in the response, not left to be
 * counted from `variants[]`, because it is rendered as a coverage chip row
 * and because an archetype that produced NOTHING has no variant to count.
 *
 * `used_anonymous_fallback` is the interesting column: it says the archetype
 * is represented but only because its required slots were unfillable and it
 * fell back to its brand-anonymous variant. That is a correct outcome and
 * also a signal that the project context is thin — invisible if coverage
 * were a plain boolean.
 */
export const archetypeCoverageSchema = z
  .object({
    intent_archetype: generatableArchetypeSchema,
    represented: z.boolean(),
    variant_count: z.number().int().min(0),
    used_anonymous_fallback: z.boolean(),
  })
  .strict();

/**
 * §5's summary, exactly its six members.
 *
 * No `brand_anonymous` count, deliberately, even though `FR-FAN-01c`'s
 * minimum of six is the measurement-integrity guarantee in this story: it is
 * already derivable from `variants[].brand_named` and `competitor_named`, and
 * a summary member the specification does not document is a member some
 * client starts depending on.
 *
 * `activated` is always 0 until STORY-046 — and a caller who ASKS for
 * activation is refused rather than shown a zero here.
 */
export const generationSummarySchema = z
  .object({
    requested: z.number().int().min(0),
    generated: z.number().int().min(0),
    accepted: z.number().int().min(0),
    rejected_duplicate: z.number().int().min(0),
    activated: z.number().int().min(0),
    priority_flagged: z.number().int().min(0),
  })
  .strict();

export const generatePromptsResponseSchema = z
  .object({
    generation_batch_id: z.string().uuid(),
    variants: z.array(generatedVariantSchema),
    rejected: z.array(rejectedCandidateSchema),
    coverage: z.array(archetypeCoverageSchema),
    summary: generationSummarySchema,
    /** True when the pass was served from the L5 template cache (§8, 30 days). */
    cached: z.boolean(),
  })
  .strict();

export type PromptNovelty = z.infer<typeof promptNoveltySchema>;
export type GeneratedVariant = z.infer<typeof generatedVariantSchema>;
export type RejectedCandidate = z.infer<typeof rejectedCandidateSchema>;
export type ArchetypeCoverage = z.infer<typeof archetypeCoverageSchema>;
export type GenerationSummary = z.infer<typeof generationSummarySchema>;
export type GeneratePromptsResponse = z.infer<typeof generatePromptsResponseSchema>;
