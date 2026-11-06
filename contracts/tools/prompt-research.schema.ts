import { z } from "zod";
import { brandContextSchema } from "../prompts/generate-prompts-request.schema.js";
import { generatableArchetypeSchema } from "../prompts/archetype.schema.js";

// STORY-080 - Prompt Research (FR-TL-01): Discover, Keep, Run.
//
//   GET  /v1/tools/prompt-research/estimate   the free paired estimate, recomputed for whatever is selected (NFR-API-11)
//   POST /v1/tools/prompt-research/discover   15 archetype-aligned prompts for a brand or topic; FREE to generate and to discard
//   POST /v1/tools/prompt-research/keep       charges per prompt KEPT, at the in-project generation rate
//   POST /v1/tools/prompt-research/run        asks the selected prompts of the plan's engine set; 5 credits per ANSWER
//
// BRAND-AGNOSTIC BY CONSTRUCTION. Neither the run request nor anything in the result names a brand: no `brand_name`, no "owned" flag, no
// "your" anything, no highlight. A response with a home team would turn a neutral ranking into a scoreboard, so the shape has nowhere to put one
// (asserted by walking this schema's keys, not by looking at a rendering).

/** FR-TL-01: Discover generates 15 prompts. */
export const PROMPT_RESEARCH_DISCOVER_COUNT = 15;
/** FR-TL-01: a run is capped at 10 prompts. `tool_runs.ck_tr_shape` caps `prompt_texts` at the same 10, so a keep is capped there too. */
export const PROMPT_RESEARCH_MAX_PROMPTS = 10;
/** product-spec.md section 11: "5 per answer". An answer is one prompt asked of one engine. */
export const PROMPT_RESEARCH_CREDITS_PER_ANSWER = 5;
/** FR-TL-01f: an entity detected fewer than 3 times across the run is not a peer of a repeatedly named one. */
export const PROMPT_RESEARCH_ALSO_MENTIONED_THRESHOLD = 3;

const promptTextSchema = z.string().trim().min(1).max(500);
const subjectText = z.string().trim().min(1).max(200);

/** The free generation. A brand, a topic, or both; the optional context supplies the slot vocabulary the generator needs for a full 15. */
export const discoverPromptsRequestSchema = z
  .object({
    brand_name: subjectText.optional(),
    topic: subjectText.optional(),
    context: brandContextSchema.omit({ brand_name: true }).optional(),
  })
  .strict()
  .refine((value) => value.brand_name !== undefined || value.topic !== undefined, { message: "name a brand_name or a topic to discover prompts for", path: ["brand_name"] });

export const discoveredPromptSchema = z
  .object({
    text: z.string().min(1),
    archetype: generatableArchetypeSchema,
    priority: z.boolean(),
  })
  .strict();

export const discoverPromptsResponseSchema = z
  .object({
    candidates: z.array(discoveredPromptSchema),
    /** What the generator was asked for (15) and what it produced: fewer when the context is too thin to fill every archetype honestly. */
    requested: z.number().int().positive(),
    generated: z.number().int().nonnegative(),
    /** Always 0: generating, and discarding, are free (FR-TL-01a). */
    credits_charged: z.literal(0),
    keep: z.object({ credits_per_prompt: z.number().int().nonnegative(), max_per_save: z.number().int().positive() }).strict(),
    not_tracked: z.literal(true),
    did_not_check: z.string().min(1),
  })
  .strict();

export const keepPromptsRequestSchema = z
  .object({
    prompts: z.array(promptTextSchema).min(1, "keep at least one prompt").max(PROMPT_RESEARCH_MAX_PROMPTS, `at most ${String(PROMPT_RESEARCH_MAX_PROMPTS)} prompts can be kept in one save`),
    brand_name: subjectText.optional(),
    topic: subjectText.optional(),
  })
  .strict();

export const keepPromptsResponseSchema = z
  .object({
    tool_run_id: z.uuid(),
    kept_count: z.number().int().positive(),
    credits_per_prompt: z.number().int().nonnegative(),
    credits_charged: z.number().int().nonnegative(),
    prompts: z.array(z.string().min(1)),
    /** The shared conversion contract carries these prompts into a project at 0 credits: a prompt paid for here is never charged again. */
    convert_endpoint: z.string().min(1),
    not_tracked: z.literal(true),
    did_not_check: z.string().min(1),
  })
  .strict();

export const promptResearchEstimateQuerySchema = z
  .object({
    mode: z.enum(["keep", "run"]),
    prompt_count: z.coerce.number().int().min(0).max(PROMPT_RESEARCH_DISCOVER_COUNT),
  })
  .strict();

export const promptResearchEstimateResponseSchema = z
  .object({
    mode: z.enum(["keep", "run"]),
    prompt_count: z.number().int().nonnegative(),
    max_prompts: z.number().int().positive(),
    /** False when the selection is above the cap: the control blocks the eleventh prompt with the reason, rather than failing server-side. */
    within_cap: z.boolean(),
    /** The engines a run will use, named BEFORE it (FR-TL-07); empty for a keep. */
    engines: z.array(z.object({ engine_key: z.string().min(1), display_name: z.string().min(1) }).strict()),
    unit: z.enum(["prompt_kept", "answer"]),
    credits_per_unit: z.number().int().nonnegative(),
    /** Units charged for this selection: the prompts kept, or prompts x engines answers. */
    units: z.number().int().nonnegative(),
    /** The figure the control restates and the execute call must echo in X-Nominara-Confirmed-Credits. */
    total_credits: z.number().int().nonnegative(),
    wallet: z.object({ available: z.number().int().nonnegative(), available_after: z.number().int(), shortfall: z.number().int().nonnegative() }).strict(),
    not_tracked: z.literal(true),
    not_tracked_note: z.string().min(1),
  })
  .strict();

