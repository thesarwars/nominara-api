import { z } from "zod";

// STORY-023 AC1 (T1) — api-specification.md §1 "Response envelope" and
// `NFR-API-03`: "Every list endpoint is cursor-paginated with a hard `limit`
// cap of 200 and a default of 50." Pagination is cursor-based — an opaque
// base64 of the sort-key tuple. §1 is explicit that offset pagination is not
// offered on any time-series endpoint, so there is no `offset`/page-number
// field anywhere in this file, on either side.
//
// The two bounds are named constants so no list endpoint's own request
// schema re-derives (and risks drifting from) the numbers in the reference.
export const PAGINATION_LIMIT_DEFAULT = 50;
export const PAGINATION_LIMIT_MAX = 200;

// Request side: what a list endpoint's own `.strict()` request schema
// extends with. `cursor` is absent on the first page. `limit` may be
// omitted by the caller — `.default()` alone (no trailing `.optional()`)
// both accepts that omission AND fills PAGINATION_LIMIT_DEFAULT, capped at
// PAGINATION_LIMIT_MAX, so the parsed output always carries a definite
// `limit` — the cap and the default both live here, in the schema, never
// re-checked or re-applied in a handler.
export const paginationRequestSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(PAGINATION_LIMIT_MAX).default(PAGINATION_LIMIT_DEFAULT),
  })
  .strict();

export type PaginationRequest = z.infer<typeof paginationRequestSchema>;

// Response side: the `pagination` member of the envelope (envelope.schema.ts).
// `cursor_next` is the opaque base64 cursor for the next page, `null` once
// there is no further page — a response never reuses `has_more: false` to
// stand in for the absent cursor.
export const paginationResponseSchema = z
  .object({
    cursor_next: z.string().min(1).nullable(),
    has_more: z.boolean(),
    limit: z.number().int().positive().max(PAGINATION_LIMIT_MAX),
  })
  .strict();

export type PaginationResponse = z.infer<typeof paginationResponseSchema>;
