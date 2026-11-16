import { createHash } from "node:crypto";

// STORY-189 AC3 / decision 88(b) — classify a discovered site against the taxonomy by NEAREST MATCH of embeddings.
//
// What is embedded: the site's own text (title, description, hero copy, nav, Product schema) against each category's `name. description`
// (the description is written to be compared with site text; see migration 0187). The nearest category wins; the confidence says how clearly.
//
// THE EMBEDDING PROVIDER IS NOT IMPORTED HERE. The port is reachable from embed-batch.handler.ts only (NFR-ARCH-01, enforced by eslint),
// so this file takes a `TextEmbedder` and the handler that owns the port builds one (`textEmbedderFor`). That also keeps this pure: no
// network, no database, which is what lets crawl.discover call it from its no-transaction `run` phase (ADR-0003).
//
// All 180 category vectors are computed once per (model, taxonomy text) per process and kept in memory. A vector is only ever compared
// with one from the SAME model: a different model is a different cache entry, never a mixed comparison (EC-23).

/** The provider call size (system-architecture.md section 4: "batch of 96 texts"). */
const PROVIDER_BATCH = 96;

/** Characters of site text sent to the provider. Bounds the spend of one discovery however large the page. */
export const MAX_CLASSIFICATION_TEXT_CHARS = 4000;

/** The source label recorded beside the discovered category (§4.5: every field carries a source). */
export const CATEGORY_CLASSIFICATION_SOURCE = "embedding nearest match";

/**
 * PROVISIONAL. Turns the spread of cosines into a confidence: a softmax over every category's cosine at this temperature, so the
 * confidence is the share the winner takes, and a runner-up close behind (or a site equally near everything) gives a low one.
 * Decision 88(b) and categories-draft.md section 5 item 11: the cut-off and its calibration can only be set once the production embedding
 * model is chosen and measured on GS-DISCOVER, so this one number is the single place to change then. The 0.60 line itself is the
 * specification's (`LOW_CONFIDENCE_THRESHOLD`), not this file's.
 */
export const CATEGORY_SOFTMAX_TEMPERATURE = 0.05;

export interface CategoryDescriptor {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
}

export interface TextEmbedder {
  /** The provider's pinned model identifier. Vectors are cached and compared per model. */
  readonly model: string;
  /** One provider call for up to 96 texts. */
  embed(texts: readonly string[]): Promise<{ readonly vectors: readonly (readonly number[])[]; readonly totalTokens: number }>;
}

export interface CategoryClassification {
  readonly slug: string;
  readonly confidence: number;
  readonly source: string;
  /** What the provider reported for the calls THIS classification made (the category vectors only when it was the first to need them). */
  readonly tokens: number;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`cosineSimilarity: vector length ${String(a.length)} vs ${String(b.length)}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The winner's share of a softmax over `cosines`. Null for no categories: there is nothing to be confident about. */
export function categoryConfidence(cosines: readonly number[]): number | null {
  if (cosines.length === 0) return null;
  const top = Math.max(...cosines);
  // Subtracting the maximum first keeps exp() from overflowing; it does not change the shares.
  const weights = cosines.map((c) => Math.exp((c - top) / CATEGORY_SOFTMAX_TEMPERATURE));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return 1 / total;
}

export interface ClassificationTextParts {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly hero?: string | undefined;
  readonly nav?: readonly string[] | undefined;
  readonly products?: readonly string[] | undefined;
}

/** The site text to classify, in the order the story names it. Absent parts are skipped, so an empty page gives an empty string. */
export function buildClassificationText(parts: ClassificationTextParts): string {
  const pieces = [
    parts.title,
    parts.description,
    parts.hero,
    parts.nav === undefined || parts.nav.length === 0 ? undefined : parts.nav.join(", "),
    parts.products === undefined || parts.products.length === 0 ? undefined : parts.products.join(", "),
  ]
    .map((piece) => piece?.replace(/\s+/g, " ").trim())
    .filter((piece): piece is string => piece !== undefined && piece !== "");
  // Joined with a full stop, unless the piece already ends in one, so "Done." does not become "Done..".
  const joined = pieces.reduce((text, piece) => (text === "" ? piece : /[.!?]$/.test(text) ? `${text} ${piece}` : `${text}. ${piece}`), "");
  return joined.slice(0, MAX_CLASSIFICATION_TEXT_CHARS);
}

const categoryText = (c: CategoryDescriptor): string => `${c.name}. ${c.description}`;

const vectorCache = new Map<string, Promise<{ vectors: number[][]; tokens: number }>>();

function cacheKey(model: string, categories: readonly CategoryDescriptor[]): string {
  return `${model}\n${createHash("sha256").update(categories.map((c) => `${c.slug}\t${categoryText(c)}`).join("\n")).digest("hex")}`;
}

async function embedAll(embedder: TextEmbedder, texts: readonly string[]): Promise<{ vectors: number[][]; tokens: number }> {
  const vectors: number[][] = [];
  let tokens = 0;
  for (let start = 0; start < texts.length; start += PROVIDER_BATCH) {
    const batch = texts.slice(start, start + PROVIDER_BATCH);
    const result = await embedder.embed(batch);
    // Fewer vectors than texts is an error, never a partial classification: a half-embedded taxonomy would silently never match.
    if (result.vectors.length !== batch.length) throw new Error(`embedding provider returned ${String(result.vectors.length)} vectors for ${String(batch.length)} texts`);
    for (const v of result.vectors) vectors.push([...v]);
    tokens += result.totalTokens;
  }
  return { vectors, tokens };
}

/**
 * Null when there is nothing to classify (no page text, or no taxonomy) and no provider call is spent. Throws when the provider fails:
 * the caller decides what a missing category means (discovery treats it as "no category proposed", not as a failed discovery).
 */
export async function classifyCategory(
  siteText: string,
  categories: readonly CategoryDescriptor[],
  embedder: TextEmbedder,
  /** Filled with what the provider reported for the calls this made, whether or not a category matched (the caller settles its budget with it). */
  spend?: { tokens: number },
): Promise<CategoryClassification | null> {
  const text = siteText.trim();
  if (text === "" || categories.length === 0) return null;

  const key = cacheKey(embedder.model, categories);
  let entry = vectorCache.get(key);
  let startedEmbedding = false;
  if (entry === undefined) {
    startedEmbedding = true;
    entry = embedAll(embedder, categories.map(categoryText));
    vectorCache.set(key, entry);
    // A failure must not be remembered: the next discovery tries again.
    entry.catch(() => vectorCache.delete(key));
  }
  const categoryVectors = await entry;
  const spentOnCategories = startedEmbedding ? categoryVectors.tokens : 0;
  if (spend !== undefined) spend.tokens += spentOnCategories;

  const site = await embedAll(embedder, [text.slice(0, MAX_CLASSIFICATION_TEXT_CHARS)]);
  if (spend !== undefined) spend.tokens += site.tokens;
  const siteVector = site.vectors[0]!;
  const cosines = categoryVectors.vectors.map((v) => cosineSimilarity(siteVector, v));
  const confidence = categoryConfidence(cosines);
  if (confidence === null) return null;

  let best = 0;
  for (let i = 1; i < cosines.length; i++) if (cosines[i]! > cosines[best]!) best = i;
  return { slug: categories[best]!.slug, confidence, source: CATEGORY_CLASSIFICATION_SOURCE, tokens: spentOnCategories + site.tokens };
}
