import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rawCaptureSchema, type CaptureContext, type CaptureInput, type EngineKey } from "../contract.js";
import { CaptureFailureError } from "../failure-taxonomy.js";
import { captureReadyEngineKeys, resolveEngine } from "../registry.js";
import {
  assertGrounded,
  buildOpenRouterRequest,
  OPENROUTER_DEFAULT_MODELS,
  OpenRouterAdapter,
  UngroundedRequestError,
  type OpenRouterEngineKey,
} from "./openrouter-adapter.js";
import { FreeModelPathError, OpenRouterFreeProbe } from "./openrouter-free-probe.js";
import { openRouterChatResponseSchema } from "./openrouter-response.schema.js";
import {
  claudeAnnotatedDocumented,
  claudeReasoningTruncated,
  freeGemma,
  gptSearchInlineUrl,
  forbidden403,
  insufficientCredits402,
  moderation403,
  invalidKey401,
  malformedPayload,
  noModelField,
  noNativeSearch404,
  rateLimited429,
  refusalContentFilter,
  sonarAnnotations,
  upstreamError502,
} from "./fixtures/openrouter-recorded.js";
import { DEFAULT_ENGINE_SPEND_CEILINGS_USD } from "../../../config/env.schema.js";
import { configForFromEnv } from "../engine-lease.js";

// STORY-028 / owner decision 42 - the OpenRouter-backed adapter for chatgpt, claude and perplexity, and the dev-only free-model
// probe. No network: every test injects a fake fetch. The live calls were made once, by hand (scripts/record-openrouter-fixtures.mjs).

const FAKE_KEY = "sk-or-test-not-a-secret-0000";
const input: CaptureInput = { promptText: "best CRM for a 50-person startup", locale: "en-US", sampleIndex: 0, requireCitations: true };
const ENGINES: readonly OpenRouterEngineKey[] = ["chatgpt", "claude", "perplexity"];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function makeCtx() {
  const recordCost = vi.fn();
  const ctx: CaptureContext = { signal: new AbortController().signal, span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() }, recordCost };
  return { ctx, recordCost };
}
function adapterFor(engine: OpenRouterEngineKey, fetchImpl: typeof fetch, extra: { timeoutMs?: number; model?: string } = {}) {
  return new OpenRouterAdapter({ engineKey: engine, apiKey: FAKE_KEY, fetchImpl, timeoutMs: extra.timeoutMs ?? 5000, ...(extra.model !== undefined ? { model: extra.model } : {}) });
}
function fetchReturning(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(async () => jsonResponse(body, status, headers));
}
async function failureOf(promise: Promise<unknown>): Promise<CaptureFailureError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(CaptureFailureError);
  return error as CaptureFailureError;
}

describe("vendor response schema", () => {
  it("accepts every recorded and documented chat completion shape", () => {
    for (const payload of [freeGemma, gptSearchInlineUrl, sonarAnnotations, claudeReasoningTruncated, claudeAnnotatedDocumented, noModelField, refusalContentFilter]) {
      expect(openRouterChatResponseSchema.safeParse(payload).success).toBe(true);
    }
  });
  it("rejects the malformed payload (no choices)", () => {
    expect(openRouterChatResponseSchema.safeParse(malformedPayload).success).toBe(false);
  });
  it("no fixture contains a credential-shaped string", () => {
    const all = JSON.stringify([freeGemma, gptSearchInlineUrl, sonarAnnotations, claudeReasoningTruncated, claudeAnnotatedDocumented, invalidKey401]);
    expect(all).not.toMatch(/sk-or-[A-Za-z0-9-]{10,}/);
  });
});

describe("STORY-028 · scenario 2 · a fixture call has the live result shape", () => {
  it.each(ENGINES)("%s: a recorded answer maps to a RawCapture that satisfies rawCaptureSchema", async (engine) => {
    const { ctx } = makeCtx();
    const result = await adapterFor(engine, fetchReturning(sonarAnnotations)).capture(input, ctx);
    expect(rawCaptureSchema.safeParse(result).success).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.format).toBe("markdown");
  });
  it("declares mode, semantic version, citation support and per-task concurrency (AC 1)", () => {
    for (const engine of ENGINES) {
      const a = adapterFor(engine, fetchReturning({}));
      expect(a.engineKey).toBe(engine);
      expect(a.captureMode).toBe("api");
      expect(a.adapterVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(a.supportsCitations).toBe(true);
      expect(a.concurrencyPerTask).toBeGreaterThan(0);
    }
  });
});

