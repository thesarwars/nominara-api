import { describe, expect, it, vi } from "vitest";
import { rawCaptureSchema, type CaptureContext, type CaptureInput } from "../contract.js";
import { CaptureFailureError } from "../failure-taxonomy.js";
import {
  assertGrounded,
  buildGeminiRequest,
  GeminiApiAdapter,
  UngroundedRequestError,
  type GeminiRequest,
} from "./gemini-api-adapter.js";
import { geminiGenerateContentResponseSchema } from "./gemini-response.schema.js";
import {
  emptyAnswer,
  invalidKeyError,
  malformedPayload,
  noModelVersion,
  normalGrounded,
  refusalSafety,
  truncatedMaxTokens,
} from "./fixtures/gemini-recorded.js";

// NEW-A-3 — STORY-028 scenarios restricted to Gemini. These are RED until NEW-A-4 implements
// GeminiApiAdapter; they fail with "NEW-A-4: not implemented", never from a wrong assertion.
// Scenario 1 (live) is gemini.live.spec.ts, opt-in and never part of CI.
// No network: every test injects a fake fetch.

const FAKE_KEY = "test-key-not-a-secret-0000";
const input: CaptureInput = { promptText: "best CRM for a 50-person startup", locale: "en-US", sampleIndex: 0, requireCitations: true };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeCtx() {
  const recordCost = vi.fn();
  const ctx: CaptureContext = {
    signal: new AbortController().signal,
    span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() },
    recordCost,
  };
  return { ctx, recordCost };
}

function makeAdapter(fetchImpl: typeof fetch, timeoutMs = 5000) {
  return new GeminiApiAdapter({ apiKey: FAKE_KEY, fetchImpl, timeoutMs });
}

function fetchReturning(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => jsonResponse(body, status));
}

describe("vendor response schema (NEW-A-3 AC1)", () => {
  it("accepts every recorded generateContent shape", () => {
    for (const payload of [normalGrounded, noModelVersion, refusalSafety, emptyAnswer, truncatedMaxTokens]) {
      expect(geminiGenerateContentResponseSchema.safeParse(payload).success).toBe(true);
    }
  });

  it("rejects the malformed payload", () => {
    expect(geminiGenerateContentResponseSchema.safeParse(malformedPayload).success).toBe(false);
  });

  it("the recorded normal answer carries the grounding fields the adapter reads", () => {
    const parsed = geminiGenerateContentResponseSchema.parse(normalGrounded);
    const chunks = parsed.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.web?.uri.includes("vertexaisearch.cloud.google.com/grounding-api-redirect/"))).toBe(true);
    expect(parsed.modelVersion).toBeTruthy();
    expect(parsed.responseId).toBeTruthy();
  });

  it("no recorded fixture contains a credential-shaped string", () => {
    const all = JSON.stringify([normalGrounded, refusalSafety, emptyAnswer, truncatedMaxTokens, invalidKeyError]);
    expect(all).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
  });
});

