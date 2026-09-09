import { GuardedFetchRefusal, guardedFetch } from "../net/guarded-fetch.js";
import {
  classifyCitation,
  isOwnedHost,
  normalizeCitationUrl,
  positionWeight,
  UnparsableCitationError,
  type SourceClass,
} from "./citation-url.js";

// STORY-037 — every citation slot, extracted, resolved, normalised,
// classified and weighted.
//
// `tracking-engine.md` Stage 3.
//
// NO CITATION IS INVENTED — AC2, and the constraint that shapes extraction.
// Every slot below comes from a substring of the response or from the
// adapter's own structured array. Nothing is inferred, completed, or
// guessed from context, because a fabricated citation is a claim that an
// engine cited a source it never mentioned — and it would be indistinguishable
// from a real one downstream.

/** A slot as it appeared, before anything was done to it. */
export interface ExtractedCitation {
  /** 1-based, in the order the response presented them. */
  readonly slotIndex: number;
  readonly rawUrl: string;
  /** Link text, where the source had any. */
  readonly anchorText: string | null;
  readonly title: string | null;
}

export interface ResolvedCitation {
  readonly slotIndex: number;
  readonly rawUrl: string;
  /** The normalised form of the RESOLVED url, or of the raw one when resolution failed. */
  readonly normalizedUrl: string;
  readonly urlHash: Buffer;
  readonly domain: string;
  readonly path: string | null;
  readonly anchorText: string | null;
  readonly title: string | null;
  readonly isOwned: boolean;
  readonly isCompetitor: boolean;
  readonly sourceClass: SourceClass;
  /** Null when the redirect could not be resolved — AC4's marker. */
  readonly httpStatus: number | null;
  readonly resolvedAt: string | null;
  readonly positionWeight: number;
  readonly textFragment: string | null;
  /**
   * AC4 — "excluded from citation share, counted as neither owned nor
   * foreign, so an unresolvable link can neither inflate nor deflate the
   * metric."
   *
   * A SEPARATE FLAG rather than an absence, because the row still exists and
   * every consumer has to opt out of it deliberately. Inferring it from
   * `httpStatus === null` would work today and stop working the first time a
   * resolved citation legitimately has no status.
   */
  readonly countsTowardShare: boolean;
}

/** Markdown links: `[text](url)`. The most common shape in engine output. */
const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gu;

/** Bare URLs, terminated before trailing sentence punctuation. */
const BARE_URL = /\bhttps?:\/\/[^\s)<>\]]*[^\s)<>\].,;:!?]/gu;

/** Footnote-style reference blocks: `[1]: https://…` or `[1] https://…`. */
const FOOTNOTE = /^\s*\[(\d+)\]:?\s+(https?:\/\/\S+)\s*$/gmu;

/**
 * AC1 — structured citations are PREFERRED where the adapter provides them.
 *
 * Not merged with the text-extracted ones, replaced by them. An adapter that
 * returns a structured array has told us authoritatively which slots the
 * engine reported and in which order; re-scanning the prose would add the
 * same URLs again under different slot numbers, and the union would overstate
 * every source's influence.
 */
export function extractCitations(
  text: string,
  structured?: readonly { readonly url: string; readonly title?: string; readonly slot: number }[],
): ExtractedCitation[] {
  if (structured !== undefined && structured.length > 0) {
    return [...structured]
      .sort((a, b) => a.slot - b.slot)
      .map((citation) => ({
        slotIndex: citation.slot,
        rawUrl: citation.url,
        anchorText: null,
        title: citation.title ?? null,
      }));
  }

  // FIRST OCCURRENCE WINS, and the slot order is the order of appearance —
  // which is what `1/√slot` is measuring. A URL written once as a markdown
  // link and again bare is one citation the engine made, not two.
  const seen = new Set<string>();
  const found: { offset: number; rawUrl: string; anchorText: string | null }[] = [];

  const add = (offset: number, rawUrl: string, anchorText: string | null): void => {
    if (seen.has(rawUrl)) return;
    seen.add(rawUrl);
    found.push({ offset, rawUrl, anchorText });
  };

  for (const match of text.matchAll(FOOTNOTE)) {
    if (match.index !== undefined) add(match.index, match[2]!, null);
  }
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    if (match.index !== undefined) add(match.index, match[2]!, match[1]!.trim() || null);
  }
  for (const match of text.matchAll(BARE_URL)) {
    if (match.index !== undefined) add(match.index, match[0], null);
  }

  return found
    .sort((a, b) => a.offset - b.offset)
    .map((citation, index) => ({
      slotIndex: index + 1,
      rawUrl: citation.rawUrl,
      anchorText: citation.anchorText,
      title: null,
    }));
}

