import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";
import { paginationRequestSchema } from "../common/pagination.schema.js";

// STORY-034 AC7 (the list half) - `GET /v1/projects/{id}/results`, "cursor over answer_captures" (api-specification.md section 3).
//
// A LIST OF CAPTURES, NOT OF DOCUMENTS. The full parser document is `GET /results/{id}`; a list item carries the cell's identity,
// its state and the 280-character excerpt the capture step already keeps for previews, so a page of 200 is not 200 documents.
// `status` is the column's own vocabulary, and a `failed`/`blocked` row is LISTED with its `error_code`: "we could not ask" and
// "the engine did not mention you" stay different facts here as they are in the matrix.

export const resultStatusSchema = z.enum(["captured", "parsed", "failed", "blocked", "skipped"]);

export const resultsListQuerySchema = paginationRequestSchema
  .extend({
    engine_key: z.string().min(1).optional(),
    prompt_id: lowercaseUuidSchema.optional(),
    run_id: lowercaseUuidSchema.optional(),
    status: resultStatusSchema.optional(),
    /**
     * The window, inclusive of `from` and exclusive of `to`. A `from` that predates the workspace's raw-capture retention is
     * `507 retention_exceeded`, never a quiet empty page; when omitted, the window opens at the retention boundary.
     */
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type ResultsListQuery = z.infer<typeof resultsListQuerySchema>;

export const resultListItemSchema = z
  .object({
    result_id: z.string().uuid(),
    run_id: z.string().uuid(),
    prompt_id: z.string().uuid(),
    engine_key: z.string().min(1),
    sample_index: z.number().int().nonnegative(),
    captured_at: z.string().datetime({ offset: true }),
    status: resultStatusSchema,
    /** Populated on `failed` and `blocked`; null otherwise. */
    error_code: z.string().nullable(),
    cache_layer: z.enum(["live", "l1", "l2"]),
    /** Null until the capture is parsed (and for a cell that produced no answer): not a zero, not a false. */
    brand_present: z.boolean().nullable(),
    citation_count: z.number().int().nonnegative(),
    scoring_version: z.string(),
    /** The first 280 characters of the answer, as the capture step stored them; null when nothing was captured. */
    response_excerpt: z.string().nullable(),
  })
  .strict();
export type ResultListItem = z.infer<typeof resultListItemSchema>;

export const resultsListResponseSchema = z.array(resultListItemSchema);
export type ResultsListResponse = z.infer<typeof resultsListResponseSchema>;
