import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { CrawlPageFetch } from "../../../contracts/aux/index.js";
import { GuardedFetchRefusal, type GuardedFetchInit, type GuardedResponse } from "../net/guarded-fetch.js";
import { toRegistrableDomain } from "../net/registrable-domain.js";
import { NOMINARA_USER_AGENT } from "../net/user-agent.js";
import { PolitenessBudget, PolitenessCapReached, PolitenessDeadlineReached } from "./politeness.js";
import { createRenderRequestGuard, RendererUnavailable, type Renderer } from "./renderer.js";
import { CRAWL_AGENT, isAllowed, type ParsedRobots } from "../net/robots.js";
import { sanitiseText } from "./sanitise.js";

// STORY-049 AC6 / AC7 / AC11 / AC12 — the page stage: for each selected page, a RAW fetch and a RENDERED fetch, both
// stored gzipped, every request charged to the one politeness budget, and a page that fails recorded with its reason while
// the crawl carries on (aux-and-geo-analysis.md §1 step 4).
//
// THE TWO COPIES ARE KEPT EXACTLY AS FETCHED. Nothing is stripped or rewritten before storage (see sanitise.ts for why):
// the bytes go to object storage gzipped, with a sha256 of the uncompressed content so the render-mode rules can show
// that the two copies differ, and the audit can be reproduced from storage with zero model calls.
//
// WHAT A FAILURE RECORD HOLDS. A short reason code and an HTTP status. Never the underlying error's message: a connect
// error carries the resolved address, and a refusal's reason names the check that refused it and never the address
// (STORY-131's rule, kept here).

/** aux-and-geo-analysis.md §1 step 4(a). */
export { NOMINARA_USER_AGENT };
/** aux-and-geo-analysis.md §1 step 4(b): "networkidle + 2 s". An adapter applies it; the cut-off here is the backstop. */
export const RENDER_TIMEOUT_MS = 30_000;
const MAX_URL_CHARS = 2048;

export type PageStage = "raw" | "rendered" | "store";
export type PageOutcome = "ok" | "partial" | "failed" | "skipped";
/** `crawl_delay_budget`: the wall-clock budget (NOT FROM THE REFERENCE) ran out under the target's Crawl-delay. */
export type SkippedPageReason = "robots_disallowed" | "robots_unavailable" | "page_cap_reached" | "crawl_delay_budget";

export interface StoredCopy {
  readonly object_key: string;
  /** Of the UNCOMPRESSED content. */
  readonly sha256: string;
  /** Uncompressed length in bytes. */
  readonly bytes: number;
  readonly status: number | null;
  /** True when the body was cut at the response cap. Always present: absent would read as "not truncated". */
  readonly truncated: boolean;
}

export interface PageFailure {
  readonly stage: PageStage;
  readonly reason: string;
  /** null = no HTTP response. A real status is never coerced. */
  readonly http_status: number | null;
}

export interface PageRecord {
  readonly url: string;
  readonly outcome: PageOutcome;
  readonly raw?: StoredCopy;
  readonly rendered?: StoredCopy;
  /** STORY-050: what the plain fetch answered, so the document model can be rebuilt from storage. Absent when no plain copy was stored. */
  readonly fetch?: CrawlPageFetch;
  readonly failures: PageFailure[];
  readonly skipped_reason?: SkippedPageReason;
}

export interface PageCrawlDeps {
  /** The page selection's root: a redirect off its registrable domain is a failure, not a page. */
  readonly rootUrl: string;
  readonly budget: PolitenessBudget;
  /** null = no robots.txt to obey (a 404/410); "unavailable" = it could not be read, so nothing is crawled. */
  readonly robots: ParsedRobots | "unavailable" | null;
  readonly renderer: Renderer;
  readonly renderTimeoutMs?: number;
  readonly fetch: (url: string, init: GuardedFetchInit) => Promise<GuardedResponse>;
  /** Writes gzipped bytes under the audit's prefix and returns the FULL stored key. */
  readonly store: (relative: string, body: Buffer, contentType: string) => Promise<string>;
  /** Relative path every object of this audit lives under, e.g. the audit id. */
  readonly keyPrefix: string;
}

