import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { dataSourceSchema } from "./data-source.schema.js";
import { citationGapEntrySchema, conceptGapEntrySchema, displacedByEntrySchema } from "./displacement-event.schema.js";

// NEW-C-5 — the displacement feed (`GET /v1/projects/{id}/displacements`) and
// the dismiss/restore pair. `api-specification.md` §3 (feed, `tracking:read`),
// FR-CO-04, STORY-092 AC "Losses ranked by impact, filterable by engine and
// kind, with recovered losses marked distinctly" and "Dismissing a loss is
// reversible and recorded".
//
// EVERY ROW CARRIES ITS EVIDENCE. `before_result_id` and `after_result_id` are
// NOT nullable: the feed never returns a row whose two captures are not both
// stored, so a client that renders from this schema cannot render a loss
// without a capture behind it.

/** The `displacement_events.kind` CHECK list, verbatim (`scoring-models.md` §9). */
export const displacementKindSchema = z.enum(["presence_lost", "position_lost", "recommendation_lost", "render_downgraded"]);

export const displacementFeedQuerySchema = paginationRequestSchema
  .extend({
    /** One engine key. */
    engine: z.string().min(1).optional(),
    kind: displacementKindSchema.optional(),
    /** Dismissed rows are left out unless asked for. */
    include_dismissed: z.enum(["true", "false"]).default("false"),
  })
  .strict();

export const displacementItemSchema = z
  .object({
    id: z.string().uuid(),
    project_id: z.string().uuid(),
    prompt_id: z.string().uuid(),
    engine_key: z.string().min(1),
    detected_at: z.string(),
    kind: displacementKindSchema,
    /** The capture before the loss. Always present: no evidence, no row. */
    before_result_id: z.string().uuid(),
    /** The capture after the loss. Always present. */
    after_result_id: z.string().uuid(),
    before_position: z.number().int().nullable(),
    after_position: z.number().int().nullable(),
    before_position_class: z.string().nullable(),
    after_position_class: z.string().nullable(),
    /** Who took the slot, with prominence and position class (stored `displaced_by`). */
    takers: z.array(displacedByEntrySchema),
    /** `{url, domain, source_class, held_by, brand_present}`; `brand_present` null = never verified. */
    citation_gap: z.array(citationGapEntrySchema),
    concept_gap: z.array(conceptGapEntrySchema),
    impact_score: z.number(),
    /** Non-null = a later capture restored what was lost. */
    recovered_at: z.string().nullable(),
    /** Non-null = dismissed by a person; the row is only here because it was asked for. */
    dismissed_at: z.string().nullable(),
    /** The recovery plan's first task, once one exists. */
    task_id: z.string().uuid().nullable(),
    /** Tasks a recovery plan would create now: one per concept gap, one per citation gap on a seedable domain. */
    recovery_task_count: z.number().int().nonnegative(),
    /** Provenance of the two captures behind the row. Null only if neither could be classified. */
    data_source: dataSourceSchema.nullable(),
  })
  .strict();

/** The list route returns a page of these; the envelope carries the cursor. */
export const displacementFeedResponseSchema = displacementItemSchema;

export const displacementDismissalResponseSchema = z
  .object({
    id: z.string().uuid(),
    /** Set after a dismiss, null after a restore. */
    dismissed_at: z.string().nullable(),
  })
  .strict();

export type DisplacementFeedQuery = z.infer<typeof displacementFeedQuerySchema>;
export type DisplacementItem = z.infer<typeof displacementItemSchema>;
export type DisplacementDismissalResponse = z.infer<typeof displacementDismissalResponseSchema>;
