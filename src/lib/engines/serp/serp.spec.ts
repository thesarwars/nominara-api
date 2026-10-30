import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../telemetry/metrics.js", () => ({ incrementCounter: vi.fn(), observeValue: vi.fn() }));

import { incrementCounter } from "../../telemetry/metrics.js";
import { rawCaptureSchema, type CaptureContext, type CaptureInput } from "../contract.js";
import { CaptureFailureError } from "../failure-taxonomy.js";
import {
  aiModePriced,
  aiModeQueuedResult,
  aiModeSubmitProcessing,
  aioAbsent,
  aioDeferred,
  aioFollowUp,
  errorBody,
  malformedBody,
} from "./fixtures/serp-recorded.js";
import {
  AsyncLoadMissingError,
  buildLicensedRequest,
  LicensedSerpAdapter,
  type LicensedFetchResult,
  type LicensedSerpProvider,
  type LicensedSerpRequest,
} from "./licensed-serp.js";
import { SerpApiProvider } from "./serpapi-provider.js";

// STORY-029 - the scenarios table, one test per row, named with the row. Every body below is a RECORDED SerpApi response
// (fixtures/serp-recorded.ts) or says it is hand-built. No test touches the network: fetch is always injected.
// Scenario 1's live half is serp.live.spec.ts (opt-in, SERP_LIVE=1).

const FAKE_KEY = "test-key-not-a-secret-0000";
const input: CaptureInput = { promptText: "how to choose a CRM for a small business", locale: "en-US", sampleIndex: 0, requireCitations: true };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeCtx() {
  const recordCost = vi.fn();
  const span = { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() };
  const ctx: CaptureContext = { signal: new AbortController().signal, span, recordCost };
  return { ctx, recordCost, span };
}

/** A fetch that answers with `bodies` in order and remembers every URL it was asked for. */
function fetchSequence(...bodies: readonly (unknown | { status: number; body: unknown })[]) {
  const urls: URL[] = [];
  let next = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    urls.push(new URL(String(url)));
    const item = bodies[Math.min(next, bodies.length - 1)];
    next += 1;
    if (typeof item === "object" && item !== null && "status" in item && "body" in item) {
      const typed = item as { status: number; body: unknown };
      return jsonResponse(typed.body, typed.status);
    }
    return jsonResponse(item);
  });
  return { fetchImpl, urls };
}

function serpProvider(fetchImpl: typeof fetch) {
  return new SerpApiProvider({ apiKey: FAKE_KEY, fetchImpl, pollIntervalMs: 1, sleep: async () => undefined });
}

function adapterFor(surface: "google_aio" | "google_ai_mode", fetchImpl: typeof fetch) {
  return new LicensedSerpAdapter(surface, { provider: serpProvider(fetchImpl), timeoutMs: 5000 });
}

// What the fixtures say, read straight off the recorded JSON (not through the mapper) so the expectations do not inherit its blind spots.
const followUpOverview = (aioFollowUp as { ai_overview: { text_blocks: Block[]; references: Ref[] } }).ai_overview;
interface Block {
  type: string;
  snippet?: string;
  reference_indexes?: number[];
  list?: Block[];
  text_blocks?: Block[];
}
interface Ref {
  index: number;
  link: string;
  title: string;
}

beforeEach(() => {
  vi.mocked(incrementCounter).mockClear();
});

describe("STORY-029 · scenario 1 · a recorded call per surface gives a valid capture with references and typed elements", () => {
  it("google_ai_mode: text, answer-level references, text/table/shopping elements, one search billed", async () => {
    const { fetchImpl } = fetchSequence(aiModePriced);
    const { ctx, recordCost } = makeCtx();
    const raw = await adapterFor("google_ai_mode", fetchImpl).capture({ ...input, requestMode: "live" }, ctx);

    expect(rawCaptureSchema.safeParse(raw).success).toBe(true);
    expect(raw.text.length).toBeGreaterThan(100);
    expect((raw.structuredCitations ?? []).length).toBe((aiModePriced as { references: unknown[] }).references.length);
    expect(raw.structuredCitations?.[0]?.slot).toBe(1);
    const kinds = new Set((raw.structuredElements ?? []).map((element) => element.kind));
    expect(kinds).toEqual(new Set(["ai_overview_element", "table_element", "shopping_element"]));
    expect(raw.latencyMs).toBeGreaterThanOrEqual(1);
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(raw.costUsd).toBeCloseTo(0.015, 6);
  });

  it("google_aio: the deferred overview is loaded through its page_token, billed as two searches", async () => {
    const { fetchImpl, urls } = fetchSequence(aioDeferred, aioFollowUp);
    const { ctx } = makeCtx();
    const raw = await adapterFor("google_aio", fetchImpl).capture({ ...input, requestMode: "live" }, ctx);

    expect(rawCaptureSchema.safeParse(raw).success).toBe(true);
    expect(raw.text).toContain(followUpOverview.text_blocks.find((b) => b.type === "heading")?.snippet);
    expect((raw.structuredCitations ?? []).length).toBe(followUpOverview.references.length);
    expect((raw.structuredElements ?? []).length).toBeGreaterThan(3);
    expect(urls.map((url) => url.searchParams.get("engine"))).toEqual(["google", "google_ai_overview"]);
    expect(raw.costUsd).toBeCloseTo(0.03, 6);
  });
});