export interface ResolveContext {
  readonly rootDomain: string;
  readonly ownedDomains: readonly string[];
  readonly competitorDomains: readonly string[];
  readonly now?: () => Date;
  /**
   * Injected so the resolution path is testable without a network, and so
   * scenario 10 — a citation URL resolving to an internal address — can be
   * exercised. Production passes nothing and gets `guardedFetch`.
   *
   * ALL FETCHING GOES THROUGH THE GUARDED FETCHER (AC11). A citation URL is
   * attacker-controlled in the most direct sense available: an engine can be
   * induced to cite anything, and following one to `169.254.169.254` would be
   * an SSRF with a very short exploit chain.
   */
  readonly fetch?: (url: string) => Promise<{ status: number; finalUrl: string }>;
}

/**
 * Resolve one citation: follow redirects, normalise, classify, weight.
 *
 * BOTH URLS ARE RETAINED (AC3). `rawUrl` is what the engine wrote and is what
 * a customer sees quoted back; `normalizedUrl` is what the index groups by.
 * Keeping only the resolved one loses the ability to show what was actually
 * in the answer; keeping only the raw one makes every wrapper URL its own
 * source.
 */
export async function resolveCitation(
  citation: ExtractedCitation,
  context: ResolveContext,
): Promise<ResolvedCitation> {
  const fetcher = context.fetch ?? defaultFetch;
  const now = context.now ?? (() => new Date());

  let finalUrl = citation.rawUrl;
  let httpStatus: number | null = null;
  let resolvedAt: string | null = null;

  try {
    const response = await fetcher(citation.rawUrl);
    finalUrl = response.finalUrl;
    httpStatus = response.status;
    resolvedAt = now().toISOString();
  } catch {
    // AC4 — "An unresolved redirect keeps the raw URL with `http_status =
    // null`", and the story is explicit about why it is excluded rather than
    // guessed at: "Counting them as foreign penalises the brand for a
    // vendor's redirect scheme; counting them as owned would be worse."
    //
    // Every failure lands here, including a `GuardedFetchRefusal` — a URL the
    // guard refused is unresolvable for our purposes, and it must not be
    // rethrown into the parse: one hostile citation would otherwise fail the
    // whole capture.
    //
    // `finalUrl` is NOT reassigned: it still holds the raw URL, which is
    // exactly what AC4 asks be kept. Writing it back would say the same thing
    // twice and reads as though something had changed it.
  }

  const resolvedOk = httpStatus !== null;
  let normalized;
  try {
    normalized = normalizeCitationUrl(finalUrl);
  } catch (error) {
    if (!(error instanceof UnparsableCitationError)) throw error;
    // Extraction produced it from a substring that looked like a URL and the
    // parser disagrees. Nothing is invented to cover for it; the slot is kept
    // with the raw string and excluded from share, which is the same handling
    // an unresolved redirect gets and for the same reason.
    return unparsable(citation);
  }

  const isOwned = isOwnedHost(normalized.host, context.rootDomain, context.ownedDomains);
  const classification = classifyCitation({
    host: normalized.host,
    domain: normalized.domain,
    isOwned,
    competitorDomains: context.competitorDomains,
  });

  return {
    slotIndex: citation.slotIndex,
    rawUrl: citation.rawUrl,
    normalizedUrl: normalized.normalized,
    urlHash: normalized.urlHash,
    domain: normalized.domain,
    path: normalized.path,
    anchorText: citation.anchorText,
    title: citation.title,
    isOwned: classification.isOwned,
    isCompetitor: classification.isCompetitor,
    sourceClass: classification.sourceClass,
    httpStatus,
    resolvedAt,
    positionWeight: positionWeight(citation.slotIndex),
    textFragment: normalized.textFragment,
    countsTowardShare: resolvedOk,
  };
}