export const promptResearchRunRequestSchema = z
  .object({
    prompt_texts: z
      .array(promptTextSchema)
      .min(1, "select at least one prompt")
      .max(PROMPT_RESEARCH_MAX_PROMPTS, `a run is capped at ${String(PROMPT_RESEARCH_MAX_PROMPTS)} prompts`),
  })
  .strict();

export const promptResearchRunAcceptedSchema = z
  .object({
    tool_run_id: z.uuid(),
    status: z.literal("running"),
    prompts: z.number().int().positive(),
    engines: z.array(z.string().min(1)),
    answers: z.number().int().positive(),
    credits: z.object({ charged: z.number().int().nonnegative(), per_answer: z.number().int().positive(), available_after: z.number().int() }).strict(),
    /** The result is read from the run (free, any time): the worker answers the prompts, this request never waits on an engine. */
    poll: z.object({ run: z.string().min(1) }).strict(),
    not_tracked: z.literal(true),
    did_not_check: z.string().min(1),
  })
  .strict();

const entityRowSchema = z
  .object({
    name: z.string().min(1),
    /** In how many of the run's answers the entity was named. */
    answers_named: z.number().int().positive(),
    /** answers_named over the sum of answers_named across every detected entity. An estimate. */
    share_of_answer: z.number().min(0).max(1),
  })
  .strict();

const alsoMentionedRowSchema = z.object({ name: z.string().min(1), answers_named: z.number().int().positive() }).strict();

const feedingDomainSchema = z
  .object({
    domain: z.string().min(1),
    citations: z.number().int().positive(),
    answers_cited: z.number().int().positive(),
  })
  .strict();

const researchFailureSchema = z
  .object({
    engine: z.string().min(1),
    /** Zero-based index into `prompts`; null when the engine failed as a whole. */
    prompt_index: z.number().int().nonnegative().nullable(),
    code: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

/** `tool_runs.result_json` for a Prompt Research run (jsonb, <= 24 KB: the lists are capped). */
export const promptResearchResultSchema = z
  .object({
    schema_version: z.literal(1),
    mode: z.literal("run"),
    prompts: z.array(z.string().min(1)),
    answers: z.object({ asked: z.number().int().nonnegative(), answered: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict(),
    /** Entities named in at least the threshold's answers, ranked by share of answer. Every one on the same footing. */
    entities: z.array(entityRowSchema),
    /** FR-TL-01f: the collapsed group of entities named in fewer answers than the threshold. */
    also_mentioned: z.array(alsoMentionedRowSchema),
    also_mentioned_threshold: z.literal(PROMPT_RESEARCH_ALSO_MENTIONED_THRESHOLD),
    /** The domains the answers drew on. */
    domains: z.array(feedingDomainSchema),
    engines: z.array(z.object({ engine: z.string().min(1), answered: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict()),
    engine_failures: z.array(researchFailureSchema),
    estimated: z.literal(true),
  })
  .strict();

/** `tool_runs.result_json` for a Keep (the charge basis is `tool_runs.items_kept`). */
export const promptResearchKeepResultSchema = z
  .object({ schema_version: z.literal(1), mode: z.literal("keep"), prompts: z.array(z.string().min(1)), kept_count: z.number().int().positive(), credits_per_prompt: z.number().int().nonnegative() })
  .strict();

/** The signed `lookup.execute` job payload of a Prompt Research run (the signing layer adds `workspaceId` and `kid`). */
export const promptResearchJobPayloadSchema = z
  .object({
    kind: z.literal("prompt_research"),
    toolRunId: z.uuid(),
    prompts: z.array(z.string().min(1)).min(1).max(PROMPT_RESEARCH_MAX_PROMPTS),
    engines: z.array(z.string().min(1)).min(1),
    sharedCacheEnabled: z.boolean().default(false),
    locale: z.string().min(1),
    startedAt: z.iso.datetime(),
  })
  .passthrough();

export type DiscoverPromptsRequest = z.infer<typeof discoverPromptsRequestSchema>;
export type DiscoverPromptsResponse = z.infer<typeof discoverPromptsResponseSchema>;
export type KeepPromptsRequest = z.infer<typeof keepPromptsRequestSchema>;
export type KeepPromptsResponse = z.infer<typeof keepPromptsResponseSchema>;
export type PromptResearchEstimateQuery = z.infer<typeof promptResearchEstimateQuerySchema>;
export type PromptResearchEstimateResponse = z.infer<typeof promptResearchEstimateResponseSchema>;
export type PromptResearchRunRequest = z.infer<typeof promptResearchRunRequestSchema>;
export type PromptResearchRunAccepted = z.infer<typeof promptResearchRunAcceptedSchema>;
export type PromptResearchResult = z.infer<typeof promptResearchResultSchema>;
export type PromptResearchJobPayload = z.infer<typeof promptResearchJobPayloadSchema>;
