import { createHash } from "node:crypto";
import { normalizePromptText } from "../capture/l1-cache-key.js";

// STORY-045 — `tracked_prompts.text_hash`, documented in
// `schemas/projects-and-prompts.md` as `sha256(normalise(text))` and as
// "Dedupe key AND part of the L1 cache key".
//
// THE NORMALISATION IS IMPORTED, NOT REIMPLEMENTED, and that is the whole
// point of this file existing rather than a `createHash` call at the call
// site. Because the same hash serves dedupe and the cross-tenant L1 cache, a
// second and more aggressive normalisation here would mean two prompts that
// dedupe as identical go on to be captured as different questions: the
// dedupe reports a duplicate that L1 never shares, the cost lever quietly
// stops working, and nothing goes red.
//
// capture/l1-cache-key.ts's normaliser is deliberately conservative —
// lowercase and whitespace-collapse only, "nothing that could change
// meaning". A consequence worth knowing: "Best CRM" and "Best CRM?" are
// DIFFERENT prompts under it. That is the existing behaviour of a shipped
// cross-tenant key, so this story adopts it rather than changing it; making
// punctuation insignificant is a change to L1's sharing behaviour and
// belongs with whoever owns that cache.

export interface PromptTextHash {
  /** For `tracked_prompts.text_hash`, which is `bytea`. */
  readonly bytes: Buffer;
  /** `sha256:<64 hex>` — the wire form §6's `capture.content_hash` uses. */
  readonly wire: string;
}

export function promptTextHash(text: string): PromptTextHash {
  const bytes = createHash("sha256").update(normalizePromptText(text)).digest();
  return { bytes, wire: `sha256:${bytes.toString("hex")}` };
}
