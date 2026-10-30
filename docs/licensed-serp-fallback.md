# Licensed SERP: the provider seam and the fallback (STORY-029)

`google_aio` and `google_ai_mode` are the same class, `LicensedSerpAdapter`
(`src/lib/engines/serp/licensed-serp.ts`), constructed once per surface. The
vendor is **not** in that class. It sits behind `LicensedSerpProvider`:

```ts
interface LicensedSerpProvider {
  id: string; version: string;                  // recorded in adapterVersion, e.g. 0.1.0+serpapi.1
  fetchAnswer(request: LicensedSerpRequest, signal: AbortSignal, onSearchBilled?: () => void): Promise<LicensedFetchResult>;
  healthProbe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}
```

`LicensedFetchResult.answer` is vendor-neutral (markdown, typed elements with their
own links, answer-level references) or `null` for a genuine absence. The provider
owns its HTTP calls **and** its response mapper; the adapter owns the async-load
guard, the engine key, the failure flags, the cost and the metrics.

## Primary: SerpApi

| Surface | Calls | Billed |
|---|---|---|
| `google_ai_mode` | `engine=google_ai_mode` | 1 search |
| `google_aio` | `engine=google`; when `ai_overview` holds only a `page_token`, `engine=google_ai_overview&page_token=...` within a minute | 1 search, or 2 when the overview loads on demand |

Queued mode submits with `async=true` and reads the finished search back from the
Searches Archive; live mode is one synchronous request with `no_cache=true`.
SerpApi's own docs forbid `async` together with `no_cache`, so a queued request may
be served from the vendor's 1-hour cache. A cached response is free but is not an
independent sample and carries a dead `page_token`, so: every sample after the first
is live (`no_cache`), and a queued overview whose token follow-up fails is re-searched
once live and followed at once. A first sample repeated within the hour can still be a
cached copy of the previous run's (the vendor gives no cache marker in the response);
that is an owner decision recorded against STORY-032. A search the vendor accepted is
metered even when the capture then fails; a cached search is billed at list price in
`usage_ledger` (a conservative over-read, since the response cannot say it was cached).
Google's "hasn't returned any results" message is an absence (`no_ai_overview_for_query`
or `empty_answer`), not a fault. Its exact shape for AI Mode is from the vendor's
documented message, not a recording.

## Switching to a fallback

A switch is one line in `registry.ts` (`serpAdapterFor`, where the provider is chosen) plus a provider and a mapper; it is a code change, not an environment value. It is never a change to the adapter, the
registry's callers, the parser, or storage.

1. Write `src/lib/engines/serp/<vendor>-provider.ts` implementing
   `LicensedSerpProvider`. Its mapper turns that vendor's JSON into `LicensedAnswer`
   (`serp-mapper.ts` is the SerpApi example; the typed elements and per-element
   links are the part that matters for the citation gap).
2. Make the vendor's equivalent of the async-load behaviour real in `fetchAnswer`:
   if the vendor returns a null overview for an on-demand generation unless a
   request parameter is set, set it, and treat a null without it as
   `malformed_response` (never as an absence). `request.asyncLoad` is the signal.
3. In `registry.ts`, `serpAdapterFor` is the one line that picks the provider.
4. Record a few real responses as fixtures (`scripts/record-serp-fixtures.mjs` is the
   SerpApi recorder: one call per run, key from the environment, identifiers
   stripped) and copy the scenario rows of `serp.spec.ts` against them.
5. `adapterVersion` now carries the new provider, so `answer_captures.adapter_version`
   shows the switch in history. A major bump of `LICENSED_SERP_ADAPTER_VERSION` is
   needed only if the mapped output changes meaning (it changes the L1 cache key).

No fallback vendor is named or implemented yet: choosing one, and its contract, is
an owner decision (see STORY-029 Implementation decisions).

## Known metering errors (review 3)

The meter can read too low when a page_token follow-up the vendor accepted is aborted by our timeout mid-flight (not metered). It can read too high when a queued submit is answered from SerpApi's free 1-hour cache (metered as billed). Both are small; the ceilings stay roughly right and nothing is billed twice.
