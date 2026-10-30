// STORY-029 - records ONE live SerpApi response to a file. Each run costs one search (the free plan has 250 a month and
// this story's budget is 6 in total), so it makes exactly one HTTP call and refuses to run without SERP_LIVE=1.
//
//   SERP_LIVE=1 SERP_API_KEY=... node scripts/record-serp-fixtures.mjs <out.json> <k=v> [<k=v> ...]
//   e.g. ... out.json engine=google_ai_mode q="best budget headphones" hl=en gl=us no_cache=true
//        ... out.json archive=<search_id>          (Searches Archive retrieval of an async submit; free)
//
// Runs outside any DB transaction and is not imported by anything under src/. The key is read from the environment, is
// never printed, and is never written to the output: the response is stripped of everything account-identifying
// (search ids, endpoints, timestamps, the echoed parameters) before it is saved. Prints key NAMES only, never values.
import console from "node:console";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

if (process.env.SERP_LIVE !== "1") {
  console.error("refusing: set SERP_LIVE=1 (each run spends a SerpApi search)");
  process.exit(2);
}
const key = process.env.SERP_API_KEY;
if (!key) {
  console.error("refusing: SERP_API_KEY is not set");
  process.exit(2);
}
const [out, ...pairs] = process.argv.slice(2);
const params = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));

let url;
if (params.archive) {
  url = new URL(`https://serpapi.com/searches/${encodeURIComponent(params.archive)}.json`);
} else {
  url = new URL("https://serpapi.com/search.json");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
}
url.searchParams.set("api_key", key);

const response = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(90_000) });
const body = await response.json();

/** Everything that identifies the account, the search, or its stored copy. */
export function sanitise(value) {
  const clone = globalThis.structuredClone(value);
  if (clone.search_metadata) {
    clone.search_metadata = { status: clone.search_metadata.status };
  }
  delete clone.search_parameters;
  delete clone.search_information;
  delete clone.serpapi_pagination;
  delete clone.pagination;
  delete clone.subsequent_request_token;
  return clone;
}

const text = JSON.stringify(sanitise(body), null, 2);
if (text.includes(key)) {
  console.error("refusing to write: the key appears in the response");
  process.exit(3);
}
writeFileSync(out, text);
// The search id is printed (not saved): an async submit needs it for the free Searches Archive retrieval, and it opens nothing without the key.
console.log(JSON.stringify({ httpStatus: response.status, topLevelKeys: Object.keys(body), bytes: text.length, searchId: body.search_metadata?.id }));
