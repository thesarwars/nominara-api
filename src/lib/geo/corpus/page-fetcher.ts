import { GuardedFetchRefusal, guardedFetch, type GuardedFetchInit, type GuardedResponse } from "../../net/guarded-fetch.js";
import { NOMINARA_USER_AGENT } from "../../aux/page-crawl.js";

// STORY-058 AC4 - the page fetch for a citation that carried no text directive. It goes through the SSRF-guarded fetcher
// (STORY-049's `guardedFetch`), so a citation URL that resolves to an internal address is REFUSED at the guard, not fetched.
//
// A result, never an exception: one blocked, refused or dead URL is a fact about that URL, and the corpus builder records it and
// carries on (a partial corpus is an explicit `partial` build, never a swallowed error). Reasons are short codes - never the
// underlying error's message, which for a connect failure carries the resolved address.

export type PageFetchResult =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export type PageFetcher = (url: string) => Promise<PageFetchResult>;

type FetchImpl = (url: string, init: GuardedFetchInit) => Promise<GuardedResponse>;

export function createGuardedPageFetcher(fetchImpl: FetchImpl = (url, init) => guardedFetch(url, init)): PageFetcher {
  return async (url) => {
    let response: GuardedResponse;
    try {
      response = await fetchImpl(url, { headers: { "user-agent": NOMINARA_USER_AGENT, accept: "text/html,application/xhtml+xml" }, truncateAtCap: true });
    } catch (error) {
      if (error instanceof GuardedFetchRefusal) return { kind: "refused", reason: error.reason };
      return { kind: "failed", reason: "fetch_error" };
    }
    if (response.status < 200 || response.status >= 300) return { kind: "failed", reason: `http_${String(response.status)}` };
    const type = String(Array.isArray(response.headers["content-type"]) ? response.headers["content-type"][0] : (response.headers["content-type"] ?? "")).toLowerCase();
    if (!type.includes("html")) return { kind: "failed", reason: "not_html" };
    return { kind: "html", html: response.body.toString("utf8") };
  };
}
