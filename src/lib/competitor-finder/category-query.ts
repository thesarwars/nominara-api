// STORY-081 - the category query, derived from the fetched page (no model call, no network).
//
// BUILDER READING: the spec says "derives the category query from the fetched page" and does not say how. This takes the page's meta description, else its
// <h1>, else its <title>, removes the page's own brand (so the query asks about a category, not about the page's company), and asks the engine who it names.
// A page with nothing usable derives no query: the run fails and is refunded rather than sending the engine a guess.

const MAX_PHRASE_CHARS = 140;
const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };

function decode(value: string): string {
  return value.replace(/&(?:amp|quot|#39|apos|lt|gt|nbsp);/gu, (e) => ENTITIES[e] ?? e);
}

function firstMatch(html: string, pattern: RegExp): string | null {
  const m = pattern.exec(html);
  if (m?.[1] === undefined) return null;
  const text = decode(m[1].replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim();
  return text === "" ? null : text;
}

function metaDescription(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    if (!/\b(?:name|property)\s*=\s*["'](?:description|og:description)["']/iu.test(tag)) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/iu.exec(tag);
    const value = (content?.[1] ?? content?.[2] ?? "").replace(/\s+/gu, " ").trim();
    if (value !== "") return decode(value);
  }
  return null;
}

/** `acme-invoicing.example` -> the words a page might use for its own name: `acme`, `invoicing`, `acme invoicing`. */
function brandWords(host: string): string[] {
  const label = host.replace(/^www\./u, "").split(".")[0] ?? "";
  const words = label.split(/[-_]/u).filter((w) => w.length >= 3);
  return [...new Set([label.replace(/[-_]/gu, " "), ...words])].filter((w) => w !== "");
}

/** The page's own names, lower-cased: its host's words and the first segment of its title. The page itself is never one of "its competitors". */
export function ownBrandNames(html: string, host: string): string[] {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/iu);
  const titleBrand = title?.split(/\s[|\u2013\u2014-]\s|:/u)[0]?.trim();
  return [...new Set([...brandWords(host), ...(titleBrand === undefined || titleBrand === "" ? [] : [titleBrand])].map((n) => n.toLowerCase()))];
}

export function deriveCategoryQuery(html: string, host: string): string | null {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/iu);
  const raw = metaDescription(html) ?? firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/iu) ?? title;
  if (raw === null) return null;
  // The brand is whatever the title's first segment names ("Acme Invoicing | Invoices for freelancers") plus the host's own words.
  const titleBrand = title?.split(/\s[|–—-]\s|:/u)[0]?.trim();
  const brands = [...brandWords(host), ...(titleBrand === undefined || titleBrand === "" ? [] : [titleBrand])].sort((a, b) => b.length - a.length);
  let phrase = raw;
  for (const brand of brands) phrase = phrase.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"), " ");
  phrase = phrase.replace(/\s+/gu, " ").replace(/^[\s,.:;|–—-]+/u, "").trim();
  const sentence = phrase.split(/(?<=[.!?])\s/u)[0] ?? phrase;
  const cut = sentence.slice(0, MAX_PHRASE_CHARS).replace(/[\s,.:;|–—-]+$/u, "");
  if (cut.replace(/[^\p{L}\p{N}]/gu, "").length < 4) return null;
  return `Who are the main companies or products an AI assistant would name for this category: ${cut}? Name each one.`;
}
