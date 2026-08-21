import { z } from "zod";
import { paginationResponseSchema } from "./pagination.schema.js";

// STORY-023 AC1 (T1) — api-specification.md §1 "Response envelope":
//   { "data": …, "pagination": { "cursor_next", "has_more", "limit" },
//     "meta": { "request_id", "scoring_version", "computed_at" } }
// `data` varies per endpoint, so this exports a generic builder — a
// function taking the inner data schema and returning the wrapped object
// schema — rather than hard-coding `unknown`. A hand-written response
// interface here would erase the payload type and is a review rejection
// per AC2 and coding-standards.md §2.
//
// `pagination` is present only on list endpoints (NFR-API-03), hence
// `.optional()`; a single-resource response has no pagination member at
// all, never an empty/null placeholder for it.
export const envelopeMetaSchema = z
  .object({
    request_id: z.string().min(1),
    scoring_version: z.string().min(1),
    computed_at: z.iso.datetime(),
  })
  .strict();

export type EnvelopeMeta = z.infer<typeof envelopeMetaSchema>;

export function envelopeSchema<DataSchema extends z.ZodType>(dataSchema: DataSchema) {
  return z
    .object({
      data: dataSchema,
      pagination: paginationResponseSchema.optional(),
      meta: envelopeMetaSchema,
    })
    .strict();
}

export type Envelope<DataSchema extends z.ZodType> = z.infer<ReturnType<typeof envelopeSchema<DataSchema>>>;
