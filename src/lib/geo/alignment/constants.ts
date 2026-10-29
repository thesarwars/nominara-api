// STORY-059 - the documented numbers of alignment, coverage and projected gain, in ONE place
// (aux-and-geo-analysis.md section 7). Nothing else in the alignment code hard-codes one.
export const ALIGNMENT = {
  /** target_band = [p50, p85] of the cited documents' alignment. */
  bandLowPercentile: 0.5,
  bandHighPercentile: 0.85,
  /** "KEEP n WHERE corpus_doc_ratio >= 0.30". */
  minDocRatio: 0.3,
  /** Presence: a phrase with cosine >= 0.90 to the node's phrase. */
  presenceCosine: 0.9,
  /** Dedupe: pairwise cosine >= 0.93 collapses, keeping the higher corpus_doc_ratio. */
  dedupeCosine: 0.93,
  /** alpha = min(0.25, t_e / (t_v + t_e) * kappa). */
  alphaCap: 0.25,
  kappa: 3.5,
  /** The i-th ranked node counts 0.85^(i-1). */
  diminishing: 0.85,
  /** priority_rank orders by projected_gain x corpus_doc_ratio x severity multiplier: compliance and metric carry 1.15. */
  claimMultiplier: 1.15,
  /** Candidates: "noun phrases (2-5 tokens)". */
  minPhraseTokens: 2,
  maxPhraseTokens: 5,
  /** At most this many candidate phrases per extraction. A BUILDER CHOICE (the reference sets no cap); it bounds the nodes embedded and deduped per scope. */
  maxCandidates: 100,
  /** The embedding columns are halfvec(1536) (STORY-133). */
  dimensions: 1536,
} as const;
