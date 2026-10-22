import { toRegistrableDomain } from "../net/registrable-domain.js";
import type { SitemapEntry } from "./sitemap.js";

// STORY-049 AC5 — page selection (aux-and-geo-analysis.md §1 step 3).
//
//   key_pages       root + sitemap-priority pages + every URL referenced by an owned citation in the last 90 days + URLs
//                   named in open tasks; cap resolved from the plan
//   single_url      one page
//   sitemap_sample  stratified sample by path depth
//   public_surface  (the unverified-domain scope, step 1) the supplied URL and nothing else
//
// PURE: the caller reads the citation and task URLs and the sitemap; this decides what is fetched. Nothing here opens a
// socket, and every URL it returns is on the verified site: a sitemap is attacker-shaped input, and a crawl does not
// leave the registrable domain it was authorised for.

export type SelectionScope = "key_pages" | "single_url" | "sitemap_sample" | "public_surface";

/**
 * PROVISIONAL. plans-and-entitlements.md has no `aux.pages_per_audit` key, so the plan's page cap is not yet a number
 * anyone has decided. Until the owner sets per-tier values this is one conservative constant behind `pageCapForPlan`,
 * so the entitlement read lands in one place. Not a spec value: do not cite it as one.
 */
export const PROVISIONAL_PAGE_CAP = 25;

export function pageCapForPlan(_planKey: string): number {
  return PROVISIONAL_PAGE_CAP;
}

export type SkippedReason = "foreign_site" | "not_http";

export interface SelectPagesInput {
  readonly scope: SelectionScope;
  /** The URL the project was created with: the root page, and the only page of a public_surface audit. */
  readonly rootUrl: string;
  readonly cap: number;
  readonly sitemap: readonly SitemapEntry[];
  /** Owned-citation URLs from the last 90 days. */
  readonly ownedCitationUrls: readonly string[];
  /** URLs named in open tasks. */
  readonly openTaskUrls: readonly string[];
  readonly targetUrls: readonly string[];
}

export interface PageSelection {
  readonly urls: string[];
  readonly skipped: { readonly url: string; readonly reason: SkippedReason }[];
  /** Candidates that were valid but did not fit under the cap. Counted, never silent. */
  readonly overCap: number;
}

/** The protocol default for an absent `<priority>`. Absent is NOT 0: an explicit 0 is a site saying "least important". */
const DEFAULT_SITEMAP_PRIORITY = 0.5;

function normalise(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function sameSite(a: string, b: string): boolean {
  try {
    return toRegistrableDomain(a) === toRegistrableDomain(b);
  } catch {
    return false;
  }
}

function depthOf(url: string): number {
  return new URL(url).pathname.split("/").filter((s) => s !== "").length;
}

/** Evenly spaced picks across a list: deterministic, and the last element is represented for any n > k. */
function evenly<T>(items: readonly T[], k: number): T[] {
  if (items.length <= k) return [...items];
  const out: T[] = [];
  for (let i = 0; i < k; i += 1) out.push(items[Math.floor((i * items.length) / k)]!);
  return out;
}

/** One pick per depth stratum in turn (shallowest first), so a 50-page-deep-one-level sitemap cannot crowd out depth 4. */
function stratified(urls: readonly string[], k: number): string[] {
  const strata = new Map<number, string[]>();
  for (const u of urls) {
    const d = depthOf(u);
    strata.set(d, [...(strata.get(d) ?? []), u]);
  }
  const depths = [...strata.keys()].sort((a, b) => a - b);
  const quota = new Map(depths.map((d) => [d, 0]));
  let remaining = Math.min(k, urls.length);
  // Round-robin the allowance across strata, never above a stratum's size.
  while (remaining > 0) {
    let progressed = false;
    for (const d of depths) {
      if (remaining === 0) break;
      if (quota.get(d)! < strata.get(d)!.length) {
        quota.set(d, quota.get(d)! + 1);
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return depths.flatMap((d) => evenly(strata.get(d)!, quota.get(d)!));
}

export function selectPages(input: SelectPagesInput): PageSelection {
  if (!Number.isInteger(input.cap) || input.cap < 0) {
    // A NaN cap makes every "is there room" comparison false, which silently disables the hard stop.
    throw new Error(`page selection: the cap must be a non-negative integer, received ${String(input.cap)}`);
  }

  const skipped: PageSelection["skipped"][number][] = [];
  const seen = new Set<string>();
  /** Validates, keeps on-site http(s) URLs, drops duplicates. Records why anything else was refused. */
  const admit = (raw: string): string | null => {
    const url = normalise(raw);
    if (url === null) {
      skipped.push({ url: raw, reason: "not_http" });
      return null;
    }
    if (!sameSite(url, input.rootUrl)) {
      skipped.push({ url: raw, reason: "foreign_site" });
      return null;
    }
    if (seen.has(url)) return null;
    seen.add(url);
    return url;
  };

  const root = admit(input.rootUrl);
  let candidates: string[];
  /** How many valid pages the scope could have fetched before the cap: what `overCap` is measured against. */
  let eligible: number;

  switch (input.scope) {
    case "public_surface":
      candidates = root === null ? [] : [root];
      eligible = candidates.length;
      break;
    case "single_url": {
      // seen already holds the root; a single_url audit of the root itself is legitimate, so it is not a duplicate here.
      seen.clear();
      const target = input.targetUrls[0];
      const url = target === undefined ? null : admit(target);
      candidates = url === null ? [] : [url];
      eligible = candidates.length;
      break;
    }
    case "sitemap_sample": {
      const urls = input.sitemap.map((e) => admit(e.loc)).filter((u): u is string => u !== null);
      candidates = stratified(urls, input.cap);
      eligible = urls.length;
      break;
    }
    case "key_pages": {
      const cited = [...input.ownedCitationUrls, ...input.openTaskUrls].map(admit).filter((u): u is string => u !== null);
      const bySitemapPriority = input.sitemap
        .map((e, index) => ({ e, index }))
        .sort((a, b) => (b.e.priority ?? DEFAULT_SITEMAP_PRIORITY) - (a.e.priority ?? DEFAULT_SITEMAP_PRIORITY) || a.index - b.index)
        .map(({ e }) => admit(e.loc))
        .filter((u): u is string => u !== null);
      // The reference lists "sitemap-priority pages" before the citation and task URLs, but also says EVERY owned-citation
      // URL. With a cap, listing order would let a large sitemap crowd out the pages the customer's own citations point at,
      // so the pages with evidence behind them are placed first. One line to change if the owner reads it the other way.
      candidates = [...(root === null ? [] : [root]), ...cited, ...bySitemapPriority];
      eligible = candidates.length;
      break;
    }
  }

  return { urls: candidates.slice(0, input.cap), skipped, overCap: Math.max(0, eligible - Math.min(candidates.length, input.cap)) };
}
