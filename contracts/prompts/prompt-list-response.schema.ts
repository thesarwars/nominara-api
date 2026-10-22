import { z } from "zod";
import { PAGINATION_LIMIT_DEFAULT, PAGINATION_LIMIT_MAX } from "../common/pagination.schema.js";
import { funnelStageSchema, intentArchetypeSchema } from "./archetype.schema.js";

// STORY-134 — `GET /v1/projects/{id}/prompts`. api-specification.md §3:
// "filter by engine, topic cluster, archetype, funnel, presence, sentiment,
// status".
//
// *** FOUR OF THOSE SEVEN FILTERS HAVE NO PRODUCER, AND ARE ABSENT HERE. ***
//
// `engine`, `presence` and `sentiment` are derived from CAPTURE RUNS — no
// engine adapter, no seeded catalog, no parser. `topic cluster` needs
// `cluster_id`, which nothing assigns until STORY-047 (itself blocked on
// STORY-133's embedding client).
//
// `.strict()` therefore turns each of them into a `400 validation_failed`
// naming the parameter. A filter that is ACCEPTED AND IGNORED is worse than
// one that refuses: the customer believes they narrowed the list, and a
// prompt they were looking for is missing for a reason the UI cannot show.
// When a producer lands, adding the key here is additive.

export const promptListQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .overwrite((value) => Math.min(value, PAGINATION_LIMIT_MAX))
      .max(PAGINATION_LIMIT_MAX)
      .default(PAGINATION_LIMIT_DEFAULT),

    // The three real columns.
    status: z.enum(["active", "paused", "archived"]).optional(),
    intent_archetype: intentArchetypeSchema.optional(),
    funnel_stage: funnelStageSchema.optional(),
  })
  .strict();

export type PromptListQuery = z.infer<typeof promptListQuerySchema>;

/**
 * One prompt, as the matrix's row identity — NOT its cells.
 *
 * `FR-PA-01a`'s cell data (rank, share of voice, sentiment glyph, cache
 * state) is Slice 4's: it comes from capture runs through the parser and the
 * scoring core, none of which exist. Inventing a shape for it here would
 * publish a contract nothing can fill, and STORY-091 would build against it.
 *
 * So this carries the prompt's own columns and nothing else. The three
 * nullable members below are real columns whose producers are named.
 */
export const promptListItemSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string(),
    text_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    intent_archetype: intentArchetypeSchema,
    funnel_stage: funnelStageSchema,
    status: z.enum(["active", "paused", "archived"]),
    /**
     * STORY-077 — set (with `status: "paused"`) when a downgrade paused this prompt at its cut-over; null otherwise,
     * including when a person paused it. A downgrade pause resumes automatically on a later upgrade; a person changing
     * the prompt's status clears it.
     */
    paused_by_downgrade_at: z.string().nullable(),
    is_priority: z.boolean(),
    /** `generated` is distinct from `manual` on the wire because §6 renders them differently. */
    generation_source: z.enum(["discovery", "generated", "manual", "imported", "tool_conversion", "gsc_query"]),
    /** Groups one pass "for review and undo" — the column's own words. Null for a manual prompt. */
    generation_batch_id: z.string().uuid().nullable(),

    // --- real columns, null until their producer exists ---
    /** Assigned by STORY-047's clustering job. */
    cluster_id: z.string().uuid().nullable(),
    /** `FR-PA-07`'s drift warning reads this. Written by the stability rollup, behind the parser. */
    stability_score: z.number().nullable(),
    /** Null until a capture run touches this prompt — never epoch, never "now". */
    last_captured_at: z.string().nullable(),

    created_at: z.string(),
  })
  .strict();

export type PromptListItem = z.infer<typeof promptListItemSchema>;

/**
 * `FR-PA-03a`'s header, computed server-side.
 *
 * "The header shows `active / cap` and the archived count." Returned as
 * counts rather than left for the client to derive from the page, because
 * the page is ONE CURSOR PAGE — a 50-row page of a 200-prompt project would
 * make the client's own tally wrong, and quietly.
 */
export const promptSetSummarySchema = z
  .object({
    active: z.number().int().nonnegative(),
    /** Paused prompts still occupy a slot, so the header's arithmetic needs them separately. */
    paused: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    cap: z.number().int().nonnegative(),
  })
  .strict();

export type PromptSetSummary = z.infer<typeof promptSetSummarySchema>;

export const promptListResponseSchema = z
  .object({
    prompts: z.array(promptListItemSchema),
    summary: promptSetSummarySchema,
  })
  .strict();

export type PromptListResponse = z.infer<typeof promptListResponseSchema>;
