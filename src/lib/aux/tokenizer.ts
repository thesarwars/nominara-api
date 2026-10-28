// STORY-050 AC3 — every context-fitness threshold (AUX-R-019..023) is a TOKEN count, so the counter must be the embedding model's
// own tokenizer, not a word-count approximation (aux-and-geo-analysis.md, "The document model").
//
// The document builder takes this port instead of importing a tokenizer package, so the model is built the same way under a test
// double and under the real one, and a tokenizer change is visible in `identity` rather than silently shifting every threshold.

export interface TokenizerIdentity {
  /** The encoding, e.g. `cl100k_base` (text-embedding-3-large). */
  readonly name: string;
  /** The version of the implementation that produced the counts. */
  readonly version: string;
}

export interface Tokenizer {
  readonly identity: TokenizerIdentity;
  /** Exact number of tokens in `text`. "" is 0. */
  count(text: string): number;
}

/** The value written to `aux_audits.tokenizer`: the encoding and the implementation version, so a bump is a visible change. */
export function tokenizerLabel(identity: TokenizerIdentity): string {
  return `${identity.name}@${identity.version}`;
}
