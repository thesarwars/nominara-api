import { CORPUS } from "./constants.js";

// STORY-058 AC6 / step 5 - per URL, keep the chunks with the highest BM25 overlap with the cluster's prompt terms, so navigation and
// footer text cannot dilute the centroid. BM25 is the reference's named scorer; k1 and b are the textbook defaults (the reference
// does not pin them). IDF is taken over the URL's own chunks - the only collection in hand when a page is being filtered.

const K1 = 1.2;
const B = 0.75;

const STOP_WORDS: ReadonlySet<string> = new Set(
  "a an and are as at be but by can do does for from has have how i in is it its of on or our so than that the their them these they this to us was we what when where which who why will with you your".split(" "),
);

export function tokenizeTerms(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

export function queryTermsOf(promptTexts: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const text of promptTexts) for (const word of tokenizeTerms(text)) if (!STOP_WORDS.has(word)) terms.add(word);
  return [...terms];
}

export interface ScoredChunkInput {
  readonly index: number;
  readonly text: string;
}

/** The kept chunks, best first. A chunk sharing no term with the query scores 0 and is never kept. */
export function selectTopChunks<T extends ScoredChunkInput>(chunks: readonly T[], queryTerms: readonly string[], keep: number = CORPUS.keepPerUrl): T[] {
  if (chunks.length === 0 || queryTerms.length === 0) return [];
  const docs = chunks.map((chunk) => tokenizeTerms(chunk.text));
  const averageLength = docs.reduce((total, doc) => total + doc.length, 0) / docs.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) documentFrequency.set(term, docs.filter((doc) => doc.includes(term)).length);

  const scored = chunks.map((chunk, i) => {
    const doc = docs[i]!;
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.reduce((count, word) => (word === term ? count + 1 : count), 0);
      if (tf === 0) continue;
      const n = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / averageLength));
    }
    return { chunk, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index)
    .slice(0, keep)
    .map((entry) => entry.chunk);
}
