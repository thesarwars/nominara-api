import { Logger } from "@nestjs/common";
import { incrementCounter } from "../../telemetry/metrics.js";
import { BaseCaptureAdapter } from "../base-adapter.js";
import type { AnswerElement, CaptureContext, CaptureFlag, CaptureInput, CaptureMode, EngineKey } from "../contract.js";
import { CaptureFailureError } from "../failure-taxonomy.js";

// STORY-029 - the two licensed-data adapters (tracking-engine.md section 3: `google_aio`, `google_ai_mode`).
//
// ONE class, TWO instances. They differ in exactly one constructor argument: the surface, which is also the engine key. That key is
// the ENDPOINT the adapter calls; it is never read back out of a payload, because both surfaces return the same element shape and
// an adapter that inferred its engine from the response would label one surface as the other (AC2, the "integration rule").
//
// The vendor sits behind `LicensedSerpProvider`. Switching vendor is a new provider (its HTTP calls plus its response mapper)
// and one line where the provider is chosen (registry.ts) - see docs/licensed-serp-fallback.md. `adapterVersion` carries the
// provider's id and version so a mid-history switch is auditable rather than invisible (tracking-engine.md section 3).

const logger = new Logger("licensed-serp");

export type LicensedSurface = "google_aio" | "google_ai_mode";
/** `queued` for scheduled work, `live` for a person watching (tracking-engine.md section 3). Chosen by the caller, never by the adapter. */
export type LicensedRequestMode = "queued" | "live";

export interface LicensedLink {
  readonly url: string;
  readonly title?: string;
}
export interface LicensedReference extends LicensedLink {
  readonly index: number;
  readonly snippet?: string;
}
export interface LicensedProduct {
  readonly title?: string;
  readonly price?: string;
  readonly rating?: number;
  readonly reviewCount?: number;
  readonly image?: string;
  readonly link?: string;
}
export interface LicensedElement {
  readonly kind: "text" | "table" | "product";
  /** The element's words. The parser matches mentions against this, so it is never a label. */
  readonly text: string;
  /** This element's OWN references - what makes the citation gap passage-specific. */
  readonly links: readonly LicensedLink[];
  readonly product?: LicensedProduct;
  readonly spec?: Readonly<Record<string, string>>;
}
/** What every provider's mapper produces; the adapter turns it into a RawCapture and knows nothing about any vendor's JSON. */
export interface LicensedAnswer {
  readonly markdown: string;
  readonly elements: readonly LicensedElement[];
  readonly references: readonly LicensedReference[];
}
export interface LicensedFetchResult {
  /** `null` is a genuine absence: the request was sent correctly and Google showed no answer. */
  readonly answer: LicensedAnswer | null;
  /** `true`: generated on demand and loaded asynchronously. `false`: in the first response, or nothing. `null`: this surface reports no such flag. */
  readonly asyncGenerated: boolean | null;
  readonly searchesBilled: number;
  readonly vendorRequestId?: string;
}

export interface LicensedSerpRequest {
  readonly surface: LicensedSurface;
  readonly query: string;
  readonly locale: string;
  readonly mode: LicensedRequestMode;
  /** Which sample of the cell this is. A sample after the first is never allowed to be served from a vendor cache. */
  readonly sampleIndex: number;
  /** The async-load parameter (NFR-SIM-11). `false` is representable ONLY so the guard has something to refuse. */
  readonly asyncLoad: boolean;
}

