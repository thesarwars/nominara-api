import { z } from "zod";

// STORY-024 T7 — api-specification.md §1: pagination is "cursor-based — an
// opaque base64 of the sort-key tuple. Offset pagination is not offered on
// any time-series endpoint." The wire form and the decoded form are two
// different things and only the first is a contract:
//
//   cursorSchema         what crosses the boundary. OPAQUE to the client by
//                        design — it is validated for shape, never parsed by
//                        a consumer, and `@nominara/client` exposes it as a
//                        string it received and hands back.
//   cursorPayloadSchema  what the server encodes INTO that string. Lives here
//                        beside the wire form so both versions move together,
//                        but it is not a promise to any client: T11's
//                        src/api/pagination/cursor.ts owns encode/decode.
//
// base64url, not base64: a cursor is echoed back in a query string, and `+`
// and `/` do not survive that round trip without escaping.
export const CURSOR_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const cursorSchema = z.string().min(1).max(2048).regex(CURSOR_BASE64URL_PATTERN);

export type Cursor = z.infer<typeof cursorSchema>;

// The sort-key tuple itself. `v` is the encoding version, so a later sort-key
// change can reject a stale cursor explicitly instead of decoding it into the
// wrong column order and silently skipping rows — the failure AC7 (paging a
// list while rows are inserted) exists to rule out.
//
// A key element is a string, an integer, or null: RFC 3339 timestamps and
// UUIDs travel as strings, monotonic sequence numbers as integers, and null
// is the trailing-column case for a nullable sort column. Floats are excluded
// deliberately — a float sort key cannot be compared exactly across a page
// boundary, which is the one thing a cursor must do.
export const cursorKeyElementSchema = z.union([z.string(), z.number().int(), z.null()]);

export const cursorPayloadSchema = z
  .object({
    v: z.literal(1),
    k: z.array(cursorKeyElementSchema).min(1),
  })
  .strict();

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;
