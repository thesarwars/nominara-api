import { ValidationFailedError } from "../errors/domain-errors.js";
import { decodeCursor } from "./cursor.js";

// NEW-E-7 checkpoint-6 — the (timestamp, uuid) keyset cursor shared by the lists that page on
// "created_at/viewed_at DESC, id DESC". The timestamp half travels at FULL (microsecond) precision: a
// millisecond key would skip rows that share a millisecond, which is the page-boundary tie the cursor exists for.
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function invalidCursor(): InstanceType<typeof ValidationFailedError> {
  return new ValidationFailedError({
    message: "invalid pagination cursor",
    details: { issues: [{ path: ["cursor"], message: "cursor was not issued for this list" }] },
  });
}

/** Decodes a `[timestamp-micros, uuid]` cursor; a cursor issued for any other list is a 400, never a silent first page. */
export function decodeTimestampIdCursor(cursor: string, list: string): [string, string] {
  const [at, id, ...rest] = decodeCursor(cursor, list, 2);
  if (rest.length > 0 || typeof at !== "string" || !ISO_MICROS.test(at) || typeof id !== "string" || !UUID.test(id)) throw invalidCursor();
  return [at, id];
}

/** The SQL expression that renders a timestamptz column as the microsecond string the cursor carries. */
export const MICROS_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