export interface PageCrawlResult {
  readonly pages: PageRecord[];
  /** True when the politeness hard cap ended the crawl early. */
  readonly stoppedAtCap: boolean;
  /** True when the wall-clock budget ended the crawl early. Distinct from the cap: the pages are skipped as `crawl_delay_budget`. */
  readonly stoppedAtDeadline: boolean;
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function sameSite(a: string, b: string): boolean {
  try {
    return toRegistrableDomain(a) === toRegistrableDomain(b);
  } catch {
    return false;
  }
}

/** Whether our own robots rules let NominaraBot fetch `url`. null = no robots.txt to obey; "unavailable" is handled before any fetch. */
function robotsAllows(robots: ParsedRobots | "unavailable" | null, url: string): boolean {
  if (robots === null) return true;
  if (robots === "unavailable") return false;
  try {
    const parsed = new URL(url);
    return isAllowed(robots, CRAWL_AGENT, `${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

/** The response headers the document model reads. An allow-list: nothing else a server sends is stored. */
const RECORDED_HEADERS = ["content-type", "x-robots-tag"] as const;

function fetchRecord(response: GuardedResponse): CrawlPageFetch {
  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = response.headers[name];
    if (value !== undefined) headers[name] = sanitiseText(Array.isArray(value) ? value.join(", ") : value, 2000);
  }
  return {
    final_url: sanitiseText(response.finalUrl, MAX_URL_CHARS),
    redirect_chain: (response.redirectChain ?? []).map((u) => sanitiseText(u, MAX_URL_CHARS)),
    http_status: response.status,
    headers,
    ttfb_ms: response.ttfbMs ?? null,
    load_ms: response.loadMs ?? null,
  };
}

function fetchFailureReason(error: unknown): string {
  if (error instanceof GuardedFetchRefusal) return `unsafe_target:${error.reason}`;
  if (error instanceof Error && /timeout/i.test(error.message)) return "timeout";
  return "fetch_failed";
}

export async function crawlPages(urls: readonly string[], deps: PageCrawlDeps): Promise<PageCrawlResult> {
  const pages: PageRecord[] = [];
  let stoppedAtCap = false;
  let stoppedAtDeadline = false;
  const renderTimeoutMs = deps.renderTimeoutMs ?? RENDER_TIMEOUT_MS;

  for (const rawUrl of urls) {
    const url = sanitiseText(rawUrl, MAX_URL_CHARS);
    const skip = (reason: SkippedPageReason): void => {
      pages.push({ url, outcome: "skipped", failures: [], skipped_reason: reason });
    };

    if (stoppedAtDeadline) {
      skip("crawl_delay_budget");
      continue;
    }
    if (stoppedAtCap) {
      skip("page_cap_reached");
      continue;
    }
    if (deps.robots === "unavailable") {
      skip("robots_unavailable");
      continue;
    }
    if (deps.robots !== null) {
      const parsed = new URL(rawUrl);
      if (!isAllowed(deps.robots, CRAWL_AGENT, `${parsed.pathname}${parsed.search}`)) {
        skip("robots_disallowed");
        continue;
      }
    }

    const failures: PageFailure[] = [];
    let raw: StoredCopy | undefined;
    let rendered: StoredCopy | undefined;
    let fetchedWith: CrawlPageFetch | undefined;
    const key = sha256(rawUrl).slice(0, 24);

    const keep = async (kind: "raw" | "rendered", body: Buffer, status: number | null, truncated: boolean): Promise<StoredCopy | undefined> => {
      try {
        const objectKey = await deps.store([deps.keyPrefix, `${key}.${kind}.html.gz`].join("/"), gzipSync(body), "application/gzip");
        return { object_key: objectKey, sha256: sha256(body), bytes: body.length, status, truncated };
      } catch {
        failures.push({ stage: "store", reason: "storage_unavailable", http_status: null });
        return undefined;
      }
    };

    // (a) RAW: a plain GET, what a non-executing crawler sees.
    let rawOk = false;
    try {
      await deps.budget.acquire("page");
      const response = await deps.fetch(rawUrl, {
        headers: { "user-agent": NOMINARA_USER_AGENT },
        truncateAtCap: true,
        // Vetted BEFORE the hop is requested: a redirect off the site, or into a path our own robots rules disallow, is
        // not followed, so no request reaches a third party and no disallowed path is fetched.
        followRedirect: (next) => sameSite(next, deps.rootUrl) && robotsAllows(deps.robots, next),
      });
      if (response.status >= 300 && response.status < 400) {
        failures.push({ stage: "raw", reason: "redirect_not_followed", http_status: response.status });
      } else if (!sameSite(response.finalUrl, deps.rootUrl)) {
        failures.push({ stage: "raw", reason: "redirected_off_site", http_status: response.status });
      } else if (!robotsAllows(deps.robots, response.finalUrl)) {
        // Defence in depth for a fetcher that did not apply the hop check: the body is dropped, not stored.
        failures.push({ stage: "raw", reason: "robots_disallowed_after_redirect", http_status: response.status });
      } else if (response.status < 200 || response.status >= 300) {
        failures.push({ stage: "raw", reason: `http_${response.status}`, http_status: response.status });
      } else {
        rawOk = true;
        raw = await keep("raw", response.body, response.status, response.truncated === true);
        if (raw !== undefined) fetchedWith = fetchRecord(response);
      }
    } catch (error) {
      if (error instanceof PolitenessDeadlineReached) {
        stoppedAtDeadline = true;
        skip("crawl_delay_budget");
        continue;
      }
      if (error instanceof PolitenessCapReached) {
        stoppedAtCap = true;
        skip("page_cap_reached");
        continue;
      }
      failures.push({ stage: "raw", reason: fetchFailureReason(error), http_status: null });
    }

    // (b) RENDERED: only for a page the plain fetch could read. An error page has nothing to compare.
    if (rawOk && deps.renderer.available === false) {
      // Known up front: no request would be sent, so none is charged to the politeness budget (it would only burn an
      // interval slot and a hard-cap unit, and halve the pages the wall-clock budget admits).
      failures.push({ stage: "rendered", reason: "renderer_unavailable", http_status: null });
    } else if (rawOk) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await deps.budget.acquire("page");
        const guard = createRenderRequestGuard(rawUrl);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("render timeout")), renderTimeoutMs);
        });
        const page = await Promise.race([deps.renderer.render(rawUrl, guard), timeout]);
        rendered = await keep("rendered", Buffer.from(page.html, "utf8"), page.status, false);
      } catch (error) {
        if (error instanceof PolitenessDeadlineReached) {
          stoppedAtDeadline = true;
          failures.push({ stage: "rendered", reason: "crawl_delay_budget", http_status: null });
        } else if (error instanceof PolitenessCapReached) {
          stoppedAtCap = true;
          failures.push({ stage: "rendered", reason: "page_cap_reached", http_status: null });
        } else if (error instanceof RendererUnavailable) {
          failures.push({ stage: "rendered", reason: "renderer_unavailable", http_status: null });
        } else if (error instanceof Error && error.message === "render timeout") {
          failures.push({ stage: "rendered", reason: "render_timeout", http_status: null });
        } else {
          failures.push({ stage: "rendered", reason: "render_failed", http_status: null });
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    const outcome: PageOutcome = raw !== undefined && rendered !== undefined && failures.length === 0 ? "ok" : raw !== undefined || rendered !== undefined ? "partial" : "failed";
    pages.push({
      url,
      outcome,
      ...(raw === undefined ? {} : { raw }),
      ...(rendered === undefined ? {} : { rendered }),
      ...(fetchedWith === undefined ? {} : { fetch: fetchedWith }),
      failures,
    });
  }

  return { pages, stoppedAtCap, stoppedAtDeadline };
}