describe("STORY-028 · scenario 3 · structured citations keep their slots, in order (AC 2)", () => {
  it("perplexity: the 18 recorded annotations come through 1..18 in array order, URLs untouched", async () => {
    const { ctx } = makeCtx();
    const result = await adapterFor("perplexity", fetchReturning(sonarAnnotations)).capture(input, ctx);
    const recorded = sonarAnnotations.choices[0].message.annotations.map((a) => a.url_citation.url);
    const cites = result.structuredCitations ?? [];
    expect(cites).toHaveLength(18);
    expect(cites.map((c) => c.slot)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(cites.map((c) => c.url)).toEqual(recorded);
    expect(cites[0]?.title).toBeTruthy();
  });
  it("claude: a URL cited twice takes the slot of its first appearance, once (documented shape)", async () => {
    const { ctx } = makeCtx();
    const result = await adapterFor("claude", fetchReturning(claudeAnnotatedDocumented)).capture(input, ctx);
    expect((result.structuredCitations ?? []).map((c) => [c.slot, c.url])).toEqual([
      [1, "https://www.hubspot.com/products/crm"],
      [2, "https://www.pipedrive.com/en"],
    ]);
  });
});

describe("STORY-028 · scenario 4 · inline-URL answers invent no citations (AC 3)", () => {
  it("chatgpt: the recorded answer carries an inline URL and NO annotations, so structuredCitations is empty and the URL stays in the text for the citation pass", async () => {
    const { ctx } = makeCtx();
    const result = await adapterFor("chatgpt", fetchReturning(gptSearchInlineUrl)).capture(input, ctx);
    expect(result.structuredCitations ?? []).toEqual([]);
    expect(result.text).toMatch(/https:\/\/www\.hubspot\.com\//);
  });
});

describe("STORY-028 · scenario 5 · wrapped citation URLs", () => {
  it("OpenRouter returns direct URLs, not vendor wrappers: nothing is marked for resolution and none collapses to one domain", async () => {
    const { ctx } = makeCtx();
    const result = await adapterFor("perplexity", fetchReturning(sonarAnnotations)).capture(input, ctx);
    const hosts = new Set((result.structuredCitations ?? []).map((c) => new URL(c.url).hostname));
    expect(hosts.size).toBeGreaterThan(3);
  });
});

describe("STORY-028 · model identifier, truncation, refusal, cost", () => {
  it("scenario 6 - the routed model is recorded as modelFingerprint; its absence does not fail the capture", async () => {
    const { ctx } = makeCtx();
    expect((await adapterFor("perplexity", fetchReturning(sonarAnnotations)).capture(input, ctx)).modelFingerprint).toBe("perplexity/sonar");
    const bare = await adapterFor("claude", fetchReturning(noModelField)).capture(input, makeCtx().ctx);
    expect(bare.modelFingerprint).toBeUndefined();
    expect(bare.text).toContain("no model field");
  });
  it("finish_reason length is a truncated answer; an empty (reasoning-only) answer is flagged empty_answer and is data, not a failure", async () => {
    const { ctx } = makeCtx();
    const gpt = await adapterFor("chatgpt", fetchReturning(gptSearchInlineUrl)).capture(input, ctx);
    expect(gpt.truncated).toBe(true);
    const claude = await adapterFor("claude", fetchReturning(claudeReasoningTruncated)).capture(input, makeCtx().ctx);
    expect(claude.truncated).toBe(true);
    expect(claude.text).toBe("");
    expect(claude.flags).toEqual(["empty_answer"]);
  });
  it("a content_filter finish with a refusal is engine_refused_to_answer (data, not a failure)", async () => {
    const result = await adapterFor("chatgpt", fetchReturning(refusalContentFilter)).capture(input, makeCtx().ctx);
    expect(result.flags).toEqual(["engine_refused_to_answer"]);
    expect(result.truncated).toBe(false);
  });
  it("AC 9 - cost is recorded once per capture from usage.cost, and 0 stays 0 (a free model costs nothing)", async () => {
    const paid = makeCtx();
    const result = await adapterFor("perplexity", fetchReturning(sonarAnnotations)).capture(input, paid.ctx);
    expect(result.costUsd).toBeCloseTo(0.00552, 6);
    expect(paid.recordCost).toHaveBeenCalledTimes(1);
    expect(paid.recordCost).toHaveBeenCalledWith(result.costUsd);
  });
  it("a response with no usage.cost is priced from its tokens at a conservative rate, never recorded as 0", async () => {
    const body = { ...noModelField, usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 } };
    const result = await adapterFor("chatgpt", fetchReturning(body)).capture(input, makeCtx().ctx);
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

describe("STORY-028 · scenario 7 · timeout is classified", () => {
  it.each(ENGINES)("%s: a hung call past the hard timeout is `timeout`, not an untyped error", async (engine) => {
    const hung = vi.fn<typeof fetch>((_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    expect((await failureOf(adapterFor(engine, hung, { timeoutMs: 20 }).capture(input, makeCtx().ctx))).code).toBe("timeout");
  });
});

describe("STORY-028 · scenario 8 · grounding is required and refused BEFORE dispatch (AC 7)", () => {
  it("chatgpt and claude carry the web plugin on the native engine; perplexity carries none (sonar is search-native, the plugin answers 404)", () => {
    for (const engine of ["chatgpt", "claude"] as const) {
      const request = buildOpenRouterRequest(engine, OPENROUTER_DEFAULT_MODELS[engine], input);
      expect(request.plugins).toEqual([expect.objectContaining({ id: "web", engine: "native" })]);
      expect(() => assertGrounded(engine, request)).not.toThrow();
    }
    const sonar = buildOpenRouterRequest("perplexity", OPENROUTER_DEFAULT_MODELS.perplexity, input);
    expect(sonar.plugins).toBeUndefined();
    expect(() => assertGrounded("perplexity", sonar)).not.toThrow();
  });
  it("refuses a request without the plugin, with a non-native search engine, or a perplexity model that is not search-native", () => {
    const base = buildOpenRouterRequest("chatgpt", "openai/gpt-5.4", input);
    expect(() => assertGrounded("chatgpt", { ...base, plugins: undefined })).toThrow(UngroundedRequestError);
    expect(() => assertGrounded("chatgpt", { ...base, plugins: [{ id: "web", engine: "exa" }] })).toThrow(UngroundedRequestError);
    expect(() => assertGrounded("claude", { ...base, plugins: [{ id: "web" }] })).toThrow(UngroundedRequestError);
    const sonar = buildOpenRouterRequest("perplexity", "perplexity/sonar", input);
    expect(() => assertGrounded("perplexity", { ...sonar, model: "openai/gpt-5.4" })).toThrow(UngroundedRequestError);
  });
  it("a perplexity adapter configured with a non-search model cannot be built, so it never dispatches", () => {
    const fetchImpl = fetchReturning(sonarAnnotations);
    expect(() => adapterFor("perplexity", fetchImpl, { model: "openai/gpt-5.4" })).toThrow(UngroundedRequestError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("AC 8 - one single user turn, no conversational state", () => {
    for (const engine of ENGINES) {
      const request = buildOpenRouterRequest(engine, OPENROUTER_DEFAULT_MODELS[engine], input);
      expect(request.messages).toEqual([{ role: "user", content: input.promptText }]);
    }
  });
  it("the dispatched body is what was built (model, one turn, plugin) and the key travels only in the header", async () => {
    const fetchImpl = fetchReturning(claudeAnnotatedDocumented);
    await adapterFor("claude", fetchImpl).capture(input, makeCtx().ctx);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(String(init?.body)).not.toContain(FAKE_KEY);
    expect(JSON.parse(String(init?.body)).model).toBe(OPENROUTER_DEFAULT_MODELS.claude);
  });
});

describe("STORY-028 · scenario 9 · malformed payload: classified, no row", () => {
  it("a payload with no choices is malformed_response and capture() never resolves; the billed cost is still metered", async () => {
    const { ctx, recordCost } = makeCtx();
    expect((await failureOf(adapterFor("chatgpt", fetchReturning(malformedPayload)).capture(input, ctx))).code).toBe("malformed_response");
    expect(recordCost).toHaveBeenCalledWith(0.0003);
  });
  it("a body that is not JSON is malformed_response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("<html>nope</html>", { status: 200 }));
    expect((await failureOf(adapterFor("claude", fetchImpl).capture(input, makeCtx().ctx))).code).toBe("malformed_response");
  });
});

describe("failure taxonomy mapping", () => {
  const cases: readonly [string, unknown, number, string][] = [
    ["402 insufficient credits", insufficientCredits402, 402, "quota_exhausted"],
    ["429 rate limit", rateLimited429, 429, "rate_limited"],
    ["502 upstream", upstreamError502, 502, "upstream_5xx"],
    ["503", { error: { code: 503, message: "x" } }, 503, "upstream_5xx"],
    ["401 bad key", invalidKey401, 401, "auth_failed"],
    ["403 without moderation metadata is blocked, not a bad credential", forbidden403, 403, "blocked"],
    ["408 timeout", { error: { code: 408, message: "x" } }, 408, "timeout"],
    ["404 no native search / no model is a configuration fault, not a payload fault", noNativeSearch404, 404, "blocked"],
    ["400 bad request", { error: { code: 400, message: "x" } }, 400, "malformed_response"],
  ];
  it.each(cases)("%s", async (_name, body, status, code) => {
    for (const engine of ENGINES) {
      expect((await failureOf(adapterFor(engine, fetchReturning(body, status)).capture(input, makeCtx().ctx))).code).toBe(code);
    }
  });
  it.each(ENGINES)("%s: a moderation 403 is a stored refusal (data, NFR-SIM-07), not a failure and not auth_failed", async (engine) => {
    const { ctx } = makeCtx();
    const result = await adapterFor(engine, fetchReturning(moderation403, 403)).capture(input, ctx);
    expect(rawCaptureSchema.safeParse(result).success).toBe(true);
    expect(result.flags).toContain("engine_refused_to_answer");
    expect(result.text).toBe("");
    expect(JSON.stringify(result)).not.toContain("(redacted)");
  });
  it("a 200 carrying an error envelope is mapped by its code, not read as an answer", async () => {
    expect((await failureOf(adapterFor("chatgpt", fetchReturning(insufficientCredits402, 200)).capture(input, makeCtx().ctx))).code).toBe("quota_exhausted");
    expect((await failureOf(adapterFor("chatgpt", fetchReturning(upstreamError502, 200)).capture(input, makeCtx().ctx))).code).toBe("upstream_5xx");
  });
  it("a 429 carries the vendor's Retry-After; absent stays undefined and 0 stays 0", async () => {
    expect((await failureOf(adapterFor("claude", fetchReturning(rateLimited429, 429, { "retry-after": "7" })).capture(input, makeCtx().ctx))).retryAfterMs).toBe(7000);
    expect((await failureOf(adapterFor("claude", fetchReturning(rateLimited429, 429)).capture(input, makeCtx().ctx))).retryAfterMs).toBeUndefined();
    expect((await failureOf(adapterFor("claude", fetchReturning(rateLimited429, 429, { "retry-after": "0" })).capture(input, makeCtx().ctx))).retryAfterMs).toBe(0);
  });
  it("the failure message never carries the key or the vendor's text", async () => {
    const error = await failureOf(adapterFor("chatgpt", fetchReturning({ error: { code: 400, message: `echo ${FAKE_KEY} secret` } }, 400)).capture(input, makeCtx().ctx));
    expect(error.message).not.toContain(FAKE_KEY);
    expect(error.message).not.toContain("secret");
  });
});

describe("STORY-028 · scenario 10 · health probe (AC 10)", () => {
  it("a bad credential reports unhealthy with a detail, and the key is not in it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: 401, message: `No auth credentials found for ${FAKE_KEY}` } }, 401));
    const probe = await adapterFor("chatgpt", fetchImpl).healthProbe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("401");
    expect(probe.detail).not.toContain(FAKE_KEY);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://openrouter.ai/api/v1/key");
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe("GET");
  });
  it("a good key is healthy; an exhausted key limit is unhealthy (402 is coming)", async () => {
    expect((await adapterFor("claude", fetchReturning({ data: { limit: 10, limit_remaining: 4 } })).healthProbe()).ok).toBe(true);
    expect((await adapterFor("claude", fetchReturning({ data: { limit: null, limit_remaining: null } })).healthProbe()).ok).toBe(true);
    const spent = await adapterFor("claude", fetchReturning({ data: { limit: 10, limit_remaining: 0 } })).healthProbe();
    expect(spent.ok).toBe(false);
    expect(spent.detail).toMatch(/limit/);
  });
  it("a network failure is unhealthy with a detail", async () => {
    const probe = await adapterFor("claude", vi.fn<typeof fetch>(async () => { throw new Error("ECONNRESET"); })).healthProbe();
    expect(probe).toMatchObject({ ok: false });
    expect(probe.detail).toBeTruthy();
  });
});

describe("a free model can never serve a tracked engine (owner decision 42)", () => {
  it("the tracked adapter refuses a ':free' model at construction, and an engine that is not chatgpt/claude/perplexity", () => {
    expect(() => adapterFor("chatgpt", fetchReturning({}), { model: "google/gemma-4-26b-a4b-it:free" })).toThrow(FreeModelPathError);
    expect(() => new OpenRouterAdapter({ engineKey: "gemini" as unknown as OpenRouterEngineKey, apiKey: FAKE_KEY, timeoutMs: 1000 })).toThrow();
  });
  it("the dev-only probe accepts ONLY ':free' models, and never in production", () => {
    expect(() => new OpenRouterFreeProbe({ apiKey: FAKE_KEY, model: "openai/gpt-5.4", nodeEnv: "test" })).toThrow(FreeModelPathError);
    expect(() => new OpenRouterFreeProbe({ apiKey: FAKE_KEY, model: "google/gemma-4-26b-a4b-it:free", nodeEnv: "production" })).toThrow(FreeModelPathError);
  });
  it("the probe is not a CaptureAdapter: no engineKey, no capture(), and its result is not a RawCapture", async () => {
    const probe = new OpenRouterFreeProbe({ apiKey: FAKE_KEY, model: "google/gemma-4-26b-a4b-it:free", nodeEnv: "test", fetchImpl: fetchReturning(freeGemma) });
    expect("engineKey" in probe).toBe(false);
    expect("capture" in probe).toBe(false);
    const result = await probe.probe("In two sentences, what is a CRM?");
    expect(result.model).toBe("google/gemma-4-26b-a4b-it:free");
    expect(result.text).toMatch(/CRM|Customer Relationship/);
    expect(result.costUsd).toBe(0);
    expect("engineKey" in result).toBe(false);
    expect(rawCaptureSchema.safeParse(result).success).toBe(false);
  });
  it("the probe sends no web plugin (search costs money even on a free model) and no credential in the body", async () => {
    const fetchImpl = fetchReturning(freeGemma);
    await new OpenRouterFreeProbe({ apiKey: FAKE_KEY, model: "google/gemma-4-26b-a4b-it:free", nodeEnv: "test", fetchImpl }).probe("hi");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.plugins).toBeUndefined();
    expect(body.model).toBe("google/gemma-4-26b-a4b-it:free");
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
  });
  it("the probe maps a 402 to the same typed failure code, not an untyped throw", async () => {
    const probe = new OpenRouterFreeProbe({ apiKey: FAKE_KEY, model: "google/gemma-4-26b-a4b-it:free", nodeEnv: "test", fetchImpl: fetchReturning(insufficientCredits402, 402) });
    await expect(probe.probe("hi")).rejects.toMatchObject({ code: "quota_exhausted" });
  });
  it("the registry source never imports the probe, so it cannot be resolved as an engine", () => {
    const registry = readFileSync(new URL("../registry.ts", import.meta.url), "utf8");
    expect(registry).not.toMatch(/openrouter-free-probe/);
    const adapterSource = readFileSync(new URL("./openrouter-adapter.ts", import.meta.url), "utf8");
    expect(adapterSource).not.toMatch(/openrouter-free-probe/);
  });
});

describe("registry binding", () => {
  afterEach(() => vi.unstubAllEnvs());
  const clearKeys = () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENROUTER_MODEL_CHATGPT", "");
    vi.stubEnv("OPENROUTER_MODEL_CLAUDE", "");
    vi.stubEnv("OPENROUTER_MODEL_PERPLEXITY", "");
    vi.stubEnv("ENGINE_OPENROUTER", "");
    vi.stubEnv("ENGINE_SIMULATION", "");
  };
  it("without OPENROUTER_API_KEY the three engines stay fixture-backed and not capture-ready", () => {
    clearKeys();
    for (const engine of ENGINES) {
      expect(resolveEngine(engine)).not.toBeInstanceOf(OpenRouterAdapter);
      expect(captureReadyEngineKeys()).not.toContain(engine);
    }
  });
  it.each(["", "off"])("the key alone (ENGINE_OPENROUTER=%j) binds no OpenRouterAdapter: the paid path needs an explicit opt-in (decision 44)", (optIn) => {
    clearKeys();
    vi.stubEnv("OPENROUTER_API_KEY", FAKE_KEY);
    vi.stubEnv("ENGINE_OPENROUTER", optIn);
    for (const engine of ENGINES) {
      expect(resolveEngine(engine)).not.toBeInstanceOf(OpenRouterAdapter);
      expect(captureReadyEngineKeys()).not.toContain(engine);
    }
  });
  it("a perplexity model that is not a sonar model is never capture-ready: refused at binding, not on every cell", () => {
    clearKeys();
    vi.stubEnv("OPENROUTER_API_KEY", FAKE_KEY);
    vi.stubEnv("ENGINE_OPENROUTER", "paid");
    vi.stubEnv("OPENROUTER_MODEL_PERPLEXITY", "openai/gpt-5.4");
    expect(captureReadyEngineKeys()).not.toContain("perplexity");
    expect(resolveEngine("perplexity")).not.toBeInstanceOf(OpenRouterAdapter);
    expect(() => new OpenRouterAdapter({ engineKey: "perplexity", apiKey: FAKE_KEY, timeoutMs: 5000, model: "openai/gpt-5.4" })).toThrow(UngroundedRequestError);
  });
  it("with the key AND ENGINE_OPENROUTER=paid, each is a real OpenRouterAdapter stamped with its own engine key and is capture-ready", () => {
    clearKeys();
    vi.stubEnv("OPENROUTER_API_KEY", FAKE_KEY);
    vi.stubEnv("ENGINE_OPENROUTER", "paid");
    for (const engine of ENGINES) {
      const adapter = resolveEngine(engine);
      expect(adapter).toBeInstanceOf(OpenRouterAdapter);
      expect(adapter.engineKey).toBe(engine as EngineKey);
      expect(captureReadyEngineKeys()).toContain(engine);
    }
  });
  it("the model id is configurable per engine", async () => {
    clearKeys();
    vi.stubEnv("OPENROUTER_API_KEY", FAKE_KEY);
    vi.stubEnv("ENGINE_OPENROUTER", "paid");
    vi.stubEnv("OPENROUTER_MODEL_CHATGPT", "openai/gpt-5.4-mini");
    const fetchImpl = fetchReturning(gptSearchInlineUrl);
    vi.stubGlobal("fetch", fetchImpl);
    try {
      await resolveEngine("chatgpt").capture(input, makeCtx().ctx);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).model).toBe("openai/gpt-5.4-mini");
  });
  it("a ':free' model configured for a tracked engine leaves it NOT capture-ready (fixture-backed): a free model never serves a tracked engine", () => {
    clearKeys();
    vi.stubEnv("OPENROUTER_API_KEY", FAKE_KEY);
    vi.stubEnv("ENGINE_OPENROUTER", "paid");
    vi.stubEnv("OPENROUTER_MODEL_CLAUDE", "google/gemma-4-26b-a4b-it:free");
    expect(resolveEngine("claude")).not.toBeInstanceOf(OpenRouterAdapter);
    expect(captureReadyEngineKeys()).not.toContain("claude");
    expect(captureReadyEngineKeys()).toContain("chatgpt");
  });
});

describe("spend ceilings and pacing", () => {
  it("chatgpt, claude and perplexity have placeholder ceilings (pending the owner) that together fit inside the 10 USD key limit", () => {
    const { chatgpt, claude, perplexity } = DEFAULT_ENGINE_SPEND_CEILINGS_USD;
    expect([chatgpt, claude, perplexity]).toEqual([4, 4, 1]);
    expect(chatgpt! + claude! + perplexity!).toBeLessThanOrEqual(10);
  });
  it("OPENROUTER_REQUESTS_PER_MINUTE builds a one-token bucket for each of the three engines (and not for others)", () => {
    const buckets = {
      chatgpt: { capacity: 10, refillPerSecond: 1 }, claude: { capacity: 10, refillPerSecond: 1 }, perplexity: { capacity: 10, refillPerSecond: 1 },
      google_aio: { capacity: 10, refillPerSecond: 1 }, google_ai_mode: { capacity: 10, refillPerSecond: 1 }, gemini: { capacity: 10, refillPerSecond: 1 },
    } as const;
    const configFor = configForFromEnv(buckets, undefined, undefined, 6);
    for (const engine of ENGINES) expect(configFor(engine)).toEqual({ capacity: 1, refillPerSecond: 6 / 60 });
    expect(configFor("google_aio")).toEqual({ capacity: 10, refillPerSecond: 1 });
  });
});
