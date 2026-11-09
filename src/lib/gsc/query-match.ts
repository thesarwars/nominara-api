// STORY-115 J2-J4 - the FUZZY query join. A Search Console query is matched to a tracked prompt by trigram similarity.
//
// THE METHOD, in full (documented here and nowhere else, so the code and the description cannot drift):
//   1. Normalise both strings: Unicode NFKC, lower case, every run of characters that is not a letter or digit becomes one space.
//   2. Take each word, pad it with two spaces in front and one behind, and collect its three-character slices. This is the pg_trgm
//      construction, so the figure agrees with what the database's `similarity()` would say for the same strings.
//   3. The similarity is |A intersect B| / |A union B| over the two trigram SETS, from 0 to 1.
//   4. The best-scoring prompt wins; a tie goes to the lowest prompt id, so the answer never depends on input order.
//   5. A best score BELOW `QUERY_MATCH_FLOOR` is not a match at all: it returns null and the query is not joined. A weak join would
//      look like evidence and its label would be ignored more often than read.
//
// THE CONFIDENCE IS THE SIMILARITY. Embedding similarity (the reference's second signal) needs a vector for the query, which only the
// embed.batch worker may fetch, and no column holds one for a Search Console query: until it does the method is `trigram` and the
// response says so. The floor is the reference's 0.80, applied to this score.
//
// NO RESULT IS EVER EXACT. Even a score of 1 means "identical after normalising", not "the same prompt".

/** FR-GSC-01d / integrations-and-sharing.md section 7: a match below this similarity is not joined. */
export const QUERY_MATCH_FLOOR = 0.8;
/** A joined match below this is labelled low confidence. The specification states the floor, not this band: PROVISIONAL, one line to change. */
export const LOW_CONFIDENCE_BELOW = 0.9;

export interface QueryMatch {
  readonly promptId: string;
  readonly method: "trigram";
  readonly confidence: number;
  readonly lowConfidence: boolean;
}

function normalise(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function trigramsOf(text: string): Set<string> {
  const set = new Set<string>();
  for (const word of normalise(text).split(" ")) {
    if (word === "") continue;
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1) set.add(padded.slice(index, index + 3));
  }
  return set;
}

/** 0..1, symmetric, and 0 when either side has no letters or digits. */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigramsOf(a);
  const right = trigramsOf(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function matchQueryToPrompt(query: string, prompts: ReadonlyArray<{ readonly id: string; readonly text: string }>): QueryMatch | null {
  let best: { id: string; score: number } | undefined;
  for (const prompt of prompts) {
    const score = trigramSimilarity(query, prompt.text);
    if (best === undefined || score > best.score || (score === best.score && prompt.id < best.id)) best = { id: prompt.id, score };
  }
  if (best === undefined || best.score < QUERY_MATCH_FLOOR) return null;
  return { promptId: best.id, method: "trigram", confidence: best.score, lowConfidence: best.score < LOW_CONFIDENCE_BELOW };
}
