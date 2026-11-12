import { CrawlRefusal } from "../../net/crawl-gate.js";
import { GuardedFetchRefusal, type GuardedFetchInit, type GuardedResponse } from "../../net/guarded-fetch.js";
import { NOMINARA_USER_AGENT } from "../../net/user-agent.js";
import { wikimediaGatedFetch } from "./wikimedia-gate.js";

// STORY-060 E1 (owner decision 99b) - a JSON GET for the profile probe. It goes through the SSRF-guarded fetcher by way of the shared crawl gate
// (owner decision 70(d)): the target host's robots.txt is checked (a Disallow is a `refused` result and the URL is never requested), and a per-host
// request budget is kept. Same shape as the corpus page fetcher (src/lib/geo/corpus/page-fetcher.ts), for JSON.
//
// The default fetch is the WIKIMEDIA gate (wikimedia-gate.ts): the same gate with a narrow, enumerated robots exemption for the official API endpoints
// (owner decision 99j), since Wikimedia's robots.txt disallows /w/ for every crawler. The per-host rate stays strict and the SSRF guard stays.
//
// A RESULT, NEVER AN EXCEPTION: a refused or failed request is a fact about that request, and the probe treats it as "could not check" - never as
// "absent". Reasons are short codes, never the underlying error's message (a connect failure carries the resolved address).
//
// NETWORK I/O, so NEVER inside a database transaction: it is called only from the `run` phase of the phased `entity_probe` job (ADR-0003 / KAD-06).

export type JsonFetchResult =
  | { readonly kind: "json"; readonly body: unknown }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export type JsonFetcher = (url: string) => Promise<JsonFetchResult>;

type FetchImpl = (url: string, init: GuardedFetchInit) => Promise<GuardedResponse>;

export function createGuardedJsonFetcher(fetchImpl: FetchImpl = wikimediaGatedFetch): JsonFetcher {
  return async (url) => {
    let response: GuardedResponse;
    try {
      response = await fetchImpl(url, { headers: { "user-agent": NOMINARA_USER_AGENT, accept: "application/json" } });
    } catch (error) {
      if (error instanceof GuardedFetchRefusal || error instanceof CrawlRefusal) return { kind: "refused", reason: error.reason };
      return { kind: "failed", reason: "fetch_error" };
    }
    if (response.status < 200 || response.status >= 300) return { kind: "failed", reason: `http_${String(response.status)}` };
    const type = String(Array.isArray(response.headers["content-type"]) ? response.headers["content-type"][0] : (response.headers["content-type"] ?? "")).toLowerCase();
    if (!type.includes("json")) return { kind: "failed", reason: "not_json" };
    try {
      return { kind: "json", body: JSON.parse(response.body.toString("utf8")) as unknown };
    } catch {
      return { kind: "failed", reason: "not_json" };
    }
  };
}
