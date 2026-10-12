import { describe, expect, it, vi } from "vitest";
import type { CaptureContext } from "../contract.js";
import { CaptureFailureError } from "../failure-taxonomy.js";
import { GeminiApiAdapter, MAX_RETRY_AFTER_MS } from "./gemini-api-adapter.js";

// SCANFIX D3 — a 429 must carry the vendor's own "come back in N seconds".
// Gemini says it two ways: the standard Retry-After header, and the
// google.rpc.RetryInfo detail in the body ("retryDelay": "17s"). Both are read;
// the header wins; neither present means nothing is invented here.

const ctx: CaptureContext = {
  signal: new AbortController().signal,
  span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() },
  recordCost: vi.fn(),
};
const request = { contents: [{ role: "user", parts: [{ text: "q" }] }], tools: [{ google_search: {} }] } as never;

async function failureOf(status: number, body: unknown, headers: Record<string, string> = {}): Promise<CaptureFailureError> {
  const adapter = new GeminiApiAdapter({
    apiKey: "test-key-not-a-secret-0000",
    timeoutMs: 5000,
    fetchImpl: vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers })),
  });
  const error = await adapter.dispatch(request, ctx).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CaptureFailureError);
  return error as CaptureFailureError;
}

const quotaBody = (retryDelay?: string) => ({
  error: {
    code: 429,
    message: "Resource has been exhausted",
    status: "RESOURCE_EXHAUSTED",
    ...(retryDelay === undefined ? {} : { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] }),
  },
});

describe("SCANFIX-D3 · gemini 429 carries Retry-After", () => {
  it("SCANFIX-D3m · Retry-After in seconds", async () => {
    const error = await failureOf(429, quotaBody(), { "retry-after": "17" });
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(17_000);
  });

  it("SCANFIX-D3n · Retry-After as an HTTP date is read relative to now", async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    const error = await failureOf(429, quotaBody(), { "retry-after": at });
    expect(error.retryAfterMs).toBeGreaterThan(25_000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(30_000);
  });

  it("SCANFIX-D3o · no header: the RetryInfo retryDelay in the body ('17s', '1.5s')", async () => {
    expect((await failureOf(429, quotaBody("17s"))).retryAfterMs).toBe(17_000);
    expect((await failureOf(429, quotaBody("1.5s"))).retryAfterMs).toBe(1_500);
  });

  it("SCANFIX-D3p · the header wins over the body", async () => {
    expect((await failureOf(429, quotaBody("90s"), { "retry-after": "5" })).retryAfterMs).toBe(5_000);
  });

  it("SCANFIX-D3q · neither present, or unparseable: undefined, never a guess and never NaN", async () => {
    expect((await failureOf(429, quotaBody())).retryAfterMs).toBeUndefined();
    expect((await failureOf(429, quotaBody("soon"), { "retry-after": "later" })).retryAfterMs).toBeUndefined();
    expect((await failureOf(429, quotaBody(), { "retry-after": "-4" })).retryAfterMs).toBeUndefined();
  });

  it("SCANFIX-D3r · a hostile or absurd value is clamped to the cap", async () => {
    expect((await failureOf(429, quotaBody(), { "retry-after": "86400" })).retryAfterMs).toBe(MAX_RETRY_AFTER_MS);
  });

  it("SCANFIX-D3s · zero is zero, not absent: the vendor said retry now", async () => {
    expect((await failureOf(429, quotaBody(), { "retry-after": "0" })).retryAfterMs).toBe(0);
  });

  it("SCANFIX-D3t · only a 429 carries it: a 503 with Retry-After is still just upstream_5xx", async () => {
    const error = await failureOf(503, quotaBody(), { "retry-after": "9" });
    expect(error.code).toBe("upstream_5xx");
    expect(error.retryAfterMs).toBeUndefined();
  });
});