describe("STORY-028 · scenario 2 · fixture call has the live result shape", () => {
  it("a recorded normal answer maps to a RawCapture that satisfies rawCaptureSchema", async () => {
    const { ctx } = makeCtx();
    const result = await makeAdapter(fetchReturning(normalGrounded)).capture(input, ctx);
    expect(rawCaptureSchema.safeParse(result).success).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.format).toBe("markdown");
    expect(result.truncated).toBe(false);
    expect(result.modelFingerprint).toBe(normalGrounded.modelVersion);
    expect(result.vendorRequestId).toBe(normalGrounded.responseId);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("records the per-capture cost through the context callback exactly once", async () => {
    const { ctx, recordCost } = makeCtx();
    const result = await makeAdapter(fetchReturning(normalGrounded)).capture(input, ctx);
    expect(recordCost).toHaveBeenCalledTimes(1);
    expect(recordCost).toHaveBeenCalledWith(result.costUsd);
  });

  it("a SAFETY stop is data: flagged engine_refused_to_answer, not thrown", async () => {
    const { ctx } = makeCtx();
    const result = await makeAdapter(fetchReturning(refusalSafety)).capture(input, ctx);
    expect(result.flags).toContain("engine_refused_to_answer");
  });

  it("an empty answer is data: flagged empty_answer", async () => {
    const { ctx } = makeCtx();
    const result = await makeAdapter(fetchReturning(emptyAnswer)).capture(input, ctx);
    expect(result.text).toBe("");
    expect(result.flags).toContain("empty_answer");
  });

  it("a MAX_TOKENS stop sets truncated and keeps the text", async () => {
    const { ctx } = makeCtx();
    const result = await makeAdapter(fetchReturning(truncatedMaxTokens)).capture(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe("STORY-028 · scenario 5 · wrapped citation URLs are marked, not resolved, by the adapter", () => {
  it("maps each grounding chunk to a structuredCitation: slots 1-based, in order, URLs untouched", async () => {
    const fetchImpl = fetchReturning(normalGrounded);
    const { ctx } = makeCtx();
    const result = await makeAdapter(fetchImpl).capture(input, ctx);

    const chunks = geminiGenerateContentResponseSchema.parse(normalGrounded).candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const citations = result.structuredCitations ?? [];
    expect(citations).toHaveLength(chunks.length);
    expect(citations.map((c) => c.slot)).toEqual(chunks.map((_, i) => i + 1));
    expect(citations.map((c) => c.url)).toEqual(chunks.map((c) => c.web?.uri));
    expect(citations.every((c) => c.url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect/"))).toBe(true);
    expect(citations.map((c) => c.title)).toEqual(chunks.map((c) => c.web?.title));
  });

  it("makes exactly one network call: resolution is the parse stage's job, never the adapter's", async () => {
    const fetchImpl = fetchReturning(normalGrounded);
    const { ctx } = makeCtx();
    await makeAdapter(fetchImpl).capture(input, ctx);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a chunk without a web uri yields no invented citation", async () => {
    const payload = structuredClone(normalGrounded);
    payload.candidates[0]!.groundingMetadata.groundingChunks.splice(1, 0, {} as never);
    const { ctx } = makeCtx();
    const result = await makeAdapter(fetchReturning(payload)).capture(input, ctx);
    const original = normalGrounded.candidates[0]!.groundingMetadata.groundingChunks.length;
    expect(result.structuredCitations).toHaveLength(original);
    expect(result.structuredCitations?.map((c) => c.slot)).toEqual(Array.from({ length: original }, (_, i) => i + 1));
  });
});

describe("STORY-028 · scenario 6 · response omitting the model identifier", () => {
  it("is handled without failing: modelFingerprint is absent, not empty or invented", async () => {
    const { ctx } = makeCtx();
    const result = await makeAdapter(fetchReturning(noModelVersion)).capture(input, ctx);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.modelFingerprint).toBeUndefined();
  });
});

describe("STORY-028 · scenario 7 · forced timeout", () => {
  it("is classified as a timeout CaptureFailureError, not an untyped error", async () => {
    const hangs = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
        }),
    );
    const { ctx, recordCost } = makeCtx();
    const failure = await makeAdapter(hangs, 25)
      .capture(input, ctx)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(CaptureFailureError);
    expect((failure as CaptureFailureError).code).toBe("timeout");
    expect(recordCost).not.toHaveBeenCalled();
  });
});

describe("STORY-028 · scenario 8 · no grounding flag is refused before dispatch", () => {
  it("buildGeminiRequest is a single user turn with google_search set", () => {
    const request = buildGeminiRequest(input);
    expect(request.contents).toHaveLength(1);
    expect(request.contents[0]?.role).toBe("user");
    expect(request.tools).toEqual([{ google_search: {} }]);
  });

  it("assertGrounded throws UngroundedRequestError for a request with no tools", () => {
    const ungrounded: GeminiRequest = { contents: [{ role: "user", parts: [{ text: "x" }] }] };
    expect(() => assertGrounded(ungrounded)).toThrow(UngroundedRequestError);
    expect(() => assertGrounded({ ...ungrounded, tools: [] })).toThrow(UngroundedRequestError);
    expect(() => assertGrounded({ ...ungrounded, tools: [{ code_execution: {} }] })).toThrow(UngroundedRequestError);
  });

  it("dispatch of an ungrounded request rejects and never calls fetch", async () => {
    const fetchImpl = fetchReturning(normalGrounded);
    const { ctx } = makeCtx();
    const ungrounded: GeminiRequest = { contents: [{ role: "user", parts: [{ text: "x" }] }] };
    await expect(makeAdapter(fetchImpl).dispatch(ungrounded, ctx)).rejects.toBeInstanceOf(UngroundedRequestError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("capture() always sends google_search; the key travels in a header, never the URL", async () => {
    const fetchImpl = fetchReturning(normalGrounded);
    const { ctx } = makeCtx();
    await makeAdapter(fetchImpl).capture(input, ctx);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).not.toContain(FAKE_KEY);
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(FAKE_KEY);
    const body = JSON.parse(String(init?.body)) as GeminiRequest;
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.contents).toHaveLength(1);
  });
});

describe("STORY-028 · scenario 9 · malformed vendor payload", () => {
  it("is classified malformed_response and writes nothing (no cost recorded)", async () => {
    const { ctx, recordCost } = makeCtx();
    const failure = await makeAdapter(fetchReturning(malformedPayload))
      .capture(input, ctx)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(CaptureFailureError);
    expect((failure as CaptureFailureError).code).toBe("malformed_response");
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("a non-JSON 200 body is also malformed_response", async () => {
    const html = vi.fn<typeof fetch>(async () => new Response("<html>gateway</html>", { status: 200 }));
    const { ctx, recordCost } = makeCtx();
    await expect(makeAdapter(html).capture(input, ctx)).rejects.toMatchObject({ code: "malformed_response" });
    expect(recordCost).not.toHaveBeenCalled();
  });
});

describe("STORY-028 · scenario 10 · health probe with a bad credential", () => {
  it("reports unhealthy with a detail, and the detail never contains the key", async () => {
    const probe = await makeAdapter(fetchReturning(invalidKeyError, 400)).healthProbe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toBeTruthy();
    expect(probe.detail).not.toContain(FAKE_KEY);
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports healthy on a 200", async () => {
    const probe = await makeAdapter(fetchReturning(normalGrounded)).healthProbe();
    expect(probe.ok).toBe(true);
  });

  it("a thrown network error is unhealthy with a detail, not an exception", async () => {
    const boom = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNRESET");
    });
    const probe = await makeAdapter(boom).healthProbe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toBeTruthy();
  });
});
