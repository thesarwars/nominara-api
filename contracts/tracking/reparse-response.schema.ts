import { z } from "zod";

// STORY-034 AC9 - `POST /v1/results/{id}/reparse`: re-run the parser on a stored capture, SAVE the corrected facts, and show what
// moved. Owner decision 2026-10-23: owners and admins may do it from the Live Answer drawer (FR-PA-08), the new facts are kept, the
// capture's workspace-local date is marked dirty for the rollup, it costs nothing, and it is audited.
//
// THE DIFF IS THE PROOF, so it is a pair of the same snapshot taken either side of the write, not a list of changed fields to be
// trusted: the client (and an auditor) can compare any two members themselves. `changed` is the server's comparison of the FACTS
// (the metrics and the entities); a change of `normalizer_version` or `scoring_version` alone is visible in the snapshots and is
// not by itself a `changed`.
//
// `null` and `0` stay different: `brand_present` and `share_of_voice` are null while a capture has never been parsed, and
// `brand_rank_position` is null when the brand is not in a ranked list (the column's name; the value is the position in the answer).

export const reparseEntitySchema = z
  .object({
    entity_type: z.enum(["brand", "competitor", "other"]),
    entity_id: z.string().uuid().nullable(),
    label: z.string(),
    /** How many times the entity occurs in the answer. */
    occurrences: z.number().int().positive(),
    prominence: z.number(),
    sentiment_label: z.enum(["positive", "neutral", "negative"]),
    position_class: z.string().nullable(),
  })
  .strict();

export const reparseSnapshotSchema = z
  .object({
    normalizer_version: z.string(),
    scoring_version: z.string(),
    brand_present: z.boolean().nullable(),
    brand_rank_position: z.number().int().nullable(),
    share_of_voice: z.number().nullable(),
    sentiment_label: z.enum(["positive", "neutral", "negative", "absent"]).nullable(),
    sentiment_score: z.number().nullable(),
    citation_count: z.number().int().nonnegative(),
    owned_citation_count: z.number().int().nonnegative(),
    entities: z.array(reparseEntitySchema),
  })
  .strict();
export type ReparseSnapshot = z.infer<typeof reparseSnapshotSchema>;

export const reparseResponseSchema = z
  .object({
    result_id: z.string().uuid(),
    /** The scoring version the new facts were computed under. */
    scoring_version: z.string(),
    /** Whether the facts (metrics or entities) differ between `before` and `after`. */
    changed: z.boolean(),
    /** Always 0: a re-parse runs in-house on the stored capture (plans-and-entitlements.md). Stated so the drawer can label it. */
    credits_charged: z.literal(0),
    before: reparseSnapshotSchema,
    after: reparseSnapshotSchema,
  })
  .strict();
export type ReparseResponse = z.infer<typeof reparseResponseSchema>;
