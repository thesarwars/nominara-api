import type { ProposedCompetitor } from "../../../contracts/projects/index.js";
import { parse } from "tldts";
import { toRegistrableDomain } from "../net/registrable-domain.js";
import { extractComparisonPageSignals, type ComparisonLink } from "./html-signals.js";

// STORY-043 AC11 — competitors proposed, EACH WITH A BASIS (api-specification.md §4.5, product-spec.md §2.1: "the site's own
// comparison/alternatives pages -> category peers -> entities co-occurring in the first capture run").
//
// ONLY THE FIRST BASIS IS BUILT, and only as far as the ROOT DOCUMENT shows it: a link the site itself publishes to a comparison
// or alternatives page, read by its visible text. The other two are not faked:
//   category peers          needs the 180-category taxonomy (no table, seed or story owns it), so there is no "category" to be a peer in;
//   first-capture entities  needs a capture, which cannot exist when discovery runs.
// STORY-190 (owner decision 13) opens up to MAX_COMPARISON_PAGES same-site pages those links point to, through the guarded fetcher in
// the run phase (discover.ts). Public pages only: an unverified domain is limited to its public surface (aux-and-geo-analysis.md §1).
// Names on those pages come from their structure (title and headings that pair "X vs Y", header cells of a table that has the brand's
// own column), never from a URL slug, and carry LOWER confidence than the same rival named in a home-page link (decision 99g).
//
// NAMES COME FROM LINK TEXT ONLY. A slug ("hubspot-vs-salesforce") is not read: title-casing a slug yields "Hubspot", a name the
// parser would then match on. Generic text ("Compare") names nobody, so it proposes nobody.
//
// `root_domain` is left absent: it is optional on the wire, and guessing "salesforce.com" from "Salesforce" is exactly the
// invented value this story exists not to ship.

export const MAX_PROPOSED_COMPETITORS = 5;
export const COMPETITOR_BASIS = "own comparison page";

/** Explicit "Brand vs Other": the site itself pairs the two. */
const CONFIDENCE_VS = 0.8;
/** "Other alternatives": the site targets Other's users, which implies a rival but does not say so. */
const CONFIDENCE_ALTERNATIVES = 0.7;

/** STORY-190 - a rival named only on a comparison page: below every home-page link's confidence (decision 99g). */
const CONFIDENCE_PAGE_VS = 0.65;
const CONFIDENCE_PAGE_ALTERNATIVES = 0.55;
const CONFIDENCE_PAGE_TABLE = 0.6;

export const MAX_COMPARISON_PAGES = 3;

const PLACEHOLDERS = new Set([
  "feature", "features", "price", "prices", "pricing", "plan", "plans", "cost", "support", "integrations", "rating", "ratings", "overview",
  "free", "paid", "yes", "no", "best for", "our product", "your product", "product", "products", "category", "criteria", "comparison",
  "competitor", "competitors", "competition", "other", "others", "us", "them", "it", "the rest", "alternatives", "alternative",
  "the competition", "everyone", "anyone", "others like us",
]);

// WHOLE call-to-action phrases only: what is left of "See alternatives" or "View all alternatives" once "alternatives" is cut. A real rival
// that starts with one of these words ("Discover Financial", "Checkout.com", "All Saints") is a name, not a phrase.
const CALL_TO_ACTION_RE = /^(?:(?:see|view|browse|explore|find|read|learn|check out|discover)(?:\s+(?:all|more|our|the|other|these|top|best))*|all|our|more|your)$/i;

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const tokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== "");

/** A stored placeholder name is the domain ("hubspot.com"): the brand is its first label, never the whole string run together. */
const brandForm = (brand: string): string => (/^[^\s.]+(?:\.[^\s.]+)+$/.test(brand.trim()) ? brand.trim().split(".")[0]! : brand);

/** Whole tokens, in order, somewhere inside `haystack`. Never a substring: "force" is not inside "salesforce", "spot" not inside "hubspot". */
function containsTokens(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((token, j) => haystack[i + j] === token)) return true;
  }
  return false;
}

/**
 * Is `name` the brand, or the brand plus a descriptor ("HubSpot CRM")? Compared by whole name or whole tokens. It used to be two-way
 * substring containment, which dropped real rivals ("Salesforce" contains the stem "force") and treated "Hub" as "hubspot.com".
 */
function isBrand(name: string, brands: readonly string[]): boolean {
  const n = norm(name);
  if (n === "") return false;
  const nameTokens = tokens(name);
  return brands.some((b) => {
    const form = brandForm(b);
    const nb = norm(form);
    return nb.length >= 3 && (n === nb || containsTokens(nameTokens, tokens(form)));
  });
}

