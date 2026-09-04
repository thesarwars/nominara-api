import { z } from "zod";
import { DISCOVERY_STATUSES } from "./create-project-response.schema.js";

// STORY-043 — GET /v1/projects/{id}/discovery. api-specification.md §4.5.

/**
 * The confidence below which a value is FLAGGED rather than applied (§4.5:
 * "Values below 0.60 are listed in low_confidence_fields").
 *
 * A named constant because two places must agree — the field's own
 * `confidence` and the `low_confidence_fields` list — and a literal repeated
 * in both is how they drift. AC13's "nothing discovered is applied without
 * appearing in the review payload with its confidence" is unfalsifiable if
 * the threshold differs between the writer and the lister.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export const discoveredFieldSchema = z
  .object({
    value: z.unknown(),
    confidence: z.number().min(0).max(1),
    source: z.string().optional(),
    // §4.5's example omits `user_edited` on most fields; it is optional on the
    // wire and defaulted false by the reader rather than written on every row.
    user_edited: z.boolean().optional(),
  })
  .strict();

export const proposedCompetitorSchema = z
  .object({
    name: z.string(),
    root_domain: z.string().optional(),
    confidence: z.number().min(0).max(1),
    // AC11 — "each with a basis". Not optional: an unexplained list of names
    // is not something a customer can judge, and the story calls the basis out
    // as the thing that makes the list credible.
    basis: z.string(),
  })
  .strict();

export const generatedPromptSchema = z
  .object({
    prompt_id: z.string(),
    text: z.string(),
    intent_archetype: z.string(),
    funnel_stage: z.string(),
    generation_source: z.string(),
  })
  .strict();

export const discoveryResponseSchema = z
  .object({
    discovery_status: z.enum(DISCOVERY_STATUSES),
    duration_ms: z.number().int().nonnegative().nullable(),
    // Fields the caller SUPPLIED are absent (§4.5): nothing was discovered for
    // them, so re-proposing them for review would contradict AC1.
    fields: z.record(z.string(), discoveredFieldSchema),
    competitors_proposed: z.array(proposedCompetitorSchema),
    prompts_generated: z.array(generatedPromptSchema),
    prompts_free_remaining: z.number().int().nonnegative(),
    // AC12 — asserted, not assumed: discovery and the free allowance charge
    // nothing. Carried on the wire so a client can show it, and so the
    // acceptance test has something to read.
    credits_charged: z.literal(0),
    low_confidence_fields: z.array(z.string()),
  })
  .strict();

export type DiscoveryResponse = z.infer<typeof discoveryResponseSchema>;
export type DiscoveredField = z.infer<typeof discoveredFieldSchema>;
export type ProposedCompetitor = z.infer<typeof proposedCompetitorSchema>;