export interface LicensedSerpProvider {
  /** Recorded in `adapterVersion`. */
  readonly id: string;
  readonly version: string;
  /**
   * `onSearchBilled` is called once per vendor search that was accepted and is billable, AT THE MOMENT it is, so that a capture which
   * then fails still reports what it spent (E2E-B6: a call the vendor billed is spend even when its answer is unusable).
   */
  fetchAnswer(request: LicensedSerpRequest, signal: AbortSignal, onSearchBilled?: () => void): Promise<LicensedFetchResult>;
  healthProbe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

/** Thrown BEFORE dispatch when a request lacks the async-load parameter: sent without it, an on-demand overview comes back as a null payload that looks exactly like "no AI Overview" (NFR-SIM-11). */
export class AsyncLoadMissingError extends Error {
  constructor(surface: LicensedSurface) {
    super(`${surface} request refused before dispatch: the async-load parameter is not set`);
    this.name = "AsyncLoadMissingError";
  }
}

export function assertAsyncLoad(request: LicensedSerpRequest): void {
  if (request.asyncLoad !== true) throw new AsyncLoadMissingError(request.surface);
}

/** The only constructor of a request the adapter sends. The parameter is set here, once, for both surfaces. */
export function buildLicensedRequest(surface: LicensedSurface, input: CaptureInput): LicensedSerpRequest {
  // A vendor cache answers a repeated request with the earlier response, so a sample after the first would be a byte-identical copy of
  // sample 0 stored as an independent observation. Independence outranks the caller's mode: samples after the first are always live.
  const mode: LicensedRequestMode = input.sampleIndex > 0 ? "live" : (input.requestMode ?? "queued");
  return { surface, query: input.promptText, locale: input.locale, mode, sampleIndex: input.sampleIndex, asyncLoad: true };
}

/**
 * Priced product elements exist on AI Mode and not on AI Overviews, where a price comparison renders as a paragraph
 * (tracking-engine.md section 3). Recorded as a fact about the surface so rendering quality is reported per engine and
 * the surface without them is never penalised for its format.
 */
export const PRICED_ELEMENTS_AVAILABLE: Readonly<Record<LicensedSurface, boolean>> = { google_ai_mode: true, google_aio: false };

export const LICENSED_SERP_ADAPTER_VERSION = "0.1.0";
/** SerpApi list price per search on the 5,000-a-month plan ($75). A cost is plan-dependent, so it is injectable; a pricing change is a methodology event. */
export const DEFAULT_COST_PER_SEARCH_USD = 0.015;

export interface LicensedSerpAdapterConfig {
  readonly provider: LicensedSerpProvider;
  /** Hard per-capture timeout, covering a queued read-back and the follow-up request; an elapsed timeout is classified `timeout`. */
  readonly timeoutMs: number;
  readonly costPerSearchUsd?: number;
}

function toElement(element: LicensedElement): AnswerElement {
  const links = element.links.map((link) => ({ url: link.url, ...(link.title !== undefined ? { title: link.title } : {}) }));
  if (element.kind === "product") {
    const product = element.product ?? {};
    return {
      kind: "shopping_element",
      links,
      description: product.title ?? element.text,
      ...(product.price !== undefined ? { price: product.price } : {}),
      ...(product.rating !== undefined ? { rating: product.rating } : {}),
      ...(product.reviewCount !== undefined ? { reviewCount: product.reviewCount } : {}),
      ...(product.image !== undefined ? { image: product.image } : {}),
      ...(product.link !== undefined ? { link: product.link } : {}),
    };
  }
  return {
    kind: element.kind === "table" ? "table_element" : "ai_overview_element",
    links,
    description: element.text,
    ...(element.spec !== undefined ? { spec: { ...element.spec } } : {}),
  };
}

/**
 * Owner decision 29 (2026-10-30): a queued SerpApi search may wait the 5 minutes tracking-engine.md section 3 allows.
 * The capture timeout is the ONLY bound on that wait (there is no separate job timeout: BullMQ renews the job lock while the worker
 * lives, the engine lease is a token bucket with no duration, and the stuck-run reaper's grace is 6 hours). It must cover the wait AND the
 * synchronous follow-up (and a stale-token live re-search) that come after it, or a search accepted and billed at minute 4:59 times out, the
 * retry submits again and pays twice. serp.spec.ts pins these relationships.
 */
export const SERP_QUEUED_WAIT_MS = 5 * 60_000;
/** Room after a full queued wait for the live follow-up and one stale-token re-search (live ~6 s each). */
export const SERP_FOLLOW_UP_HEADROOM_MS = 60_000;
export const SERP_CAPTURE_TIMEOUT_MS = SERP_QUEUED_WAIT_MS + SERP_FOLLOW_UP_HEADROOM_MS;

export class LicensedSerpAdapter extends BaseCaptureAdapter {
  readonly captureMode: CaptureMode = "licensed_serp";
  readonly supportsCitations = true;
  readonly concurrencyPerTask = 2;
  readonly pricedElementsAvailable: boolean;
  readonly adapterVersion: string;

  /** `engineKey` IS the surface: the endpoint this instance calls. */
  constructor(
    readonly engineKey: LicensedSurface & EngineKey,
    private readonly config: LicensedSerpAdapterConfig,
  ) {
    super();
    this.pricedElementsAvailable = PRICED_ELEMENTS_AVAILABLE[engineKey];
    // semver build metadata: still parses as 0.1.0 for the L1 key's major (adapterMajorOf), and names the vendor.
    this.adapterVersion = `${LICENSED_SERP_ADAPTER_VERSION}+${config.provider.id}.${config.provider.version}`;
  }

