import { ALIGNMENT } from "./constants.js";

// STORY-059 AC4 - step 1 and 2 of semantic node extraction (aux-and-geo-analysis.md section 7):
//   1. CANDIDATES  noun phrases of 2-5 tokens from the K cited documents
//   2. SCORE       corpus_doc_ratio(n) = docs containing n / K; keep n where it is >= 0.30
//
// THE EXTRACTOR IS A BUILDER READING. The reference names a "POS-pattern extractor", and a part-of-speech tagger is a dependency this
// story was not given. What is built is its deterministic stand-in: a run of consecutive non-function words inside one clause is a
// noun-phrase-like unit, and every window of 2-5 tokens inside a run is a candidate. It is deterministic (no model, no randomness),
// and the prevalence threshold, not the extractor, decides what survives. The curated per-category term list ("plus a curated
// per-category term list") has no data to read from yet and is not applied.
//
// The text is the cited PASSAGES the corpus holds (3 per URL at most, chosen for overlap with the cluster's prompt terms): the
// documents' stored text is all there is; the full pages are not kept.

const STOPWORDS = new Set(
  (
    "a an the and or but nor so yet for of in on at to from by with without within into onto over under about above below between among through during before after " +
    "is are was were be been being am do does did done have has had having will would can could should may might must shall " +
    "this that these those it its they them their he she his her we us our you your i me my not no as if than then there here which who whom whose what when where why how " +
    "also very more most much many such just only own same other each every any all both few some per via vs etc"
  ).split(" "),
);

/** Lowercase, fold every run of non-letter/digit (keeping `%` and an interior `.` of a number) to one space. Idempotent. */
export function normalisePhrase(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?<=\d)\.(?=\d)/g, "\uE000")
    .replace(/[^\p{L}\p{N}%\uE000]+/gu, " ")
    .replace(/\uE000/g, ".")
    .trim();
}

export interface CorpusDocument {
  readonly url: string;
  readonly text: string;
}

export interface NodeCandidate {
  readonly phrase: string;
  readonly normalized: string;
  readonly docCount: number;
  readonly docRatio: number;
  /** Total occurrences across the corpus. */
  readonly frequency: number;
  /** The first document (in input order, which the caller ranks by weight) containing the phrase, and the sentence it stands in. */
  readonly evidenceUrl: string;
  readonly evidenceSnippet: string;
}

const SNIPPET_MAX = 300;

interface Tally {
  phrase: string;
  docs: Set<number>;
  frequency: number;
  evidenceDoc: number;
  evidenceSentence: string;
}

function tokensOf(clause: string): string[] {
  return clause
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, ""))
    .filter((token) => token !== "");
}

function snippetAround(sentence: string, phrase: string): string {
  const trimmed = sentence.replace(/\s+/g, " ").trim();
  if (trimmed.length <= SNIPPET_MAX) return trimmed;
  const at = Math.max(0, trimmed.toLowerCase().indexOf(phrase.toLowerCase()));
  const start = Math.max(0, Math.min(at - 100, trimmed.length - SNIPPET_MAX));
  return trimmed.slice(start, start + SNIPPET_MAX).trim();
}

export function extractNodeCandidates(documents: readonly CorpusDocument[]): NodeCandidate[] {
  const total = documents.length;
  if (total === 0) return [];
  const tallies = new Map<string, Tally>();

  documents.forEach((document, docIndex) => {
    for (const sentence of document.text.split(/(?<=[.!?])\s+|\n+/)) {
      for (const clause of sentence.split(/[,;:()[\]"“”—–]/)) {
        let run: string[] = [];
        const flush = (): void => {
          for (let length = ALIGNMENT.minPhraseTokens; length <= ALIGNMENT.maxPhraseTokens; length += 1) {
            for (let start = 0; start + length <= run.length; start += 1) {
              const phrase = run.slice(start, start + length).join(" ");
              const normalized = normalisePhrase(phrase);
              if (normalized === "") continue;
              const tally = tallies.get(normalized);
              if (tally === undefined) {
                tallies.set(normalized, { phrase, docs: new Set([docIndex]), frequency: 1, evidenceDoc: docIndex, evidenceSentence: sentence });
              } else {
                tally.frequency += 1;
                tally.docs.add(docIndex);
              }
            }
          }
          run = [];
        };
        for (const token of tokensOf(clause)) {
          if (STOPWORDS.has(token.toLowerCase())) flush();
          else run.push(token);
        }
        flush();
      }
    }
  });

  const kept = [...tallies.entries()]
    .filter(([, tally]) => tally.docs.size / total >= ALIGNMENT.minDocRatio)
    .map(([normalized, tally]) => ({ normalized, tally }));

  // Overlapping windows of one run ("audit logging", "platform offers audit logging") are NOT pruned here: which of them is the
  // concept is decided by the embeddings (collapse at cosine >= 0.93, the shorter phrase winning a tie), not by string containment.
  return kept
    .map(({ normalized, tally }): NodeCandidate => ({
      phrase: tally.phrase,
      normalized,
      docCount: tally.docs.size,
      docRatio: tally.docs.size / total,
      frequency: tally.frequency,
      evidenceUrl: documents[tally.evidenceDoc]!.url,
      evidenceSnippet: snippetAround(tally.evidenceSentence, tally.phrase),
    }))
    .sort((a, b) => b.docRatio - a.docRatio || b.frequency - a.frequency || (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0))
    .slice(0, ALIGNMENT.maxCandidates);
}
