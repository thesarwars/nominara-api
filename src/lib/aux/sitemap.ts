import { gunzipSync } from "node:zlib";
import { MAX_RESPONSE_BYTES } from "../net/address-rules.js";
import { toRegistrableDomain } from "../net/registrable-domain.js";
import { elementsOf, firstElement } from "./xml-scan.js";

// STORY-049 AC4 — the sitemap, with bounded index recursion and a sampling cap.
//
// aux-and-geo-analysis.md §1 step 2: "GET /sitemap.xml (+ index recursion, max 3 levels, max 5,000 URLs sampled)". The
// URL comes from the robots.txt `Sitemap:` lines (that is where a site says where it is), with /sitemap.xml as the default.
//
// A SITEMAP IS ATTACKER-SHAPED INPUT, so every dimension is bounded and the cut is RECORDED rather than silent: depth (3),
// URLs kept (5,000, sampled evenly rather than truncated, so the last section of a large site is represented), files
// fetched (an index of a million sitemaps must not become a million requests), decompressed size (a gzip bomb), and
// the site (a child sitemap on another registrable domain is never fetched: a crawl does not leave the verified domain).
//
// PURE of the network: `fetch` is injected, so the caller charges each fetch to the politeness budget and the guarded
// fetcher stays the only thing that opens a socket (KAD-06 / STORY-131).

/** The reference's numbers, exactly. */
export const MAX_SITEMAP_DEPTH = 3;
export const MAX_SITEMAP_URLS = 5000;
/**
 * NOT FROM THE REFERENCE — a chosen bound, so the request count of the sitemap stage is finite. 25 files is more than any
 * sitemap index a site of the sizes the plans cover needs; raising it is a politeness decision (each file is a request).
 */
export const MAX_SITEMAP_FILES = 25;
/** The sitemaps protocol's own per-file ceiling; entries past it in one file are not read. */
const MAX_URLS_PER_FILE = 50_000;
/** Memory bound on what is held for sampling; `totalSeen` still counts what was read past it. */
const MAX_HELD_URLS = 100_000;

export interface SitemapEntry {
  readonly loc: string;
  readonly lastmod: string | null;
  /** null = absent. A real `0` stays 0. */
  readonly priority: number | null;
}

export type SitemapProblemReason =
  | "fetch_failed"
  | "not_a_sitemap"
  | "depth_exceeded"
  | "foreign_site"
  | "file_budget_exhausted"
  | "crawl_delay_budget"
  | "too_large"
  | `http_${number}`;

export interface SitemapProblem {
  readonly url: string;
  readonly reason: SitemapProblemReason;
}

export interface SitemapResult {
  /** At most MAX_SITEMAP_URLS, in document order. */
  readonly urls: SitemapEntry[];
  /** True when more than MAX_SITEMAP_URLS were seen and an even sample was kept. */
  readonly sampled: boolean;
  /** Every URL entry read, before sampling. */
  readonly totalSeen: number;
  readonly filesFetched: number;
  readonly problems: SitemapProblem[];
}

/**
 * Thrown by `SitemapInput.fetch` when it did NOT send the request because the crawl's wall-clock budget cannot cover it (the
 * politeness wait would pass the deadline). It is a skip, not a failure: the file is recorded as `crawl_delay_budget` and is
 * not counted in `filesFetched`, because no request was made.
 */
export class SitemapFetchSkipped extends Error {
  constructor() {
    super("sitemap fetch skipped: the crawl's wall-clock budget cannot cover it");
    this.name = "SitemapFetchSkipped";
  }
}

export interface SitemapInput {
  /** `https://{root_domain}` — the verified site; also where the default /sitemap.xml lives. */
  readonly origin: string;
  /** robots.txt `Sitemap:` URLs (absolute http/https). Empty means "use the default". */
  readonly declared: readonly string[];
  readonly fetch: (url: string) => Promise<{ readonly status: number; readonly body: Buffer }>;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

function text(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const inner = cdata !== null ? cdata[1]! : raw.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]!);
  return inner.trim();
}

function tag(block: string, name: string): string | null {
  const inner = firstElement(block, name);
  if (inner === null) return null;
  const value = text(inner);
  return value === "" ? null : value;
}

function sameSite(a: string, b: string): boolean {
  try {
    return toRegistrableDomain(a) === toRegistrableDomain(b);
  } catch {
    // an IP literal or an unlisted TLD is nobody's verified domain
    return false;
  }
}

