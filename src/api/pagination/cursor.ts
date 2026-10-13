import {
  CURSOR_BASE64URL_PATTERN,
  cursorPayloadSchema,
  cursorSchema,
  type CursorPayload,
} from "../../../contracts/common/cursor.schema.js";
import { ValidationFailedError, type DomainError } from "../errors/domain-errors.js";

// STORY-024 T11 — api-specification.md §1: pagination is "cursor-based — an
// opaque base64 of the sort-key tuple. Offset pagination is not offered on
// any time-series endpoint." This file owns the encode/decode half;
// contracts/common/cursor.schema.ts owns the shapes both halves agree on.
//
// A cursor is CLIENT-SUPPLIED INPUT on every page after the first. It leaves
// the server, sits in a URL a user can edit, and comes back. So decode is
// written as parsing untrusted input, not as the inverse of encode: every
// step is validated against the contract, and a cursor that fails any of
// them is refused rather than decoded into a nonsense sort key that would
// silently skip rows — the exact failure AC7 exists to rule out.
export type CursorKeyElement = CursorPayload["k"][number];

const CURSOR_PAYLOAD_VERSION = 2;

/**
 * Encodes a sort-key tuple into the opaque wire cursor, stamped with the `list` that issued it.
 *
 * Refuses a tuple the contract cannot carry — a float key most importantly,
 * because a float cannot be compared exactly across a page boundary, which
 * is the one thing a cursor must do.
 */
export function encodeCursor(list: string, key: readonly CursorKeyElement[]): string {
  const payload = cursorPayloadSchema.safeParse({ v: CURSOR_PAYLOAD_VERSION, l: list, k: key });
  if (!payload.success) {
    throw new ValidationFailedError({
      message: "cannot encode a cursor from this sort-key tuple",
      details: {
        issues: [{ path: ["k"], message: payload.error.issues[0]?.message ?? "invalid sort-key tuple" }],
      },
    });
  }

  const cursor = Buffer.from(JSON.stringify(payload.data), "utf8").toString("base64url");

  // Encode is also the last place the WIRE contract can be honoured: a
  // cursor longer than cursorSchema's 2048 cap would be emitted by us and
  // then refused by us on the next page — a paging loop that dead-ends at a
  // page boundary rather than at a validation error anyone can read.
  const wire = cursorSchema.safeParse(cursor);
  if (!wire.success) {
    throw new ValidationFailedError({
      message: "encoded cursor does not satisfy the wire contract",
      details: {
        issues: [{ path: ["cursor"], message: wire.error.issues[0]?.message ?? "invalid cursor" }],
      },
    });
  }
  return wire.data;
}

/**
 * Decodes a wire cursor back to its sort-key tuple, refusing anything that
 * is not exactly a cursor this server issued, at the current payload
 * version, FOR THIS `list`.
 *
 * `list` is required, not optional: arity cannot tell two lists apart, and a
 * caller that could omit it would be a list that accepts every other list's
 * cursor. A cursor from another list (or from before lists were tagged) is a
 * 400, never a silent rewind.
 *
 * `expectedKeyLength` is how a caller pins the ARITY of the tuple, and
 * callers with a fixed sort key should always pass it. `v` pins the encoding
 * version but says nothing about the shape of `k`, so without this a forged
 * cursor whose tuple is SHORTER than the reader expects decodes cleanly and
 * every element the reader indexes past the end comes back `undefined`. In a
 * keyset query that `undefined` binds as SQL NULL, `(… IS NULL OR seq > …)`
 * collapses to true, and the page silently rewinds to the first row — a
 * wrong page, from client-supplied input, with no error anywhere.
 */
export function decodeCursor(cursor: string, list: string, expectedKeyLength?: number): CursorKeyElement[] {
  // Shape first, before any decoding: base64url charset and the length cap.
  // `Buffer.from(…, "base64url")` is LENIENT — it silently ignores bytes it
  // cannot decode rather than throwing — so "not a cursor!!" would otherwise
  // reach JSON.parse as garbage instead of being refused as malformed here.
  if (!cursorSchema.safeParse(cursor).success) {
    throw refuse("cursor is not a well-formed opaque cursor");
  }

  const decoded = Buffer.from(cursor, "base64url").toString("utf8");

  // Round-trip check. base64url's leniency means several distinct inputs can
  // decode to the same bytes; re-encoding and comparing pins the cursor to
  // the single canonical spelling this server issued.
  if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
    throw refuse("cursor is not canonically encoded");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw refuse("cursor does not decode to a payload");
  }

  // cursorPayloadSchema is `.strict()` with `v: z.literal(1)` and `k` a
  // non-empty array of string | int | null, so one parse covers every
  // remaining case at once: a tampered or truncated payload, an extra
  // member, an empty tuple, a float key, and a cursor issued under a
  // superseded sort key (wrong `v`).
  const payload = cursorPayloadSchema.safeParse(parsed);
  if (!payload.success) {
    throw refuse(payload.error.issues[0]?.message ?? "cursor payload is not valid");
  }
  if (payload.data.l !== list) {
    throw refuse("cursor was not issued for this list");
  }
  if (expectedKeyLength !== undefined && payload.data.k.length !== expectedKeyLength) {
    throw refuse(
      `cursor carries ${payload.data.k.length} sort-key element(s); this list is keyed on ${expectedKeyLength}`,
    );
  }
  return payload.data.k;
}

// Annotated `DomainError`, not `ValidationFailedError`: the per-code exports
// in domain-errors.ts are VALUES holding factory-produced classes, so they
// are usable with `new` and `instanceof` but not as type annotations.
function refuse(reason: string): DomainError {
  return new ValidationFailedError({
    message: "invalid pagination cursor",
    details: { issues: [{ path: ["cursor"], message: reason }] },
  });
}

export { CURSOR_BASE64URL_PATTERN, CURSOR_PAYLOAD_VERSION };
