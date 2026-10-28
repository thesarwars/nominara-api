import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { CrawlManifest } from "../../../contracts/aux/index.js";
import type { DocumentSnapshot } from "./document-model.js";

// STORY-050 AC10 — a stored crawl page turned back into the snapshot the document model is built from. The inputs are the manifest
// page (what the crawl recorded) and the objects it names; nothing is fetched and no clock is read, so the same stored audit
// always yields the same snapshot, and so the same model.

/** Reads one stored object by the key the manifest holds. Injected: the caller owns the tenant binding and the bucket. */
export type ReadStoredObject = (objectKey: string) => Promise<Buffer>;

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

async function readCopy(copy: { object_key: string; sha256: string }, read: ReadStoredObject): Promise<string> {
  const bytes = gunzipSync(await read(copy.object_key));
  // The recorded hash is the proof the bytes are the ones the crawl stored; a mismatch is refused, never modelled. The message
  // names no key and no content.
  if (sha256(bytes) !== copy.sha256) throw new Error("stored copy does not match its recorded hash");
  return bytes.toString("utf8");
}

/**
 * null = this page has no snapshot: it has no stored plain copy (skipped or failed), or its manifest predates the fetch record,
 * so the redirect chain, headers and timing cannot be reproduced. A missing rendered copy is `renderedHtml: null`, never "".
 */
export async function loadDocumentSnapshot(page: CrawlManifest["pages"][number], read: ReadStoredObject): Promise<DocumentSnapshot | null> {
  if (page.raw === undefined || page.fetch === undefined) return null;
  const rawHtml = await readCopy(page.raw, read);
  const renderedHtml = page.rendered === undefined ? null : await readCopy(page.rendered, read);
  return {
    url: page.url,
    finalUrl: page.fetch.final_url,
    httpStatus: page.fetch.http_status,
    redirectChain: [...page.fetch.redirect_chain],
    headers: { ...page.fetch.headers },
    rawHtml,
    renderedHtml,
    timing: { ttfbMs: page.fetch.ttfb_ms, loadMs: page.fetch.load_ms },
  };
}
