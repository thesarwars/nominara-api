import { createCrawlGate, type CrawlGateOptions, type FetchLike } from "../../net/crawl-gate.js";

// STORY-060 E1 / OWNER DECISION 99(j) (2026-11-12) - THE ROBOTS EXEMPTION FOR THE WIKIMEDIA APIs, and nothing wider.
//
// WHY. Owner decision 70(d) makes every NominaraBot fetch obey robots.txt. www.wikidata.org and en.wikipedia.org publish `User-agent: *` / `Disallow: /w/`
// (allowing only api.php?action=mobileview), which is written for crawlers of pages and refuses the one thing the profile probe needs: the official
// MediaWiki Action API at /w/api.php. Wikimedia's own rule for that API is its API etiquette (an identifying User-Agent with contact information, serial
// requests, a modest rate), and that is what governs these requests instead.
//
// HOW NARROW. Exactly two hosts over https on the default port, exactly the path `/w/api.php`, and exactly the `action` values the probe sends:
//   www.wikidata.org   wbsearchentities, wbgetentities
//   en.wikipedia.org   query
// Any other path, host, scheme, port or action on these domains (a page, Special:, index.php, parse, edit) is NOT exempt and obeys robots.txt as before.
// The exemption is judged on every redirect hop. It is a predicate handed to a gate of this module's own: the shared `crawlGatedFetch` has no exemption.
//
// WHAT STAYS. The SSRF guard underneath; the identified `NominaraBot/1.0 (+https://nominara.com/bot)` User-Agent (the callers set it); and a strict per-host
// rate: one request per `WIKIMEDIA_API_CRAWL_DELAY_SECONDS` to a host, serial and never a burst (the shared budget is 500 ms).

export const WIKIMEDIA_API_CRAWL_DELAY_SECONDS = 1;

const ENDPOINTS: Readonly<Record<string, readonly string[]>> = {
  "www.wikidata.org": ["wbsearchentities", "wbgetentities"],
  "en.wikipedia.org": ["query"],
};

export function isWikimediaApiEndpoint(url: URL): boolean {
  if (url.protocol !== "https:" || url.port !== "" || url.pathname !== "/w/api.php" || url.username !== "" || url.password !== "") return false;
  const actions = ENDPOINTS[url.hostname.toLowerCase()];
  const action = url.searchParams.get("action");
  return actions !== undefined && action !== null && actions.includes(action);
}

export function createWikimediaGate(options: Pick<CrawlGateOptions, "fetch" | "now" | "sleep"> = {}): FetchLike {
  return createCrawlGate({ ...options, robotsExempt: isWikimediaApiEndpoint, exemptCrawlDelaySeconds: WIKIMEDIA_API_CRAWL_DELAY_SECONDS });
}

let shared: FetchLike | undefined;
/** The process-wide gate the profile probe's JSON fetcher uses: one set of per-host budgets for the two Wikimedia hosts. */
export const wikimediaGatedFetch: FetchLike = (url, init) => (shared ??= createWikimediaGate())(url, init);
