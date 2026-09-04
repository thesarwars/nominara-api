// STORY-043 — pulling brand facts out of a fetched page.
//
// SCOPE, AND WHY IT IS THIS SHAPE. product-spec.md §2.1 lists eight things
// discovery derives. Three of them cannot be built yet and are NOT
// half-implemented here:
//
//   Business category — "classification against a 180-category taxonomy".
//     That taxonomy is named once in the whole specification and exists
//     nowhere: not a table, not a seed, not a data file, and no story owns
//     it. Guessing a category is worse than not proposing one, because
//     `category_slug` is the benchmark join key and every category-relative
//     comparison would then be silently wrong.
//   Competitors — "the site's own comparison/alternatives pages, then
//     category peers". That needs multi-page selection, which is STORY-049.
//   Prompts — the free allowance comes from the archetype grammar, which is
//     STORY-045 and is explicitly DOWNSTREAM of this story.
//
// What IS here is everything derivable from one fetch of the root document:
// JSON-LD, Open Graph, <title>, meta description, and the lang attribute.
//
// NO HTML PARSER. Adding one is a dependency decision, and it is not needed
// for these five: JSON-LD is JSON once the script tag is located, and the
// rest are single well-defined tags in <head>. Deeper extraction — hero copy,
// nav structure, logo alt text — genuinely does need a parser, and belongs
// with STORY-049's crawl pipeline, which will need one for its own reasons.
// Regex over a whole document to find arbitrary content would be the wrong
// tool; regex to find <head>'s meta tags is the right size of hammer.

/** Confidence attached to each source, highest first. §4.5 renders these to the customer. */
export const CONFIDENCE = {
  /** Publisher-declared structured data. The strongest signal a page carries. */
  jsonLd: 0.96,
  /** Publisher-declared, but for social preview rather than machine consumption. */
  openGraph: 0.88,
  /** Present on essentially every page, and frequently decorated with taglines. */
  title: 0.72,
  metaDescription: 0.8,
  /** Declared by the document, occasionally wrong, never absent in practice. */
  htmlLang: 0.85,
  /** Derived by us from the domain rather than stated by the site. */
  derived: 0.7,
} as const;

export interface Extracted {
  readonly brandName?: { value: string; confidence: number; source: string };
  readonly description?: { value: string; confidence: number; source: string };
  readonly products?: { value: string[]; confidence: number; source: string };
  readonly locale?: { value: string; confidence: number; source: string };
}

const JSON_LD_RE = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const HTML_LANG_RE = /<html[^>]*\slang\s*=\s*["']([^"']+)["']/i;

/** `<meta property="og:title" content="...">` in either attribute order. */
function metaContent(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*\\scontent\\s*=\\s*["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*\\s(?:property|name)\\s*=\\s*["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1]).trim() || undefined;
  }
  return undefined;
}

/** The five named entities that actually appear in title and meta text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Every JSON-LD block that parses. A malformed one is skipped, never fatal. */
export function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  JSON_LD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_LD_RE.exec(html))) {
    try {
      const parsed: unknown = JSON.parse(match[1]!);
      // A publisher may ship an array, or a @graph wrapper. Both are flattened
      // so a caller looking for an Organization does not have to know which.
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else if (isRecord(parsed) && Array.isArray(parsed["@graph"])) blocks.push(...parsed["@graph"]);
      else blocks.push(parsed);
    } catch {
      // A single broken block must not lose the others, and must certainly not
      // fail the whole discovery — a page we do not control is allowed to be
      // malformed.
    }
  }
  return blocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function typeOf(block: unknown): string[] {
  if (!isRecord(block)) return [];
  const raw = block["@type"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  return [];
}

function stringField(block: unknown, key: string): string | undefined {
  if (!isRecord(block)) return undefined;
  const value = block[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Everything one root document yields. Absent fields are simply not present. */
export function extractFromHtml(html: string): Extracted {
  const blocks = jsonLdBlocks(html);
  const organization = blocks.find((b) => typeOf(b).some((t) => t === "Organization" || t === "Corporation"));
  const products = blocks.filter((b) => typeOf(b).includes("Product"));

  const out: Record<string, { value: unknown; confidence: number; source: string }> = {};

  const ldName = stringField(organization, "name");
  const ogTitle = metaContent(html, "og:site_name") ?? metaContent(html, "og:title");
  const titleMatch = TITLE_RE.exec(html);
  const title = titleMatch?.[1] ? decodeEntities(titleMatch[1]).trim() : undefined;

  if (ldName) out.brandName = { value: ldName, confidence: CONFIDENCE.jsonLd, source: "Organization schema" };
  else if (ogTitle) out.brandName = { value: ogTitle, confidence: CONFIDENCE.openGraph, source: "Open Graph" };
  else if (title) out.brandName = { value: titleLeader(title), confidence: CONFIDENCE.title, source: "<title>" };

  const ldDescription = stringField(organization, "description");
  const metaDescription = metaContent(html, "description") ?? metaContent(html, "og:description");
  if (ldDescription) {
    out.description = { value: ldDescription, confidence: CONFIDENCE.jsonLd, source: "Organization schema" };
  } else if (metaDescription) {
    out.description = { value: metaDescription, confidence: CONFIDENCE.metaDescription, source: "meta description" };
  }

  const productNames = products.map((p) => stringField(p, "name")).filter((n): n is string => n !== undefined);
  if (productNames.length > 0) {
    out.products = { value: productNames, confidence: CONFIDENCE.jsonLd, source: "Product schema" };
  }

  const lang = HTML_LANG_RE.exec(html)?.[1];
  if (lang) out.locale = { value: normalizeLocale(lang), confidence: CONFIDENCE.htmlLang, source: "html[lang]" };

  return out as Extracted;
}

/**
 * The brand half of a decorated title.
 *
 * "HubSpot | Customer Platform" is overwhelmingly "brand SEPARATOR tagline",
 * and taking the whole string would name the project after its marketing copy.
 * Only the common separators, and only when the leading part is non-empty —
 * a title that is ALL tagline is left alone rather than truncated to nothing.
 */
export function titleLeader(title: string): string {
  const parts = title.split(/\s+[|–—-]\s+/);
  const leader = parts[0]?.trim();
  return leader !== undefined && leader !== "" ? leader : title.trim();
}

/** `EN-us` and `en_US` both mean `en-US`. */
export function normalizeLocale(raw: string): string {
  const [language, region] = raw.replace("_", "-").split("-");
  if (!language) return raw;
  return region ? `${language.toLowerCase()}-${region.toUpperCase()}` : language.toLowerCase();
}
