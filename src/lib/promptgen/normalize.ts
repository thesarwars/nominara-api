// STORY-045 — §4 step 1 NORMALIZE.
//
//   topic "HubSpot lead software"
//    1. NORMALIZE  lowercase, strip stopwords and punctuation, lemmatise the
//                  head noun -> the dedupe key and the L5 cache key input
//
// THE TOPIC NORMALISER, NOT THE PROMPT-TEXT ONE. Prompt text is normalised
// by capture/l1-cache-key.ts, conservatively and on purpose ("nothing that
// could change meaning"), because that normalisation feeds a CROSS-TENANT
// cache. This one is aggressive, because its job is the opposite: collapse
// every way a customer might phrase the same topic onto one L5 cache entry.
// text-hash.ts reuses the conservative one; nothing reuses this one for
// prompt text.

/**
 * Words stripped from a topic.
 *
 * A CURATED LIST, for the reason discovery's `common-words.ts` records about
 * its own: the requirement is not "is this an English function word" but
 * "would keeping this word fragment the cache for no benefit". Short enough
 * to read in a diff.
 *
 * `best`, `top` and `cheap` are deliberately ABSENT. They read as stopwords
 * and they are not: "best CRM" and "cheap CRM" are different buyer questions
 * and should not share a cache entry or a dedupe key.
 */
export const TOPIC_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "into",
  "about",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "my",
  "our",
  "your",
  "their",
  "its",
  "that",
  "this",
  "these",
  "those",
]);

/**
 * A rule-based singulariser for the head noun.
 *
 * NOT a lemmatiser in the linguistic sense, and named honestly: real
 * lemmatisation needs a morphological dictionary, which is a dependency, and
 * `development-workflow.md` §6 puts adding one outside what this story can
 * decide. §4 asks for the head noun lemmatised; these four rules cover the
 * plural forms that actually occur in a product-category topic.
 *
 * Every rule is guarded against the failure that matters — silently
 * corrupting a word into a non-word, which then lives in a stored cache key
 * where nobody looks. `business` must not become `busines`.
 */
export function singularise(word: string): string {
  // Too short for any suffix rule to be safe: "ops" -> "op", "sms" -> "sm".
  if (word.length <= 3) return word;

  // "analyses" -> "analysis", "diagnoses" -> "diagnosis". Before the -es
  // rule, which would give "analyse".
  if (word.endsWith("ses") && word.length > 5) return `${word.slice(0, -3)}sis`;

  // "companies" -> "company". Never "series" -> "sery": -ies needs a
  // consonant before it.
  if (word.endsWith("ies") && word.length > 4 && !/[aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;

  // "boxes" -> "box", "matches" -> "match". Only after a sibilant, or the
  // rule eats a real letter: "codes" -> "cod".
  if (/(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);

  // "platforms" -> "platform". Guarded against -ss ("business"), -us
  // ("status"), -is ("analysis") and -os, none of which are plurals.
  if (word.endsWith("s") && !/(?:ss|us|is|os)$/.test(word)) return word.slice(0, -1);

  return word;
}

/**
 * The dedupe key and L5 cache key input for a topic.
 *
 * Idempotent, which is what makes it safe to normalise a value that may
 * already have been normalised — a caller cannot tell, and re-normalising
 * must not keep stripping.
 */
export function normalizeTopic(raw: string): string {
  const words = raw
    .toLowerCase()
    // Punctuation to spaces rather than removed, so "lead-management" becomes
    // two tokens instead of one welded "leadmanagement" that matches nothing.
    // Unicode letters and digits are kept, so a non-Latin topic survives.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word.length > 0);

  if (words.length === 0) return "";

  const kept = words.filter((word) => !TOPIC_STOPWORDS.has(word));

  // A topic of pure stopwords keeps its words rather than normalising to "".
  // Otherwise every such project shares one L5 cache entry, and one
  // customer's naturalised array is served to another.
  const content = kept.length > 0 ? kept : words;

  // §4 says the HEAD noun. English compounds are right-headed — "lead
  // management platforms" is a kind of platform — so the head is the last
  // token. Singularising every token instead turns the modifier "analytics"
  // into "analytic", which is a different word and a worse key.
  const head = content.length - 1;
  return content.map((word, index) => (index === head ? singularise(word) : word)).join(" ");
}
