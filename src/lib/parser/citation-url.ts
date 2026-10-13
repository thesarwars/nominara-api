import { createHash } from "node:crypto";
import { toRegistrableDomain, UnparsableHostError } from "../net/registrable-domain.js";

// STORY-037 — normalising and classifying a citation's URL.
//
// `tracking-engine.md` Stage 3, steps 4 to 6.

/**
 * `#:~:text=` — a Text Fragment directive.
 *
 * THE HIGHEST-VALUE LINE IN THIS STORY, per its own technical notes: "A
 * citation carrying one names the exact passage the engine quoted, which the
 * alignment centroid can use directly without fetching the page at all. That
 * both improves fidelity and routes around blocked and paywalled sources —
 * the single biggest limitation of the corpus."
 *
 * So the fragment is dropped, EXCEPT this one. A blanket `url.hash = ""` is
 * the obvious normalisation and would silently throw away the only part of a
 * citation that says which sentence mattered.
 */
const TEXT_DIRECTIVE = "#:~:text=";

/**
 * The fixed tracking-parameter list.
 *
 * DELIBERATELY CONSERVATIVE. Every parameter removed here changes what two
 * URLs are considered "the same source", and over-stripping merges pages that
 * are genuinely different — `?ref=` and `?source=` are tracking on some sites
 * and routing on others, so neither is listed. Under-stripping only splits a
 * source's influence across duplicate rows, which is visible and fixable;
 * over-stripping silently attributes one page's citations to another.
 *
 * `utm_*` is matched by prefix rather than enumerated: the convention is open
 * (`utm_id`, `utm_source_platform`, `utm_creative_format`) and a fixed list of
 * the common five goes stale.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "gclid",
  "gclsrc",
  "dclid",
  "fbclid",
  "msclkid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "vero_id",
  "yclid",
  "wickedid",
]);

const TRACKING_PREFIXES: readonly string[] = ["utm_"];

export interface NormalizedUrl {
  /** Exactly as it appeared, before any resolution or normalisation. */
  readonly raw: string;
  readonly normalized: string;
  /** Registrable domain — `blog.example.co.uk` → `example.co.uk`. */
  readonly domain: string;
  /** Host as written, minus `www.`, which owned-domain matching needs. */
  readonly host: string;
  readonly path: string | null;
  /** The text directive, WITHOUT its `#:~:text=` prefix, or null. */
  readonly textFragment: string | null;
  /** sha256 of the normalised URL — `citation_facts.url_hash`. */
  readonly urlHash: Buffer;
}

export class UnparsableCitationError extends Error {
  constructor(raw: string) {
    super(`citation URL cannot be parsed: ${raw}`);
    this.name = "UnparsableCitationError";
  }
}

/**
 * Stage 3 step 4, in order.
 *
 * "lowercase scheme and host, strip `www.`, strip a fixed tracking-parameter
 * list, drop the trailing slash, and drop the fragment **unless** it is a
 * text-directive anchor."
 */
export function normalizeCitationUrl(raw: string): NormalizedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnparsableCitationError(raw);
  }

  // `URL` already lower-cases scheme and host on parse; done explicitly
  // anyway so the step is visible where the reference lists it, and so a
  // future change to the parser cannot silently drop it.
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (url.hostname.startsWith("www.")) url.hostname = url.hostname.slice(4);

  for (const key of [...url.searchParams.keys()]) {
    const lowered = key.toLowerCase();
    if (TRACKING_PARAMS.has(lowered) || TRACKING_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
      url.searchParams.delete(key);
    }
  }

  // The trailing slash goes, but the ROOT's does not: "https://example.com/"
  // and "https://example.com" are the same page, and `new URL` writes the
  // slash back on the root regardless, so stripping it here would produce a
  // string that does not round-trip.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  const textFragment = url.hash.startsWith(TEXT_DIRECTIVE) ? url.hash.slice(TEXT_DIRECTIVE.length) : null;
  url.hash = textFragment === null ? "" : `${TEXT_DIRECTIVE}${textFragment}`;

  const normalized = url.toString();
  return {
    raw,
    normalized,
    domain: registrableOrHost(url.hostname),
    host: url.hostname,
    path: url.pathname === "/" ? null : url.pathname,
    textFragment,
    urlHash: createHash("sha256").update(normalized, "utf8").digest(),
  };
}