type Parsed =
  | { readonly kind: "index"; readonly children: string[] }
  | { readonly kind: "urlset"; readonly entries: SitemapEntry[]; readonly seen: number }
  | { readonly kind: "invalid" };

function parse(xml: string): Parsed {
  if (/<sitemapindex\b/.test(xml)) {
    const children: string[] = [];
    for (const block of elementsOf(xml, "sitemap")) {
      const loc = tag(block, "loc");
      if (loc !== null) children.push(loc);
    }
    return { kind: "index", children };
  }
  if (/<urlset\b/.test(xml)) {
    const entries: SitemapEntry[] = [];
    let seen = 0;
    for (const block of elementsOf(xml, "url")) {
      const loc = tag(block, "loc");
      if (loc === null) continue;
      seen += 1;
      if (seen > MAX_URLS_PER_FILE) break;
      const priorityText = tag(block, "priority");
      const priority = priorityText === null ? null : Number(priorityText);
      entries.push({ loc, lastmod: tag(block, "lastmod"), priority: priority !== null && Number.isFinite(priority) ? priority : null });
    }
    return { kind: "urlset", entries, seen };
  }
  return { kind: "invalid" };
}

/** Evenly spaced picks across the whole list: floor(i * n / cap). Distinct for n > cap, and deterministic. */
function sample(all: readonly SitemapEntry[], cap: number): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (let i = 0; i < cap; i += 1) out.push(all[Math.floor((i * all.length) / cap)]!);
  return out;
}

export async function collectSitemap(input: SitemapInput): Promise<SitemapResult> {
  const problems: SitemapProblem[] = [];
  const roots = input.declared.length > 0 ? [...input.declared] : [new URL("/sitemap.xml", input.origin).href];
  const visited = new Set<string>();
  const held = new Map<string, SitemapEntry>();
  let totalSeen = 0;
  let filesFetched = 0;

  // Breadth-first by level, so the file budget is spent on the shallow files first.
  let level: string[] = [];
  for (const url of roots) {
    if (!sameSite(url, input.origin)) problems.push({ url, reason: "foreign_site" });
    else level.push(url);
  }

  for (let depth = 1; level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const url of level) {
      if (visited.has(url)) continue;
      visited.add(url);
      if (filesFetched >= MAX_SITEMAP_FILES) {
        problems.push({ url, reason: "file_budget_exhausted" });
        continue;
      }

      let response: Awaited<ReturnType<SitemapInput["fetch"]>>;
      try {
        response = await input.fetch(url);
      } catch (error) {
        if (error instanceof SitemapFetchSkipped) {
          // Nothing was sent: not a failed fetch, and not counted as a file fetched.
          problems.push({ url, reason: "crawl_delay_budget" });
          continue;
        }
        filesFetched += 1;
        problems.push({ url, reason: "fetch_failed" });
        continue;
      }
      filesFetched += 1;
      if (response.status < 200 || response.status >= 300) {
        problems.push({ url, reason: `http_${response.status}` });
        continue;
      }

      let body = response.body;
      if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
        try {
          // The cap applies to what it EXPANDS to: a few KB of gzip can be gigabytes of spaces.
          body = gunzipSync(body, { maxOutputLength: MAX_RESPONSE_BYTES });
        } catch (error) {
          problems.push({ url, reason: (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "too_large" : "not_a_sitemap" });
          continue;
        }
      }

      const parsed = parse(body.toString("utf8"));
      if (parsed.kind === "invalid") {
        problems.push({ url, reason: "not_a_sitemap" });
      } else if (parsed.kind === "urlset") {
        totalSeen += parsed.seen;
        for (const entry of parsed.entries) {
          if (held.size >= MAX_HELD_URLS) break;
          if (!held.has(entry.loc)) held.set(entry.loc, entry);
        }
      } else {
        for (const child of parsed.children) {
          if (depth >= MAX_SITEMAP_DEPTH) problems.push({ url: child, reason: "depth_exceeded" });
          else if (!sameSite(child, input.origin)) problems.push({ url: child, reason: "foreign_site" });
          else next.push(child);
        }
      }
    }
    level = next;
  }

  const all = [...held.values()];
  const sampled = totalSeen > MAX_SITEMAP_URLS && all.length > MAX_SITEMAP_URLS;
  return {
    urls: sampled ? sample(all, MAX_SITEMAP_URLS) : all.slice(0, MAX_SITEMAP_URLS),
    sampled,
    totalSeen,
    filesFetched,
    problems,
  };
}
