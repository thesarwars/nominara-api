// STORY-043 — pulling brand facts out of a fetched page.
//
// SCOPE. Business category is not derived here: the taxonomy and the classifier are STORY-189 (src/lib/categories/classify.ts), fed the
// text this file and html-signals.ts read. `category_slug` is the benchmark join key, so a guessed category would make every
// category-relative comparison silently wrong. Competitors are proposed in competitors.ts and the free prompt allowance is
// generated in free-prompts.ts.
//
// What IS here is everything derivable from one fetch of the root document:
// JSON-LD, Open Graph, <title>, meta description, and the lang attribute.
//
// <head> tags are read here with single regexes (the right size of hammer). Deeper extraction — hero copy, nav structure, logo alt
// text, comparison links — needs a parser and lives in html-signals.ts (parse5, already a dependency since STORY-050).

/**
 * Confidence attached to each source, highest first. §4.5 renders these to the
 * customer, and anything under LOW_CONFIDENCE_THRESHOLD (0.60) is flagged for
 * confirmation rather than quietly applied.
 *
 * THE SPLIT AT 0.60 IS THE POINT, and these numbers were originally all above
 * it — every one of the six, so `low_confidence_fields` was structurally always
 * empty and FR-ONB-02b's confirm affordance was unreachable dead code. The
 * threshold was not wrong; the confidences were. The line to hold is:
 *
 *   ABOVE — the site TOLD us. A publisher who writes `Organization.name` or
 *   `og:site_name` is making a machine-readable assertion about themselves,
 *   and second-guessing it would flag almost every field on a well-marked-up
 *   site, which trains the customer to click through the confirmations
 *   without reading them.
 *
 *   BELOW — we INFERRED it. A title split on a separator, or a brand name
 *   guessed from a domain label, is our reading of something that was not
 *   written for us. It is often right and cannot be trusted to be, which is
 *   exactly the condition "flagged, not applied" exists for.
 */
export const CONFIDENCE = {
  /** Publisher-declared structured data. The strongest signal a page carries. */
  jsonLd: 0.96,
  /** `og:site_name` — publisher-declared, and specifically the name of the site. */
  openGraph: 0.88,
  /** Declared by the document, occasionally wrong, never absent in practice. */
  htmlLang: 0.85,
  /** Publisher-written prose about themselves, aimed at search rather than at us. */
  metaDescription: 0.8,
  /**
   * A page title, ours only after guessing where the brand ends.
   *
   * `titleLeader` splits on the first separator, which reads "HubSpot |
   * Customer Platform" correctly and "The best CRM software - HubSpot"
   * exactly backwards. That failure is silent and produces a project named
   * after a marketing sentence, so it belongs below the line.
   */
  pageTitle: 0.55,
  /**
   * Inferred by us from the domain, with nothing from the page behind it.
   *
   * `hubspot.com` -> "Hubspot" is a guess with the wrong capitalisation more
   * often than not, and the negative aliases proposed from it can SUPPRESS
   * real mentions — the one discovery error that destroys data rather than
   * merely being wrong. The lowest tier, and the most important one to flag.
   */
  derived: 0.45,
  /** A brand name the page title (or og:title) gave AND the logo's alt text independently repeats. Two readings agreeing. */
  corroborated: 0.7,
  /** The logo's alt text with nothing else to check it against: a guess at the name, below the line. */
  logoAlt: 0.5,
  /** Hero headline + lede standing in for a description the page never declared. Marketing copy, not a statement of what it is. */
  heroCopy: 0.4,
  /** Names under a Products/Solutions menu. Navigation labels are not always products. */
  navStructure: 0.5,
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
  // `og:site_name` and `og:title` are NOT the same signal and no longer share a
  // confidence. site_name is the publisher naming their site; og:title is the
  // page's title, decorated with a tagline exactly as often as <title> is — so
  // it earns <title>'s confidence, and goes through the same titleLeader split
  // rather than being stored whole.
  const ogSiteName = metaContent(html, "og:site_name");
  const ogTitle = metaContent(html, "og:title");
  const titleMatch = TITLE_RE.exec(html);
  const title = titleMatch?.[1] ? decodeEntities(titleMatch[1]).trim() : undefined;

  if (ldName) out.brandName = { value: ldName, confidence: CONFIDENCE.jsonLd, source: "Organization schema" };
  else if (ogSiteName) out.brandName = { value: ogSiteName, confidence: CONFIDENCE.openGraph, source: "og:site_name" };
  else if (ogTitle) out.brandName = { value: titleLeader(ogTitle), confidence: CONFIDENCE.pageTitle, source: "og:title" };
  else if (title) out.brandName = { value: titleLeader(title), confidence: CONFIDENCE.pageTitle, source: "<title>" };

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

/** The page's own title, undecorated and untruncated: `og:title`, else `<title>`. Context for classification, not a brand name (STORY-189). */
export function extractPageTitle(html: string): string | undefined {
  const og = metaContent(html, "og:title");
  if (og) return og;
  const raw = TITLE_RE.exec(html)?.[1];
  const title = raw ? decodeEntities(raw).trim() : "";
  return title === "" ? undefined : title;
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