  /** Guard + vendor call. Rejects with AsyncLoadMissingError, before the provider is touched, on a request without the async-load parameter. */
  async dispatch(request: LicensedSerpRequest, ctx: CaptureContext): Promise<LicensedFetchResult> {
    assertAsyncLoad(request);

    const timeout = new AbortController();
    let billed = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeout.abort(new Error("licensed-serp capture timeout"));
    }, this.config.timeoutMs);
    try {
      return await this.config.provider.fetchAnswer(request, AbortSignal.any([ctx.signal, timeout.signal]), () => {
        billed += 1;
      });
    } catch (error) {
      // E2E-B6: searches the vendor already billed are spend even though the capture fails. Metered here, before the rethrow, so the
      // spend meter and its ceiling see them. A failing meter must not mask the capture's own failure.
      if (billed > 0) {
        try {
          await ctx.recordCost(billed * (this.config.costPerSearchUsd ?? DEFAULT_COST_PER_SEARCH_USD));
        } catch {
          logger.warn({ event: "capture.serp.failure_cost_unrecorded", engine_key: this.engineKey, searches_billed: billed });
        }
      }
      if (error instanceof CaptureFailureError) throw error;
      if (timedOut) throw new CaptureFailureError("timeout", this.engineKey);
      throw error; // caller-initiated abort or an unclassifiable transport fault: never swallowed
    } finally {
      clearTimeout(timer);
    }
  }

  protected async fetchVendorResponse(input: CaptureInput, ctx: CaptureContext): Promise<unknown> {
    const request = buildLicensedRequest(this.engineKey, input);
    const startedAt = performance.now();
    const result = await this.dispatch(request, ctx);
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));

    const answer = result.answer;
    const text = answer?.markdown ?? "";
    const flags: CaptureFlag[] = [];
    // NFR-SIM-12: reaching here means the request carried the parameter (dispatch refuses otherwise), so an absence is genuine.
    if (answer === null) flags.push(this.engineKey === "google_aio" ? "no_ai_overview_for_query" : "empty_answer");
    else if (text === "") flags.push("empty_answer");

    const costUsd = result.searchesBilled * (this.config.costPerSearchUsd ?? DEFAULT_COST_PER_SEARCH_USD);

    ctx.span.setAttribute("engine.key", this.engineKey);
    ctx.span.setAttribute("engine.latency_ms", latencyMs);
    ctx.span.setAttribute("engine.provider", `${this.config.provider.id}.${this.config.provider.version}`);
    ctx.span.setAttribute("serp.mode", request.mode);
    ctx.span.setAttribute("serp.searches_billed", result.searchesBilled);
    if (result.asyncGenerated !== null) ctx.span.setAttribute("serp.async_generated", result.asyncGenerated);

    incrementCounter("nominara_capture_serp_searches_total", { engine_key: this.engineKey, mode: request.mode });
    if (result.asyncGenerated !== null) {
      incrementCounter("nominara_capture_async_generated_total", { engine_key: this.engineKey, async_generated: String(result.asyncGenerated) });
    }
    // Counts and flags only: never the prompt, the answer text, or the vendor URL (which carries the key).
    logger.log({
      event: "capture.serp.completed",
      engine_key: this.engineKey,
      mode: request.mode,
      async_generated: result.asyncGenerated,
      searches_billed: result.searchesBilled,
      answered: answer !== null && text !== "",
      latency_ms: latencyMs,
    });

    return {
      text,
      format: "markdown",
      ...(answer !== null && answer.references.length > 0
        ? {
            structuredCitations: answer.references.map((reference, position) => ({
              url: reference.url,
              ...(reference.title !== undefined ? { title: reference.title } : {}),
              ...(reference.snippet !== undefined ? { snippet: reference.snippet } : {}),
              slot: position + 1,
            })),
          }
        : {}),
      ...(answer !== null && answer.elements.length > 0 ? { structuredElements: answer.elements.map(toElement) } : {}),
      truncated: false,
      responseTokensEst: Math.ceil(text.length / 4),
      latencyMs,
      ...(result.vendorRequestId !== undefined ? { vendorRequestId: result.vendorRequestId } : {}),
      costUsd,
      ...(flags.length > 0 ? { flags } : {}),
      asyncGenerated: result.asyncGenerated,
    };
  }

  healthProbe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    return this.config.provider.healthProbe();
  }
}
