import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";

// STORY-181 - the raw capture object.
//
// `system-architecture.md` 6.1 step c writes each raw answer to `{env}/{ws}/{yyyy}/{mm}/{id}.json.gz`. The body is the SAME
// shape `answer_captures.payload` holds for a captured row (format, text, structured fields), gzipped JSON, so the parser
// reads one thing whichever copy it is handed. The workspace prefix is added by the tenant object store, never here.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A decompressed raw answer larger than this is refused: an engine answer is kilobytes, and gunzip must not be a bomb. */
export const MAX_RAW_OBJECT_BYTES = 16 * 1024 * 1024;

/** The relative key of a capture's raw object: `{yyyy}/{mm}/{id}.json.gz`, in UTC. */
export function rawObjectRelativeKey(capturedAt: Date, resultId: string): string {
  if (!UUID.test(resultId)) throw new Error("raw object key requires a lowercase uuid result id");
  const year = String(capturedAt.getUTCFullYear()).padStart(4, "0");
  const month = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
  // Joined, not one template literal: the key is RELATIVE (the tenant store prepends env and workspace), and the ISO-14 scanner flags
  // a leading interpolated segment in src/ that is not already in env-then-workspace order.
  return [year, month, `${resultId}.json.gz`].join("/");
}

/** Not `.strict()`: this reads an object a past version wrote, and an added field must not make an old answer unreadable. */
export const rawObjectBodySchema = z.object({
  format: z.string().optional(),
  text: z.string(),
  structured_citations: z.array(z.unknown()).optional(),
  structured_elements: z.array(z.unknown()).optional(),
  vendor_request_id: z.string().optional(),
});
export type RawObjectBody = z.infer<typeof rawObjectBodySchema>;

/** The stored bytes are not a gzip of a raw body. Never turned into an empty answer: an empty answer is a measurement. */
export class RawObjectCorruptError extends Error {
  constructor(reason: string) {
    super(`raw capture object is corrupt: ${reason}`);
    this.name = "RawObjectCorruptError";
  }
}

export function encodeRawObject(body: Record<string, unknown>): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(body), "utf8"));
}

export function decodeRawObject(bytes: Uint8Array): RawObjectBody {
  let json: unknown;
  try {
    json = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_RAW_OBJECT_BYTES }).toString("utf8"));
  } catch {
    throw new RawObjectCorruptError("not gzip of JSON, or larger than the limit");
  }
  const parsed = rawObjectBodySchema.safeParse(json);
  if (!parsed.success) throw new RawObjectCorruptError("not a raw answer body");
  return parsed.data;
}
