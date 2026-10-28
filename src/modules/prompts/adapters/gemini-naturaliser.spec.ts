import { Logger } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../../lib/resilience/circuit-breaker.js";

vi.mock("../../../lib/telemetry/metrics.js", () => ({ incrementCounter: vi.fn(), observeValue: vi.fn() }));

import { incrementCounter, observeValue } from "../../../lib/telemetry/metrics.js";
import { withTenantContext } from "../../../tenancy/tenant-context.js";
import { GeminiNaturaliser, GeminiNaturaliserError } from "./gemini-naturaliser.js";

// STORY-045 AC3 - the Gemini binding behind PROMPT_NATURALISER. NO test here touches the network: every call goes through an injected
// fetch. The key below is a fake and the assertions prove it never leaves the request header.

interface SentBody {
  tools?: unknown;
  generationConfig: { temperature: number; responseMimeType: string; responseSchema: unknown };
  contents: { parts: { text: string }[] }[];
}

const KEY = "AIza-fake-key-for-tests-only";
const LINES = ["Which CRM do you recommend for midmarket teams?", "Is Acme or Beta better for sales leads?"];

function reply(texts: unknown, usage: unknown = { promptTokenCount: 120, candidatesTokenCount: 40 }): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(texts) }] } }], ...(usage === "absent" ? {} : { usageMetadata: usage }) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function adapter(fetchImpl: typeof fetch, extra: { breaker?: CircuitBreaker; timeoutMs?: number } = {}): GeminiNaturaliser {
  return new GeminiNaturaliser({ apiKey: KEY, model: "gemini-2.5-flash", timeoutMs: extra.timeoutMs ?? 1_000, fetchImpl, ...(extra.breaker ? { breaker: extra.breaker } : {}) });
}

const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

beforeEach(() => {
  warn.mockClear();
  vi.mocked(incrementCounter).mockClear();
  vi.mocked(observeValue).mockClear();
});