describe("STORY-029 · scenario 2 · feeding one payload to both adapters stores two different engine keys", () => {
  it("the engine key is the adapter's endpoint, never a field of the payload", async () => {
    const sharedAnswer: LicensedFetchResult = {
      answer: { markdown: "same words", elements: [{ kind: "text", text: "same words", links: [] }], references: [] },
      asyncGenerated: null,
      searchesBilled: 1,
    };
    const seen: LicensedSerpRequest[] = [];
    const provider: LicensedSerpProvider = {
      id: "stub",
      version: "1",
      fetchAnswer: async (request) => {
        seen.push(request);
        return sharedAnswer;
      },
      healthProbe: async () => ({ ok: true, latencyMs: 1 }),
    };
    const aio = new LicensedSerpAdapter("google_aio", { provider, timeoutMs: 1000 });
    const mode = new LicensedSerpAdapter("google_ai_mode", { provider, timeoutMs: 1000 });
    await aio.capture(input, makeCtx().ctx);
    await mode.capture(input, makeCtx().ctx);

    expect(aio.engineKey).toBe("google_aio");
    expect(mode.engineKey).toBe("google_ai_mode");
    expect(seen.map((request) => request.surface)).toEqual(["google_aio", "google_ai_mode"]);
  });

  it("the real provider calls a different vendor endpoint per surface", async () => {
    const aiModeFetch = fetchSequence(aiModeQueuedResult);
    await adapterFor("google_ai_mode", aiModeFetch.fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    const aioFetch = fetchSequence(aioAbsent);
    await adapterFor("google_aio", aioFetch.fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);

    expect(aiModeFetch.urls[0]?.searchParams.get("engine")).toBe("google_ai_mode");
    expect(aioFetch.urls[0]?.searchParams.get("engine")).toBe("google");
  });
});

describe("STORY-029 · scenario 3 · a request without the async-load parameter is refused before dispatch", () => {
  it("the adapter's dispatch throws AsyncLoadMissingError and the vendor is never called", async () => {
    const { fetchImpl } = fetchSequence(aioDeferred, aioFollowUp);
    const adapter = adapterFor("google_aio", fetchImpl);
    const unsafe: LicensedSerpRequest = { ...buildLicensedRequest("google_aio", input), asyncLoad: false };

    await expect(adapter.dispatch(unsafe, makeCtx().ctx)).rejects.toBeInstanceOf(AsyncLoadMissingError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("every request the adapter builds itself carries the parameter, for both surfaces", () => {
    expect(buildLicensedRequest("google_aio", input).asyncLoad).toBe(true);
    expect(buildLicensedRequest("google_ai_mode", input).asyncLoad).toBe(true);
  });

  it("the guard also holds for google_ai_mode", async () => {
    const { fetchImpl } = fetchSequence(aiModePriced);
    const adapter = adapterFor("google_ai_mode", fetchImpl);
    const unsafe: LicensedSerpRequest = { ...buildLicensedRequest("google_ai_mode", input), asyncLoad: false };
    await expect(adapter.dispatch(unsafe, makeCtx().ctx)).rejects.toBeInstanceOf(AsyncLoadMissingError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("STORY-029 · scenario 4 · a null payload WITH the parameter is a genuine absence", () => {
  it("no ai_overview in the response: stored as no answer, flagged, async flag false", async () => {
    const { fetchImpl, urls } = fetchSequence(aioAbsent);
    const { ctx, recordCost } = makeCtx();
    const raw = await adapterFor("google_aio", fetchImpl).capture({ ...input, requestMode: "live" }, ctx);

    expect(rawCaptureSchema.safeParse(raw).success).toBe(true);
    expect(raw.text).toBe("");
    expect(raw.flags).toEqual(["no_ai_overview_for_query"]);
    expect(raw.asyncGenerated).toBe(false);
    expect(raw.structuredCitations ?? []).toEqual([]);
    expect(urls).toHaveLength(1);
    expect(recordCost).toHaveBeenCalledWith(0.015);
  });

  it("an AI Mode answer with no text blocks is a successful-but-empty answer, not an error", async () => {
    const empty = { search_metadata: { status: "Success" }, text_blocks: [], references: [] };
    const raw = await adapterFor("google_ai_mode", fetchSequence(empty).fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    expect(raw.text).toBe("");
    expect(raw.flags).toEqual(["empty_answer"]);
    expect(raw.asyncGenerated).toBeNull();
  });
});

describe("STORY-029 · scenario 5 · a null payload WITHOUT the parameter fails the capture and stores nothing", () => {
  it("the deferred overview read without following it is malformed_response, never an absence", async () => {
    const { fetchImpl } = fetchSequence(aioDeferred);
    const provider = serpProvider(fetchImpl);
    const request: LicensedSerpRequest = { ...buildLicensedRequest("google_aio", input), mode: "live", asyncLoad: false };

    const outcome = await provider.fetchAnswer(request, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(CaptureFailureError);
    expect((outcome as CaptureFailureError).code).toBe("malformed_response");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("with the parameter the SAME deferred response is loaded, so the false absence cannot be stored", async () => {
    const { fetchImpl } = fetchSequence(aioDeferred, aioFollowUp);
    const raw = await adapterFor("google_aio", fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    expect(raw.text.length).toBeGreaterThan(0);
    expect(raw.flags ?? []).not.toContain("no_ai_overview_for_query");
    expect(raw.asyncGenerated).toBe(true);
  });

  it("a page_token that has expired fails retryably instead of recording an absence", async () => {
    const { fetchImpl } = fetchSequence(aioDeferred, { status: 200, body: errorBody });
    const outcome = await adapterFor("google_aio", fetchImpl)
      .capture({ ...input, requestMode: "live" }, makeCtx().ctx)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(CaptureFailureError);
    expect((outcome as CaptureFailureError).code).toBe("timeout");
  });
});

describe("STORY-029 · scenario 6 · answer-level and per-element references are both extracted and associated", () => {
  it("google_aio: each element carries the links its reference_indexes name; the answer carries every reference", async () => {
    const { fetchImpl } = fetchSequence(aioDeferred, aioFollowUp);
    const raw = await adapterFor("google_aio", fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);

    const byIndex = new Map(followUpOverview.references.map((ref) => [ref.index, ref.link]));
    const cited = followUpOverview.text_blocks.find((block) => block.type === "paragraph" && (block.reference_indexes ?? []).length > 0);
    expect(cited?.snippet).toBeDefined();
    const element = (raw.structuredElements ?? []).find((candidate) => candidate.description?.includes(cited?.snippet ?? "\u0000"));
    expect(element).toBeDefined();
    expect(element?.links.map((link) => link.url)).toEqual((cited?.reference_indexes ?? []).map((index) => byIndex.get(index)));

    const urls = (raw.structuredCitations ?? []).map((citation) => citation.url);
    expect(urls).toEqual(followUpOverview.references.map((ref) => ref.link));
    const heading = (raw.structuredElements ?? []).find((candidate) => candidate.description === "Step 1: Identify Your Core Business Model");
    expect(heading?.links).toEqual([]);
  });

  it("google_ai_mode: a list item's references attach to that item, not to its neighbours", async () => {
    const { fetchImpl } = fetchSequence(aiModeQueuedResult);
    const raw = await adapterFor("google_ai_mode", fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    const reference = (aiModeQueuedResult as { references: Ref[] }).references[0]!;
    const attio = (raw.structuredElements ?? []).find((element) => element.description?.startsWith("Attio"));
    const hubspot = (raw.structuredElements ?? []).find((element) => element.description?.startsWith("HubSpot"));
    expect(attio?.links.map((link) => link.url)).toEqual([reference.link]);
    expect(hubspot?.links).toEqual([]);
  });
});

describe("STORY-029 · scenario 7 · priced elements keep their attributes and are marked surface-specific", () => {
  it("a shopping element carries price, rating, review count, image and link", async () => {
    const raw = await adapterFor("google_ai_mode", fetchSequence(aiModePriced).fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    const soundcore = (raw.structuredElements ?? []).find((element) => element.kind === "shopping_element" && element.description?.includes("Soundcore Life Q30"));
    expect(soundcore).toMatchObject({ kind: "shopping_element", price: "$85.99", rating: 4.6, reviewCount: 2200 });
    expect(soundcore?.link).toMatch(/^https:\/\/www\.google\.com\/search\?ibp=oshop/);
    expect(soundcore?.image).toMatch(/^https:\/\//);
  });

  it("priced elements are recorded as available on google_ai_mode only", () => {
    const provider = serpProvider(fetchSequence({}).fetchImpl);
    expect(new LicensedSerpAdapter("google_ai_mode", { provider, timeoutMs: 1 }).pricedElementsAvailable).toBe(true);
    expect(new LicensedSerpAdapter("google_aio", { provider, timeoutMs: 1 }).pricedElementsAvailable).toBe(false);
  });
});

describe("STORY-029 · the shared mapper's text", () => {
  it("a table element keeps its words and loses the vendor's viewer boilerplate that would glue onto a product name", async () => {
    const raw = await adapterFor("google_ai_mode", fetchSequence(aiModePriced).fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    const table = (raw.structuredElements ?? []).find((element) => element.kind === "table_element");
    expect(table?.description).toContain("Soundcore Life Q30 by Anker |");
    expect(raw.text).not.toContain("product viewer dialog");
    expect(table?.description).not.toContain("product viewer dialog");
  });

  it("a comparison block (the AI Overview product comparison) becomes a table element with its features as spec", async () => {
    const body = {
      search_metadata: { status: "Success" },
      ai_overview: {
        text_blocks: [{ type: "comparison", product_labels: ["Pixel 9", "Pixel 8"], comparison: [{ feature: "Weight", values: ["7 oz", "6.6 oz"] }] }],
        references: [],
      },
    };
    const raw = await adapterFor("google_aio", fetchSequence(body).fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    expect(raw.structuredElements?.[0]).toMatchObject({ kind: "table_element", spec: { Weight: "7 oz | 6.6 oz" } });
  });

  it("a reference index the vendor names but does not return is dropped, not invented", async () => {
    const body = { search_metadata: { status: "Success" }, text_blocks: [{ type: "paragraph", snippet: "Words.", reference_indexes: [0, 9] }], references: [{ index: 0, link: "https://example.com/x", title: "X" }] };
    const raw = await adapterFor("google_ai_mode", fetchSequence(body).fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    expect(raw.structuredElements?.[0]?.links).toEqual([{ url: "https://example.com/x", title: "X" }]);
  });
});

describe("STORY-029 · scenario 8 · queued and live modes both work, and the caller picks", () => {
  it("live: one synchronous search that bypasses the vendor cache", async () => {
    const { fetchImpl, urls } = fetchSequence(aiModeQueuedResult);
    await adapterFor("google_ai_mode", fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.get("no_cache")).toBe("true");
    expect(urls[0]?.searchParams.has("async")).toBe(false);
  });

  it("queued: submitted with async=true (and no no_cache, which the vendor forbids alongside it), then read back until it finishes", async () => {
    const { fetchImpl, urls } = fetchSequence(aiModeSubmitProcessing, aiModeSubmitProcessing, aiModeQueuedResult);
    const raw = await adapterFor("google_ai_mode", fetchImpl).capture({ ...input, requestMode: "queued" }, makeCtx().ctx);
    expect(urls[0]?.searchParams.get("async")).toBe("true");
    expect(urls[0]?.searchParams.has("no_cache")).toBe(false);
    expect(urls.slice(1).map((url) => url.pathname)).toEqual(["/searches/recorded-search-id.json", "/searches/recorded-search-id.json"]);
    expect(raw.text.length).toBeGreaterThan(0);
  });

  it("with no requestMode the caller has not chosen, and scheduled work is the default: queued", async () => {
    const { fetchImpl, urls } = fetchSequence(aiModeQueuedResult);
    await adapterFor("google_ai_mode", fetchImpl).capture(input, makeCtx().ctx);
    expect(urls[0]?.searchParams.get("async")).toBe("true");
  });

  it("a queued search that never finishes is a timeout, not a hang", async () => {
    const { fetchImpl } = fetchSequence(aiModeSubmitProcessing);
    const adapter = new LicensedSerpAdapter("google_ai_mode", {
      provider: new SerpApiProvider({ apiKey: FAKE_KEY, fetchImpl, pollIntervalMs: 5, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }),
      timeoutMs: 40,
    });
    const outcome = await adapter.capture({ ...input, requestMode: "queued" }, makeCtx().ctx).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((outcome as CaptureFailureError).code).toBe("timeout");
  });
});

describe("STORY-029 · scenario 9 · a malformed payload is classified malformed and no row results", () => {
  it("a structurally wrong body rejects with malformed_response and counts it", async () => {
    const outcome = await adapterFor("google_ai_mode", fetchSequence(malformedBody).fetchImpl)
      .capture({ ...input, requestMode: "live" }, makeCtx().ctx)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(CaptureFailureError);
    expect((outcome as CaptureFailureError).code).toBe("malformed_response");
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_capture_malformed_response_total", expect.objectContaining({ engine_key: "google_ai_mode" }));
  });

  it("a body that is not JSON at all is malformed_response too", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("<html>gateway</html>", { status: 200 }));
    const outcome = await adapterFor("google_aio", fetchImpl)
      .capture({ ...input, requestMode: "live" }, makeCtx().ctx)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((outcome as CaptureFailureError).code).toBe("malformed_response");
  });

  it("a vendor error string on a 200 is a retryable upstream failure, never an answer", async () => {
    // Hand-built: a generic vendor fault. (The "no results" message is NOT a fault - see the review-round-1 block below.)
    const outcome = await adapterFor("google_ai_mode", fetchSequence({ search_metadata: { status: "Error" }, error: "Internal error, please retry." }).fetchImpl)
      .capture({ ...input, requestMode: "live" }, makeCtx().ctx)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((outcome as CaptureFailureError).code).toBe("upstream_5xx");
  });
});

describe("STORY-029 · scenario 10 · swapping the provider keeps captures flowing and records which one produced them", () => {
  const fallback: LicensedSerpProvider = {
    id: "fallback",
    version: "7",
    fetchAnswer: async () => ({
      answer: { markdown: "A fallback answer.", elements: [{ kind: "text", text: "A fallback answer.", links: [{ url: "https://example.com/a" }] }], references: [{ index: 0, url: "https://example.com/a", title: "A" }] },
      asyncGenerated: true,
      searchesBilled: 1,
    }),
    healthProbe: async () => ({ ok: true, latencyMs: 1 }),
  };

  it("the adapter version carries the provider and its version; the interface is unchanged", async () => {
    const swapped = new LicensedSerpAdapter("google_aio", { provider: fallback, timeoutMs: 1000 });
    const original = adapterFor("google_aio", fetchSequence({}).fetchImpl);
    expect(swapped.adapterVersion).toBe("0.1.0+fallback.7");
    expect(original.adapterVersion).toBe("0.1.0+serpapi.1");

    const raw = await swapped.capture(input, makeCtx().ctx);
    expect(rawCaptureSchema.safeParse(raw).success).toBe(true);
    expect(raw.text).toBe("A fallback answer.");
    expect(raw.asyncGenerated).toBe(true);
  });

  it("the adapter version stays parseable as semver by the L1 cache key", async () => {
    const { adapterMajorOf } = await import("../../capture/l1-exact-hash.js");
    expect(adapterMajorOf(new LicensedSerpAdapter("google_aio", { provider: fallback, timeoutMs: 1 }).adapterVersion)).toBe(0);
  });
});

describe("STORY-029 · the async flag is persisted from the response, per surface", () => {
  it("google_aio served inline: false; served on demand: true", async () => {
    const inline = { search_metadata: { status: "Success" }, ai_overview: (aioFollowUp as { ai_overview: unknown }).ai_overview };
    const first = await adapterFor("google_aio", fetchSequence(inline).fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    const deferred = await adapterFor("google_aio", fetchSequence(aioDeferred, aioFollowUp).fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    expect(first.asyncGenerated).toBe(false);
    expect(deferred.asyncGenerated).toBe(true);
  });

  it("google_ai_mode: the surface reports no such flag, so it is null, not false", async () => {
    const raw = await adapterFor("google_ai_mode", fetchSequence(aiModePriced).fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    expect(raw.asyncGenerated).toBeNull();
  });

  it("the on-demand share is counted per engine (NFR-SIM-13)", async () => {
    await adapterFor("google_aio", fetchSequence(aioDeferred, aioFollowUp).fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx);
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_capture_async_generated_total", { engine_key: "google_aio", async_generated: "true" });
  });
});

describe("STORY-029 · failure classification and credential hygiene", () => {
  it.each([
    [401, "auth_failed"],
    [403, "auth_failed"],
    [429, "rate_limited"],
    [500, "upstream_5xx"],
    [503, "upstream_5xx"],
  ] as const)("HTTP %i is %s", async (status, code) => {
    const fetchImpl = fetchSequence({ status, body: { error: "nope" } }).fetchImpl;
    const outcome = await adapterFor("google_ai_mode", fetchImpl)
      .capture({ ...input, requestMode: "live" }, makeCtx().ctx)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((outcome as CaptureFailureError).code).toBe(code);
  });

  it("an exhausted plan is quota_exhausted, distinct from a throttle", async () => {
    const fetchImpl = fetchSequence({ status: 429, body: { error: "Your account has run out of searches." } }).fetchImpl;
    const outcome = await adapterFor("google_aio", fetchImpl)
      .capture({ ...input, requestMode: "live" }, makeCtx().ctx)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((outcome as CaptureFailureError).code).toBe("quota_exhausted");
  });

  it("the key goes to the vendor as api_key and appears in no error, probe detail or span attribute", async () => {
    const { fetchImpl, urls } = fetchSequence({ status: 401, body: { error: "Invalid API key" } });
    const { ctx, span } = makeCtx();
    const outcome = await adapterFor("google_ai_mode", fetchImpl).capture({ ...input, requestMode: "live" }, ctx).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(urls[0]?.searchParams.get("api_key")).toBe(FAKE_KEY);
    expect(String((outcome as Error).message)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(span.setAttribute.mock.calls)).not.toContain(FAKE_KEY);

    const probe = await serpProvider(fetchSequence({ status: 401, body: { error: `Invalid API key ${FAKE_KEY}` } }).fetchImpl).healthProbe();
    expect(probe.ok).toBe(false);
    expect(JSON.stringify(probe)).not.toContain(FAKE_KEY);
  });

  it("the health probe uses the free account endpoint, not a search", async () => {
    const { fetchImpl, urls } = fetchSequence({ account_email: "redacted", plan_searches_left: 3 });
    const probe = await serpProvider(fetchImpl).healthProbe();
    expect(probe.ok).toBe(true);
    expect(urls[0]?.pathname).toBe("/account.json");
  });

  it("the recorded fixtures hold no credential, search id or account address", () => {
    const all = JSON.stringify([aiModePriced, aiModeQueuedResult, aiModeSubmitProcessing, aioDeferred, aioFollowUp, aioAbsent]);
    expect(all).not.toMatch(/api_key=(?!REDACTED)/);
    expect(all).not.toMatch(/serpapi\.com\/searches\/(?!REDACTED)[0-9a-f]{8,}/);
    expect(all).not.toMatch(/"search_(id|parameters)"/);
    expect(all).not.toMatch(/@gmail\.com/);
  });
});

// ---- Review round 1 · written from the hazards, before the fixes ----
const vendorFault = { search_metadata: { status: "Error" }, error: "Internal error, please retry." };
const settle = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe("STORY-029 review 1 · a vendor-cached response can never stand in for an independent sample or a fresh page_token", () => {
  it("sample 1+ is always fetched live (no_cache) even when the caller asked for queued", async () => {
    const { fetchImpl, urls } = fetchSequence(aiModeQueuedResult);
    await adapterFor("google_ai_mode", fetchImpl).capture({ ...input, sampleIndex: 1, requestMode: "queued" }, makeCtx().ctx);
    expect(urls[0]?.searchParams.get("no_cache")).toBe("true");
    expect(urls[0]?.searchParams.has("async")).toBe(false);
  });

  it("sample 1+ with no requestMode is live too; sample 0 keeps the queued default", async () => {
    const one = fetchSequence(aiModeQueuedResult);
    await adapterFor("google_ai_mode", one.fetchImpl).capture({ ...input, sampleIndex: 2 }, makeCtx().ctx);
    expect(one.urls[0]?.searchParams.get("no_cache")).toBe("true");
    const zero = fetchSequence(aiModeQueuedResult);
    await adapterFor("google_ai_mode", zero.fetchImpl).capture({ ...input, sampleIndex: 0 }, makeCtx().ctx);
    expect(zero.urls[0]?.searchParams.get("async")).toBe("true");
  });

  it("a queued organic body whose page_token is stale is re-fetched live and followed at once, not retried against the cache", async () => {
    // submit (cached body, stale token) -> follow-up fails -> fresh no_cache search -> its token -> follow-up succeeds
    const { fetchImpl, urls } = fetchSequence(aioDeferred, { status: 200, body: vendorFault }, aioDeferred, aioFollowUp);
    const raw = await adapterFor("google_aio", fetchImpl).capture({ ...input, requestMode: "queued" }, makeCtx().ctx);
    expect(urls.map((url) => url.searchParams.get("engine"))).toEqual(["google", "google_ai_overview", "google", "google_ai_overview"]);
    expect(urls[0]?.searchParams.get("async")).toBe("true");
    expect(urls[2]?.searchParams.get("no_cache")).toBe("true");
    expect(urls[2]?.searchParams.has("async")).toBe(false);
    expect(raw.text.length).toBeGreaterThan(0);
    expect(raw.asyncGenerated).toBe(true);
  });

  it.each([400, 404, 410])("a queued stale token refused with HTTP %i is re-searched live, not failed terminally", async (status) => {
    const { fetchImpl, urls } = fetchSequence(aioDeferred, { status, body: { error: "expired" } }, aioDeferred, aioFollowUp);
    const raw = await adapterFor("google_aio", fetchImpl).capture({ ...input, requestMode: "queued" }, makeCtx().ctx);
    expect(urls[2]?.searchParams.get("no_cache")).toBe("true");
    expect(raw.asyncGenerated).toBe(true);
  });

  it("a follow-up refused with HTTP 401 stays auth_failed, never re-searched", async () => {
    const { fetchImpl, urls } = fetchSequence(aioDeferred, { status: 401, body: { error: "bad key" } });
    const outcome = await settle(adapterFor("google_aio", fetchImpl).capture({ ...input, requestMode: "queued" }, makeCtx().ctx));
    expect((outcome as CaptureFailureError).code).toBe("auth_failed");
    expect(urls).toHaveLength(2);
  });

  it("the fresh re-fetch happens once: a second failed follow-up is a retryable timeout", async () => {
    const { fetchImpl, urls } = fetchSequence(aioDeferred, { status: 200, body: vendorFault }, aioDeferred, { status: 200, body: vendorFault });
    const outcome = await settle(adapterFor("google_aio", fetchImpl).capture({ ...input, requestMode: "queued" }, makeCtx().ctx));
    expect((outcome as CaptureFailureError).code).toBe("timeout");
    expect(urls).toHaveLength(4);
  });
});

describe("STORY-029 review 1 · a search the vendor billed is metered even when the capture then fails (E2E-B6)", () => {
  it("a malformed completed search records one search", async () => {
    const { ctx, recordCost } = makeCtx();
    const outcome = await settle(adapterFor("google_ai_mode", fetchSequence(malformedBody).fetchImpl).capture({ ...input, requestMode: "live" }, ctx));
    expect((outcome as CaptureFailureError).code).toBe("malformed_response");
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(0.015);
  });

  it("a malformed organic body on google_aio records one search", async () => {
    const { ctx, recordCost } = makeCtx();
    await settle(adapterFor("google_aio", fetchSequence({ search_metadata: { status: "Success" }, ai_overview: { text_blocks: "x" } }).fetchImpl).capture({ ...input, requestMode: "live" }, ctx));
    expect(recordCost).toHaveBeenCalledWith(0.015);
  });

  it("a billed first search followed by a failed token follow-up records the first search", async () => {
    const { ctx, recordCost } = makeCtx();
    const outcome = await settle(adapterFor("google_aio", fetchSequence(aioDeferred, { status: 200, body: vendorFault }).fetchImpl).capture({ ...input, requestMode: "live" }, ctx));
    expect((outcome as CaptureFailureError).code).toBe("timeout");
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(0.015);
  });

  it("an HTTP error response is not a billed search: nothing is recorded", async () => {
    const { ctx, recordCost } = makeCtx();
    await settle(adapterFor("google_ai_mode", fetchSequence({ status: 500, body: { error: "x" } }).fetchImpl).capture({ ...input, requestMode: "live" }, ctx));
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("a queued submit accepted and then timed out is metered", async () => {
    const { fetchImpl } = fetchSequence(aiModeSubmitProcessing);
    const adapter = new LicensedSerpAdapter("google_ai_mode", {
      provider: new SerpApiProvider({ apiKey: FAKE_KEY, fetchImpl, pollIntervalMs: 5, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }),
      timeoutMs: 40,
    });
    const { ctx, recordCost } = makeCtx();
    const outcome = await settle(adapter.capture({ ...input, requestMode: "queued" }, ctx));
    expect((outcome as CaptureFailureError).code).toBe("timeout");
    expect(recordCost).toHaveBeenCalledWith(0.015);
  });

  it("the stale-token recovery bills every completed search it made (3), once, on success", async () => {
    const { fetchImpl } = fetchSequence(aioDeferred, { status: 200, body: vendorFault }, aioDeferred, aioFollowUp);
    const { ctx, recordCost } = makeCtx();
    await adapterFor("google_aio", fetchImpl).capture({ ...input, requestMode: "queued" }, ctx);
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost.mock.calls[0]?.[0]).toBeCloseTo(0.045, 10);
  });
});

describe("STORY-029 review 1 · the vendor's no-results message is a genuine absence, other errors stay retryable", () => {
  it("google_aio: no results is no_ai_overview_for_query, async false, nothing billed", async () => {
    const { ctx, recordCost } = makeCtx();
    const raw = await adapterFor("google_aio", fetchSequence(errorBody).fetchImpl).capture({ ...input, requestMode: "live" }, ctx);
    expect(raw.text).toBe("");
    expect(raw.flags).toEqual(["no_ai_overview_for_query"]);
    expect(raw.asyncGenerated).toBe(false);
    expect(recordCost).toHaveBeenCalledWith(0);
  });

  it("google_ai_mode: no results is a terminal malformed_response under its own counter label, and no row is stored", async () => {
    const { ctx, recordCost } = makeCtx();
    const outcome = await settle(adapterFor("google_ai_mode", fetchSequence(errorBody).fetchImpl).capture({ ...input, requestMode: "live" }, ctx));
    expect((outcome as CaptureFailureError).code).toBe("malformed_response");
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_capture_malformed_response_total", expect.objectContaining({ engine_key: "google_ai_mode", reason: "no_results" }));
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("queued google_aio: a search that finishes with no results is not billed, same as live", async () => {
    const { ctx, recordCost } = makeCtx();
    const raw = await adapterFor("google_aio", fetchSequence(aiModeSubmitProcessing, errorBody).fetchImpl).capture({ ...input, requestMode: "queued" }, ctx);
    expect(raw.flags).toEqual(["no_ai_overview_for_query"]);
    expect(raw.costUsd).toBe(0);
    expect(recordCost).toHaveBeenCalledWith(0);
  });

  it("queued google_ai_mode: no results fails terminally and nothing is metered", async () => {
    const { ctx, recordCost } = makeCtx();
    const outcome = await settle(adapterFor("google_ai_mode", fetchSequence(aiModeSubmitProcessing, errorBody).fetchImpl).capture({ ...input, requestMode: "queued" }, ctx));
    expect((outcome as CaptureFailureError).code).toBe("malformed_response");
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("queued: a search that finishes with any other vendor error is not billed on the failure path", async () => {
    const { ctx, recordCost } = makeCtx();
    const body = { search_metadata: { status: "Error" }, error: "Results could not be returned, try again." };
    const outcome = await settle(adapterFor("google_ai_mode", fetchSequence(aiModeSubmitProcessing, body).fetchImpl).capture({ ...input, requestMode: "queued" }, ctx));
    expect((outcome as CaptureFailureError).code).toBe("upstream_5xx");
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("the match is narrow: a different error that merely mentions results stays upstream_5xx", async () => {
    for (const surface of ["google_aio", "google_ai_mode"] as const) {
      const body = { search_metadata: { status: "Error" }, error: "Results could not be returned, try again." };
      const outcome = await settle(adapterFor(surface, fetchSequence(body).fetchImpl).capture({ ...input, requestMode: "live" }, makeCtx().ctx));
      expect((outcome as CaptureFailureError).code).toBe("upstream_5xx");
    }
  });
});

describe("STORY-029 review 1 · a product shown only as a top-level priced card is in the text the parser matches", () => {
  it("its line is in the markdown as well as in the elements", async () => {
    const { mapSerpAnswer } = await import("./serp-mapper.js");
    const mapped = mapSerpAnswer({ text_blocks: [{ type: "paragraph", snippet: "Some intro." }], shopping_results: [{ title: "Zephyr Buds Pro", price: "$59.00" }] });
    expect(mapped.elements.some((element) => element.kind === "product")).toBe(true);
    expect(mapped.markdown).toContain("Zephyr Buds Pro - $59.00");
  });
});