function unparsable(citation: ExtractedCitation): ResolvedCitation {
  return {
    slotIndex: citation.slotIndex,
    rawUrl: citation.rawUrl,
    normalizedUrl: citation.rawUrl,
    urlHash: Buffer.alloc(32),
    domain: "",
    path: null,
    anchorText: citation.anchorText,
    title: citation.title,
    isOwned: false,
    isCompetitor: false,
    sourceClass: "other",
    httpStatus: null,
    resolvedAt: null,
    positionWeight: positionWeight(citation.slotIndex),
    textFragment: null,
    countsTowardShare: false,
  };
}

/**
 * HEAD FIRST, GET AS FALLBACK — Stage 3 step 3.
 *
 * A HEAD is enough to learn where a wrapper redirects and transfers no body,
 * which matters when the target is a 40 MB PDF. Some CDNs refuse HEAD with a
 * 405 and answer a GET perfectly well, which is why the fallback exists
 * rather than the resolution simply failing on those hosts.
 */
async function defaultFetch(url: string): Promise<{ status: number; finalUrl: string }> {
  try {
    const head = await guardedFetch(url, { method: "HEAD" });
    if (head.status < 400) return { status: head.status, finalUrl: head.finalUrl };
  } catch (error) {
    // A REFUSAL IS NOT RETRIED. The guard refused this URL — following it
    // with a GET would be asking the same question expecting a different
    // answer, and is exactly the shape of a bypass.
    if (error instanceof GuardedFetchRefusal) throw error;
  }
  const get = await guardedFetch(url, { method: "GET" });
  return { status: get.status, finalUrl: get.finalUrl };
}

/**
 * AC9 — within one response, slots resolving to the same normalised URL are
 * counted ONCE, AT THE BEST SLOT.
 *
 * "Some engines repeat a citation across several slots, and counting each
 * would overstate that source's influence in the index." The best slot is the
 * lowest index, because `1/√slot` is decreasing — so keeping the first
 * occurrence keeps the highest weight, which is the citation the engine
 * actually led with.
 *
 * ACROSS responses they are counted per response (scenario 9), which needs no
 * code: this operates on one response's slots and nothing merges them.
 */
export function dedupeWithinResponse(citations: readonly ResolvedCitation[]): ResolvedCitation[] {
  const best = new Map<string, ResolvedCitation>();
  for (const citation of citations) {
    const key = citation.normalizedUrl;
    const existing = best.get(key);
    if (existing === undefined || citation.slotIndex < existing.slotIndex) best.set(key, citation);
  }
  return [...best.values()].sort((a, b) => a.slotIndex - b.slotIndex);
}

/**
 * AC10 — a resolution failure rate above the threshold for an engine raises
 * an internal alert.
 *
 * "The resolution-failure alert is a vendor-change detector as much as a
 * health metric" — a vendor that changes its redirect scheme breaks every
 * citation from that engine at once, and the failure rate is the first place
 * it shows.
 *
 * A MINIMUM SAMPLE, because one failure out of one is 100% and means nothing.
 * Alerting on it would page someone every time an engine returned a single
 * dead link, and an alert that fires on noise stops being read.
 */
export const RESOLUTION_FAILURE_THRESHOLD = 0.25;
export const RESOLUTION_ALERT_MIN_SAMPLE = 20;

export function shouldAlertOnResolutionFailures(attempted: number, failed: number): boolean {
  if (attempted < RESOLUTION_ALERT_MIN_SAMPLE) return false;
  return failed / attempted > RESOLUTION_FAILURE_THRESHOLD;
}
