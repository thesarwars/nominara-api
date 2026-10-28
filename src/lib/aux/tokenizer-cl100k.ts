import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import type { Tokenizer } from "./tokenizer.js";

// STORY-050 AC3 — cl100k_base is the encoding of text-embedding-3-large, the embedding model (owner decision 2026-10-28 #2),
// counted by the pure-JS gpt-tokenizer package.
//
// SPECIAL-TOKEN TEXT IS TEXT. The package refuses an input containing `<|endoftext|>` by default, and a crawled page can contain
// that string: one hostile page would fail the whole audit. An empty `disallowedSpecial` makes it count as the ordinary
// characters it is on the page (which is also how the embedding API tokenises user text).

/** Pinned with the dependency in package.json; the unit test fails if the two drift, so a bump is a deliberate, visible change. */
export const CL100K_PACKAGE_VERSION = "4.1.0";

export const cl100kTokenizer: Tokenizer = {
  identity: { name: "cl100k_base", version: `gpt-tokenizer@${CL100K_PACKAGE_VERSION}` },
  count: (text) => (text === "" ? 0 : encode(text, { disallowedSpecial: new Set() }).length),
};