function cleanName(raw: string): string | null {
  const name = raw
    .replace(/\b(?:comparison|compared|compare)\b.*$/i, "")
    .replace(/^(?:best|top|the)\s+/i, "")
    .replace(/[?!.:,;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 2 || name.length > 50) return null;
  if (!/\p{L}/u.test(name)) return null;
  if (name.split(" ").length > 5) return null;
  if (PLACEHOLDERS.has(name.toLowerCase())) return null;
  // A call to action is not a name: "See alternatives" and "View all alternatives" name nobody (STORY-190 description).
  if (CALL_TO_ACTION_RE.test(name)) return null;
  return name;
}

interface Candidate {
  readonly name: string;
  readonly confidence: number;
  /** Set only for a rival read from a comparison page: that page's URL. */
  readonly basisUrl?: string;
}

function fromText(text: string, brands: readonly string[]): Candidate | null {
  const vs = /^(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i.exec(text);
  if (vs !== null) {
    const [a, b] = [vs[1]!, vs[2]!];
    const aBrand = isBrand(a, brands);
    const bBrand = isBrand(b, brands);
    // Exactly one side must be the brand. Neither is a comparison the site is not making about itself; both is the brand
    // compared with itself.
    if (aBrand === bBrand) return null;
    const name = cleanName(aBrand ? b : a);
    return name === null ? null : { name, confidence: CONFIDENCE_VS };
  }

  const alt = /^(?:alternatives?\s+to\s+(.+)|(.+?)\s+alternatives?)$/i.exec(text);
  if (alt !== null) {
    const name = cleanName(alt[1] ?? alt[2]!);
    // "HubSpot alternatives" is a page ABOUT the brand, so it names nobody else.
    return name === null || isBrand(name, brands) ? null : { name, confidence: CONFIDENCE_ALTERNATIVES };
  }
  return null;
}

/** The path words that mark a comparison page, as whole segments or hyphen-separated words of the path. */
const PATH_WORD_RE = /(?:^|[/_-])(?:vs|versus|alternatives?|compare|comparison)(?:$|[/_-])/i;
const TEXT_WORD_RE = /(?:^|[\s/_-])(?:vs\.?|versus|alternatives?|compare|comparison)(?:$|[\s/_-])/i;

export interface ComparisonPageSelection {
  /** Absolute URLs, at most MAX_COMPARISON_PAGES, in home-page order, same registrable domain only. */
  readonly urls: string[];
  /** Comparison-looking links that point off the registrable domain (or could not be resolved): never followed. */
  readonly offSite: number;
}

/**
 * Which of the home page's links are comparison pages worth opening (decision 99g: a path word OR the link text). Same registrable
 * domain only (AC1): an off-site link is counted and dropped, never followed.
 */
export function selectComparisonPages(links: readonly ComparisonLink[], rootUrl: string, rootDomain: string): ComparisonPageSelection {
  const urls: string[] = [];
  let offSite = 0;
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.href, rootUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (!PATH_WORD_RE.test(url.pathname) && !TEXT_WORD_RE.test(link.text)) continue;
    if (!isSameSite(url.toString(), rootUrl, rootDomain)) {
      offSite += 1;
      continue;
    }
    url.hash = "";
    const href = url.toString();
    if (!urls.includes(href) && urls.length < MAX_COMPARISON_PAGES) urls.push(href);
  }
  return { urls, offSite };
}

/**
 * True when `url` is on the project's own site: the registrable domain `rootDomain` AND, on a shared host (github.io, vercel.app,
 * myshopify.com: private suffixes in the public suffix list), the same tenant of it. `acme.github.io` never follows `other.github.io`.
 * An unparsable host is not on the site.
 */
export function isSameSite(url: string, rootUrl: string, rootDomain: string): boolean {
  try {
    if (toRegistrableDomain(url) !== rootDomain.toLowerCase()) return false;
    const mine = parse(rootUrl, { allowPrivateDomains: true }).domain;
    const theirs = parse(url, { allowPrivateDomains: true }).domain;
    return mine !== null && mine !== undefined && mine === theirs;
  } catch {
    return false;
  }
}

function fromPage(html: string, brands: readonly string[], url: string): Candidate[] {
  const signals = extractComparisonPageSignals(html);
  const out: Candidate[] = [];
  for (const heading of signals.headings) {
    const c = fromText(heading, brands);
    if (c === null) continue;
    out.push({ name: c.name, confidence: c.confidence === CONFIDENCE_VS ? CONFIDENCE_PAGE_VS : CONFIDENCE_PAGE_ALTERNATIVES, basisUrl: url });
  }
  for (const headers of signals.tableHeaders) {
    // A table is a comparison the site makes about ITSELF only when one of its columns is the brand.
    if (!headers.some((h) => isBrand(h, brands))) continue;
    for (const header of headers) {
      if (isBrand(header, brands)) continue;
      const name = cleanName(header);
      if (name !== null) out.push({ name, confidence: CONFIDENCE_PAGE_TABLE, basisUrl: url });
    }
  }
  return out;
}

export interface ProposeCompetitorsInput {
  /** Every name the brand goes by: the discovered or supplied name, the domain stem, known aliases. */
  readonly brandNames: readonly string[];
  readonly links: readonly ComparisonLink[];
  /** STORY-190 - comparison pages the run phase fetched: their final URL and HTML. */
  readonly pages?: readonly { readonly url: string; readonly html: string }[];
}

export function proposeCompetitors(input: ProposeCompetitorsInput): ProposedCompetitor[] {
  const best = new Map<string, { candidate: Candidate; order: number }>();
  const consider = (candidate: Candidate | null, order: number): void => {
    if (candidate === null || isBrand(candidate.name, input.brandNames)) return;
    const key = norm(candidate.name);
    const held = best.get(key);
    if (held === undefined || candidate.confidence > held.candidate.confidence) best.set(key, { candidate, order: held?.order ?? order });
  };
  input.links.forEach((link, order) => consider(fromText(link.text.trim(), input.brandNames), order));
  // Page rivals follow every home-page link in order, and sit below them in confidence, so the home-page links are taken first (AC5).
  let order = input.links.length;
  for (const page of input.pages ?? []) {
    for (const candidate of fromPage(page.html, input.brandNames, page.url)) consider(candidate, order++);
  }

  return [...best.values()]
    .sort((a, b) => b.candidate.confidence - a.candidate.confidence || a.order - b.order)
    .slice(0, MAX_PROPOSED_COMPETITORS)
    .map(({ candidate }) => ({
      name: candidate.name,
      confidence: candidate.confidence,
      basis: COMPETITOR_BASIS,
      ...(candidate.basisUrl === undefined ? {} : { basis_url: candidate.basisUrl }),
    }));
}
