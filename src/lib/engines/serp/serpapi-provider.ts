import { incrementCounter } from "../../telemetry/metrics.js";
import { CaptureFailureError, type CaptureFailureCode } from "../failure-taxonomy.js";
import type { EngineKey } from "../contract.js";
import type { LicensedFetchResult, LicensedSerpProvider, LicensedSerpRequest } from "./licensed-serp.js";
import { mapSerpAnswer } from "./serp-mapper.js";
import {
  serpAiModeResponseSchema,
  serpAiOverviewResponseSchema,
  serpEnvelopeSchema,
  serpOrganicResponseSchema,
} from "./serp-response.schema.js";

// STORY-029 - SerpApi (serpapi.com), owner-confirmed provider. Native fetch, no SDK. Runs in the capture worker, outside any DB
// transaction (ADR-0003); nothing here is reachable from a request handler.
//
// THE VENDOR'S ENDPOINTS
//   google_ai_mode          engine=google_ai_mode            the answer is the response
//   google_aio              engine=google                    ai_overview is inline, or ONLY {page_token, serpapi_link}
//                           engine=google_ai_overview        ...and the token is followed here, within a minute of the search
// "THE ASYNC-LOAD PARAMETER" (NFR-SIM-11), AS SERPAPI HAS IT. SerpApi has no request parameter by that name. Its mechanism for an
// on-demand overview is the page_token: Google serves some overviews only through a second request, and a response that carries
// the token and no text_blocks is the "null payload" of the spec, indistinguishable from "this query has no AI Overview" unless the
// token is followed. So `asyncLoad` here means "follow the page_token", the adapter asserts it before dispatch, and an unfollowed
// token is a defect (`malformed_response`), never an absence. AI Mode has no such token; its flag is asserted all the same and
// changes nothing on the wire. See STORY-029 Implementation decisions.
//
// MODES. live  -> one synchronous request, no_cache=true (a fresh answer; fidelity beats the free cached copy).
//        queued -> async=true: submit, then read the finished search back from the Searches Archive. The vendor forbids async
//                  together with no_cache, so a queued request may be served from its 1-hour cache (free, still a real answer).
// The follow-up for an overview is always synchronous: its token expires within a minute of the search.

const BASE_URL = "https://serpapi.com";

export interface SerpApiProviderConfig {
  readonly apiKey: string;
  /** Injected so unit tests never touch the network. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Pause between Searches Archive reads of a queued search. */
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The mapper revision: bump when mapSerpAnswer or the schemas change what a given response produces. */
export const SERPAPI_PROVIDER_VERSION = "1";

function failure(code: CaptureFailureError["code"], engineKey: EngineKey): CaptureFailureError {
  return new CaptureFailureError(code, engineKey);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function codeForStatus(status: number, body: unknown): CaptureFailureCode {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) {
    const message = (body as { error?: unknown } | null)?.error;
    // An exhausted plan is a different condition from a throttle: retrying it within the day cannot help.
    return typeof message === "string" && /out of searches|run out of/iu.test(message) ? "quota_exhausted" : "rate_limited";
  }
  if (status >= 500) return "upstream_5xx";
  return "malformed_response";
}

export class SerpApiProvider implements LicensedSerpProvider {
  readonly id = "serpapi";
  readonly version = SERPAPI_PROVIDER_VERSION;

  constructor(private readonly config: SerpApiProviderConfig) {}

  private get fetchFn(): typeof fetch {
    return this.config.fetchImpl ?? fetch;
  }

  /** One GET. The key travels as `api_key` (the vendor's only mechanism) and is never put in an error, a log line or a span. */
  private async getJson(url: URL, signal: AbortSignal, engineKey: EngineKey): Promise<unknown> {
    url.searchParams.set("api_key", this.config.apiKey);
    const response = await this.fetchFn(url, { method: "GET", signal });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok) throw failure(codeForStatus(response.status, body), engineKey);
    if (body === undefined) throw failure("malformed_response", engineKey);
    return body;
  }

