// STORY-058 - the documented numbers of the retrieval-centroid construction, in ONE place
// (aux-and-geo-analysis.md section 6; schemas/geo-and-vectors.md corpus_passages / geo_alignments).
export const CORPUS = {
  /** Step 1: "all citation_facts rows for P's prompts in the last 90 days". */
  windowDays: 90,
  /** Step 2: "keep the top K = 25 URLs". */
  topUrls: 25,
  /** Step 4: "512 tokens, 64-token overlap". */
  chunkTokens: 512,
  chunkOverlapTokens: 64,
  /** Step 5: "per URL keep the 3 chunks with the highest lexical overlap". */
  keepPerUrl: 3,
  /** corpus_passages.expires_at: "30 days" (NFR-OPT-04). */
  ttlDays: 30,
  /** "A centroid built from fewer than 8 passages is marked low-confidence". */
  minPassages: 8,
  /** "recommendations past rank 3 are suppressed" (EC-24). */
  suppressPastRank: 3,
} as const;