describe("STORY-045 AC3 - GeminiNaturaliser", () => {
  it("makes exactly ONE provider call for the whole batch and returns the rewritten array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(["a", "b"]));
    const out = await adapter(fetchImpl as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0.35 });
    expect(out).toEqual(["a", "b"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("targets the configured model and sends the key in a header, never in the URL or the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(["a", "b"]));
    await adapter(fetchImpl as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0.35 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/models/gemini-2.5-flash:generateContent");
    expect(url).not.toContain(KEY);
    expect(String(init.body)).not.toContain(KEY);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
  });

  it("sends our template lines and the temperature, requests schema-constrained JSON, and enables no tools", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(["a", "b"]));
    await adapter(fetchImpl as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0.35 });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body)) as SentBody;
    expect(body.generationConfig.temperature).toBe(0.35);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toMatchObject({ type: "ARRAY", items: { type: "STRING" }, minItems: 2, maxItems: 2 });
    // FR-FAN-01e: an ungrounded rewrite. A search tool would put web text into the model's context.
    expect(body.tools).toBeUndefined();
    const sent = JSON.stringify(body);
    for (const line of LINES) expect(sent).toContain(line);
  });

  it("FR-FAN-01e - the lines are the only variable content: a line cannot add a numbered line of its own", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(["a", "b"]));
    await adapter(fetchImpl as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0 });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body)) as SentBody;
    const userText = body.contents[0]!.parts[0]!.text;
    expect(userText.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(2);
  });

  it.each([
    ["not JSON", { candidates: [{ content: { parts: [{ text: "Sure! here you go" }] } }] }],
    ["an object, not an array", { candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }],
    ["an array containing a non-string", { candidates: [{ content: { parts: [{ text: '["a", 2]' }] } }] }],
    ["no candidates (a safety block)", { promptFeedback: { blockReason: "SAFETY" } }],
    ["no parts", { candidates: [{ content: {} }] }],
  ])("a 200 whose body is %s throws, so the caller falls back to template text", async (_name, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    await expect(adapter(fetchImpl as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0 })).rejects.toBeInstanceOf(GeminiNaturaliserError);
  });

  it.each([400, 401, 429, 500, 503])("an HTTP %i throws without the key or any line in the message", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(`quota exceeded for ${LINES[0]} key=${KEY}`, { status }));
    const failure = await adapter(fetchImpl as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GeminiNaturaliserError);
    const text = JSON.stringify({ m: (failure as Error).message, c: (failure as Error).cause });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(LINES[0]!);
    expect((failure as GeminiNaturaliserError).status).toBe(status);
  });

  it("a network error throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(adapter(fetchImpl as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0 })).rejects.toBeInstanceOf(GeminiNaturaliserError);
  });

  it("a call that never answers is cut off at the timeout rather than holding the request open", async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
    }));
    const started = Date.now();
    await expect(adapter(fetchImpl as unknown as typeof fetch, { timeoutMs: 40 }).naturalise({ lines: LINES, temperature: 0 })).rejects.toBeInstanceOf(GeminiNaturaliserError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a breaker that has opened refuses the next call WITHOUT touching the network (template-only path)", async () => {
    const breaker = new CircuitBreaker({ name: "t", errorThresholdPercentage: 50, sampleSize: 2, openDurationMs: 60_000 });
    const fetchImpl = vi.fn().mockResolvedValue(new Response("x", { status: 500 }));
    const nat = adapter(fetchImpl as unknown as typeof fetch, { breaker });
    for (let i = 0; i < 2; i++) await nat.naturalise({ lines: LINES, temperature: 0 }).catch(() => undefined);
    const callsBefore = fetchImpl.mock.calls.length;
    await expect(nat.naturalise({ lines: LINES, temperature: 0 })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchImpl.mock.calls.length).toBe(callsBefore);
  });

  it("an empty batch makes no call", async () => {
    const fetchImpl = vi.fn();
    expect(await adapter(fetchImpl as unknown as typeof fetch).naturalise({ lines: [], temperature: 0 })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("observability - a counter per outcome, the provider-reported tokens (0 stays 0, absent is not observed), and no text in either", async () => {
    await adapter(vi.fn().mockResolvedValue(reply(["a", "b"], { promptTokenCount: 100, candidatesTokenCount: 0 })) as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0 });
    expect(incrementCounter).toHaveBeenCalledWith("nominara_prompts_naturalise_calls_total", { outcome: "ok" });
    expect(observeValue).toHaveBeenCalledWith("nominara_prompts_naturalise_tokens_spent", 100, expect.anything());

    vi.mocked(observeValue).mockClear();
    await adapter(vi.fn().mockResolvedValue(reply(["a", "b"], "absent")) as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0 });
    expect(observeValue).not.toHaveBeenCalled();

    await adapter(vi.fn().mockResolvedValue(new Response("x", { status: 503 })) as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0 }).catch(() => undefined);
    expect(incrementCounter).toHaveBeenCalledWith("nominara_prompts_naturalise_calls_total", { outcome: "error" });
    const logged = JSON.stringify([...vi.mocked(incrementCounter).mock.calls, ...vi.mocked(observeValue).mock.calls]);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(LINES[0]!);
  });

  it("observability - a failure writes ONE redacted log line: event, outcome, model and status, never the key or a line", async () => {
    await adapter(vi.fn().mockResolvedValue(new Response(`echo ${LINES[0]} ${KEY}`, { status: 429 })) as unknown as typeof fetch).naturalise({ lines: LINES, temperature: 0 }).catch(() => undefined);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({ event: "prompts.naturalise.failed", outcome: "error", model: "gemini-2.5-flash", status: 429, workspace_id: null });
  });

  it("observability - the failure line carries the workspace ID when a tenant context is active, and null when none is", async () => {
    const failing = (): GeminiNaturaliser => adapter(vi.fn().mockResolvedValue(new Response("x", { status: 503 })) as unknown as typeof fetch);
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const workspaceId = "0190a0a0-0000-7000-8000-000000000001";
    await withTenantContext(client as never, { workspaceId, actorId: "0190a0a0-0000-7000-8000-000000000002" }, () =>
      failing().naturalise({ lines: LINES, temperature: 0 }).catch(() => undefined),
    );
    expect(warn.mock.calls[0]![0]).toMatchObject({ event: "prompts.naturalise.failed", workspace_id: workspaceId });

    warn.mockClear();
    await failing().naturalise({ lines: LINES, temperature: 0 }).catch(() => undefined);
    expect(warn.mock.calls[0]![0]).toMatchObject({ workspace_id: null });
  });
});