  private searchUrl(params: Record<string, string>): URL {
    const url = new URL("/search.json", BASE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }

  /** hl/gl from the capture locale ('en-US' -> hl=en, gl=us). */
  private localeParams(locale: string): Record<string, string> {
    const [language, region] = locale.split("-");
    return { hl: (language ?? "en").toLowerCase(), gl: (region ?? "US").toLowerCase() };
  }

  /** One search in the requested mode. A queued search is submitted, then read back until it is no longer queued or processing. */
  private async search(params: Record<string, string>, request: LicensedSerpRequest, signal: AbortSignal, engineKey: EngineKey): Promise<unknown> {
    const sleep = this.config.sleep ?? defaultSleep;
    if (request.mode === "live") {
      return this.getJson(this.searchUrl({ ...params, no_cache: "true" }), signal, engineKey);
    }
    let body = await this.getJson(this.searchUrl({ ...params, async: "true" }), signal, engineKey);
    for (;;) {
      signal.throwIfAborted();
      const envelope = serpEnvelopeSchema.safeParse(body);
      if (!envelope.success) throw failure("malformed_response", engineKey);
      const status = envelope.data.search_metadata?.status;
      if (status === "Success" || status === "Error") return body;
      const id = envelope.data.search_metadata?.id;
      if (id === undefined) throw failure("malformed_response", engineKey);
      await sleep(this.config.pollIntervalMs ?? 2000, signal);
      body = await this.getJson(new URL(`/searches/${encodeURIComponent(id)}.json`, BASE_URL), signal, engineKey);
    }
  }

  async fetchAnswer(request: LicensedSerpRequest, signal: AbortSignal): Promise<LicensedFetchResult> {
    return request.surface === "google_ai_mode" ? this.fetchAiMode(request, signal) : this.fetchOverview(request, signal);
  }

  private malformed(engineKey: EngineKey): CaptureFailureError {
    incrementCounter("nominara_capture_malformed_response_total", { engine_key: engineKey, adapter_version: `${this.id}.${this.version}` });
    return failure("malformed_response", engineKey);
  }

  private async fetchAiMode(request: LicensedSerpRequest, signal: AbortSignal): Promise<LicensedFetchResult> {
    const engineKey = "google_ai_mode";
    const body = await this.search({ engine: "google_ai_mode", q: request.query, ...this.localeParams(request.locale) }, request, signal, engineKey);
    const parsed = serpAiModeResponseSchema.safeParse(body);
    if (!parsed.success) throw this.malformed(engineKey);
    // An error string is not an answer and not an absence: it fails (retryably) so no data point is stored for it.
    if (parsed.data.error !== undefined) throw failure("upstream_5xx", engineKey);
    const requestId = parsed.data.search_metadata?.id;
    // AI Mode reports no on-demand flag, so the persisted value is null, not false.
    return {
      answer: mapSerpAnswer({ text_blocks: parsed.data.text_blocks ?? [], ...(parsed.data.references !== undefined ? { references: parsed.data.references } : {}), ...(parsed.data.shopping_results !== undefined ? { shopping_results: parsed.data.shopping_results } : {}) }),
      asyncGenerated: null,
      searchesBilled: 1,
      ...(requestId !== undefined ? { vendorRequestId: requestId } : {}),
    };
  }

  private async fetchOverview(request: LicensedSerpRequest, signal: AbortSignal): Promise<LicensedFetchResult> {
    const engineKey = "google_aio";
    const body = await this.search({ engine: "google", q: request.query, ...this.localeParams(request.locale) }, request, signal, engineKey);
    const first = serpOrganicResponseSchema.safeParse(body);
    if (!first.success) throw this.malformed(engineKey);
    if (first.data.error !== undefined) throw failure("upstream_5xx", engineKey);

    const overview = first.data.ai_overview;
    const requestId = first.data.search_metadata?.id;
    // No ai_overview at all: Google showed none for this query. Genuine - this request carried the async-load parameter.
    if (overview === undefined) return { answer: null, asyncGenerated: false, searchesBilled: 1, ...(requestId !== undefined ? { vendorRequestId: requestId } : {}) };
    // Inline: the first response already holds the overview.
    if (overview.text_blocks !== undefined) {
      return {
        answer: mapSerpAnswer({ text_blocks: overview.text_blocks, ...(overview.references !== undefined ? { references: overview.references } : {}) }),
        asyncGenerated: false,
        searchesBilled: 1,
        ...(requestId !== undefined ? { vendorRequestId: requestId } : {}),
      };
    }
    // Only a page_token. Without the async-load parameter this is the false absence NFR-SIM-11 exists to prevent.
    if (overview.page_token === undefined || !request.asyncLoad) throw this.malformed(engineKey);

    const followUp = await this.getJson(this.searchUrl({ engine: "google_ai_overview", page_token: overview.page_token }), signal, engineKey);
    const second = serpAiOverviewResponseSchema.safeParse(followUp);
    if (!second.success) throw this.malformed(engineKey);
    // An expired token or a vendor error is not evidence the query has no overview: fail retryably rather than store a false absence.
    if (second.data.error !== undefined || second.data.ai_overview === undefined) throw failure("timeout", engineKey);
    const followRequestId = second.data.search_metadata?.id ?? requestId;
    return {
      answer: mapSerpAnswer(second.data.ai_overview),
      asyncGenerated: true,
      searchesBilled: 2,
      ...(followRequestId !== undefined ? { vendorRequestId: followRequestId } : {}),
    };
  }

  /** The Account API: free, and proves the key and reachability without spending a search. */
  async healthProbe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const startedAt = performance.now();
    const elapsed = (): number => Math.max(0, Math.round(performance.now() - startedAt));
    try {
      const url = new URL("/account.json", BASE_URL);
      url.searchParams.set("api_key", this.config.apiKey);
      const response = await this.fetchFn(url, { method: "GET", signal: AbortSignal.timeout(15_000) });
      if (response.ok) return { ok: true, latencyMs: elapsed() };
      return { ok: false, latencyMs: elapsed(), detail: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, latencyMs: elapsed(), detail: `network failure (${error instanceof Error ? error.name : "error"})` };
    }
  }
}