/**
 * The registrable domain, falling back to the host.
 *
 * An IP literal and an unlisted TLD have no registrable domain, and
 * `citation_facts.domain` is NOT NULL. The host is the honest fallback — it
 * still groups citations from the same origin — and throwing here would drop
 * an otherwise perfectly good citation over a suffix-list gap.
 */
function registrableOrHost(host: string): string {
  try {
    return toRegistrableDomain(host);
  } catch (error) {
    if (error instanceof UnparsableHostError) return host;
    throw error;
  }
}

/**
 * AC6 — owned covers the root domain and the additional owned domains,
 * SUBDOMAINS INCLUDED.
 *
 * The story flags this as "easy to get wrong and expensive: it is a component
 * of the headline score, so a documentation subdomain classified as foreign
 * directly depresses the number." `docs.example.com` cited by an engine is
 * the brand's own content and must count as owned.
 *
 * SUFFIX MATCH ON A DOT BOUNDARY, never a bare `endsWith`. `notexample.com`
 * ends with `example.com` and belongs to someone else; the dot is what makes
 * it a subdomain rather than a coincidence.
 */
export function isOwnedHost(host: string, rootDomain: string, ownedDomains: readonly string[]): boolean {
  const candidate = host.toLowerCase().replace(/^www\./u, "");
  return [rootDomain, ...ownedDomains]
    .map((domain) => domain.toLowerCase().replace(/^www\./u, ""))
    .filter((domain) => domain.length > 0)
    .some((domain) => candidate === domain || candidate.endsWith(`.${domain}`));
}

/** `citation_facts.source_class`'s CHECK, verbatim. */
export type SourceClass =
  | "community_forum"
  | "review_marketplace"
  | "encyclopedic"
  | "news_media"
  | "vendor_owned"
  | "developer_platform"
  | "social"
  | "blog"
  | "academic"
  | "other";

/**
 * The curated list — hosts whose class is a fact rather than a guess.
 *
 * Matched on the registrable domain, so `en.wikipedia.org` and
 * `de.wikipedia.org` are both encyclopedic without enumerating locales.
 */
const CURATED: ReadonlyMap<string, SourceClass> = new Map([
  ["reddit.com", "community_forum"],
  ["stackoverflow.com", "community_forum"],
  ["stackexchange.com", "community_forum"],
  ["quora.com", "community_forum"],
  ["news.ycombinator.com", "community_forum"],
  ["g2.com", "review_marketplace"],
  ["capterra.com", "review_marketplace"],
  ["trustradius.com", "review_marketplace"],
  ["getapp.com", "review_marketplace"],
  ["softwareadvice.com", "review_marketplace"],
  ["producthunt.com", "review_marketplace"],
  ["trustpilot.com", "review_marketplace"],
  ["wikipedia.org", "encyclopedic"],
  ["britannica.com", "encyclopedic"],
  ["wikidata.org", "encyclopedic"],
  ["github.com", "developer_platform"],
  ["gitlab.com", "developer_platform"],
  ["npmjs.com", "developer_platform"],
  ["hub.docker.com", "developer_platform"],
  ["x.com", "social"],
  ["twitter.com", "social"],
  ["linkedin.com", "social"],
  ["facebook.com", "social"],
  ["youtube.com", "social"],
  ["tiktok.com", "social"],
  ["medium.com", "blog"],
  ["substack.com", "blog"],
  ["dev.to", "blog"],
  ["nytimes.com", "news_media"],
  ["wsj.com", "news_media"],
  ["theguardian.com", "news_media"],
  ["reuters.com", "news_media"],
  ["bloomberg.com", "news_media"],
  ["techcrunch.com", "news_media"],
  ["forbes.com", "news_media"],
  ["arxiv.org", "academic"],
  ["jstor.org", "academic"],
  ["springer.com", "academic"],
  ["acm.org", "academic"],
]);

