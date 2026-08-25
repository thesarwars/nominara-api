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
// both accepts that omission AND fills PAGINATION_LIMIT_DEFAULT, so the
// parsed output always carries a definite `limit`. The cap and the default
// both live here, in the schema, never re-checked or re-applied in a handler.
//
// STORY-024 T11 — the cap CLAMPS, it does not reject. STORY-023 shipped
// `.max(PAGINATION_LIMIT_MAX)` with a comment claiming the value was
// "capped", but `.max()` VALIDATES: `safeParse({limit: 500})` failed with
// `too_big`. The story's own scenario 5 says "Clamped to the cap", so the
// schema was wrong, not the story.
//
// `.overwrite()` rather than `.transform()`, for a measured reason. Both
// clamp identically at runtime, but `.transform()` makes the schema
// unrepresentable in JSON Schema on the OUTPUT side — verified:
// `z.toJSONSchema(…, {io: "output"})` throws "Transforms cannot be
// represented in JSON Schema" — and on the INPUT side it erases
// `maximum: 200`, replacing it with zod's `.int()` artifact
// `maximum: 9007199254740991`. That would publish a nine-quadrillion cap to
// every consumer of `@nominara/client` while the server honours 200.
// `.overwrite()` is a same-type check, so BOTH io modes still emit
// `maximum: 200` — and that number is now true of the parsed output rather
// than a promise about what the server refuses.
//
// Ordered clamp-then-validate: `.overwrite()` runs before `.max()`, so the
// bound can never fire. It is kept as the assertion that the clamp works —
// if the clamp is ever removed, `.max()` turns a silent nine-quadrillion
// limit back into a loud rejection instead of a `LIMIT 500` query.
export const paginationRequestSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .overwrite((value) => Math.min(value, PAGINATION_LIMIT_MAX))
      .max(PAGINATION_LIMIT_MAX)
      .default(PAGINATION_LIMIT_DEFAULT),
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