/** The heuristic fallback, applied only when the curated list has no answer. */
const HEURISTICS: readonly { readonly test: RegExp; readonly value: SourceClass }[] = [
  { test: /(^|\.)(edu|ac\.[a-z]{2})$/u, value: "academic" },
  { test: /^(blog|news)\./u, value: "blog" },
  { test: /(^|\.)(docs|developer|developers|api)\./u, value: "developer_platform" },
  { test: /(^|\.)(forum|forums|community|discuss)\./u, value: "community_forum" },
];

export interface ClassifyInput {
  readonly host: string;
  readonly domain: string;
  readonly isOwned: boolean;
  /** Registrable domains of the project's tracked competitors. */
  readonly competitorDomains: readonly string[];
}

export interface Classification {
  readonly isOwned: boolean;
  readonly isCompetitor: boolean;
  readonly sourceClass: SourceClass;
}

/**
 * AC7 — owned, competitor and source class.
 *
 * OWNED WINS OVER EVERY OTHER CLASS. A brand's own domain is `vendor_owned`
 * whatever the heuristics would say about it, and a competitor's domain is
 * `vendor_owned` too — the class describes what KIND of source it is, and the
 * `is_owned` / `is_competitor` booleans describe whose. Collapsing them would
 * make it impossible to ask "how many of my citations are from vendor sites"
 * without double-counting my own.
 */
export function classifyCitation(input: ClassifyInput): Classification {
  const isCompetitor =
    !input.isOwned &&
    input.competitorDomains.some((domain) => isOwnedHost(input.host, domain, []));

  if (input.isOwned || isCompetitor) {
    return { isOwned: input.isOwned, isCompetitor, sourceClass: "vendor_owned" };
  }

  const curated = CURATED.get(input.domain) ?? CURATED.get(input.host);
  if (curated !== undefined) return { isOwned: false, isCompetitor: false, sourceClass: curated };

  for (const heuristic of HEURISTICS) {
    if (heuristic.test.test(input.host) || heuristic.test.test(input.domain)) {
      return { isOwned: false, isCompetitor: false, sourceClass: heuristic.value };
    }
  }

  // `other`, NOT a guess. An unclassified source is a known unknown; guessing
  // "blog" for every unrecognised host would put a confident label on most of
  // the index and make the class column worthless.
  return { isOwned: false, isCompetitor: false, sourceClass: "other" };
}

/**
 * Stage 3 step 6 — `position_weight = 1/√slot_index`.
 *
 * ONE-BASED, and slot 0 is a caller error rather than a divide-by-zero. The
 * adapter contract already refuses `slot: 0` for this exact reason; this is
 * the second place that assumption is load-bearing, so it is stated rather
 * than inherited.
 */
export function positionWeight(slotIndex: number): number {
  if (!Number.isInteger(slotIndex) || slotIndex < 1) {
    throw new RangeError(`citation slot index must be a positive integer, got ${String(slotIndex)}`);
  }
  return 1 / Math.sqrt(slotIndex);
}

/**
 * NEW-C-4 — the class of a bare registrable domain, for the Source Citation
 * Index: the curated list first, then the heuristic fallback, then `other`.
 * Ownership is not known here; callers handle competitor/owned separately.
 */
export function classifyDomain(domain: string): SourceClass {
  return classifyCitation({ host: domain, domain, isOwned: false, competitorDomains: [] }).sourceClass;
}

/**
 * STORY-054 AC1 — where a domain's class came from. `curated` is read from the curated list; everything else
 * (a heuristic pattern match, or the `other` fallback) is `heuristic` and is queued for curation.
 */
export type ClassSource = "curated" | "heuristic";

export function domainClassSource(domain: string): ClassSource {
  return CURATED.has(domain) ? "curated" : "heuristic";
}
