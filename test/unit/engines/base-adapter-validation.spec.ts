import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseCaptureAdapter } from "../../../src/lib/engines/base-adapter.js";
import { CaptureFailureError } from "../../../src/lib/engines/failure-taxonomy.js";
import type { CaptureContext, CaptureInput, EngineKey } from "../../../src/lib/engines/contract.js";
import * as metrics from "../../../src/lib/telemetry/metrics.js";

// STORY-027 · scenario 2 — "Adapter returns a payload failing validation ->
// Classified malformed; no row written; metric incremented." AC:
// "Every adapter validates its vendor response against a schema before
// returning. The base class makes this the default path, so an adapter
// that skips it is visibly unusual." Writing a partially-understood
// response is worse than writing nothing (tracking-engine.md §2).
class FakeVendorAdapter extends BaseCaptureAdapter {
  readonly engineKey: EngineKey = "perplexity";
  readonly captureMode = "api" as const;
  readonly adapterVersion = "1.0.0-test";
  readonly supportsCitations = true;
  readonly concurrencyPerTask = 4;

  constructor(private readonly vendorPayload: unknown) {
    super();
  }

  protected async fetchVendorResponse(): Promise<unknown> {
    return this.vendorPayload;
  }

  async healthProbe() {
    return { ok: true, latencyMs: 0 };
  }
}

function makeInput(): CaptureInput {
  return {
    promptText: "Which CRM do you recommend for a 50-person startup?",
    locale: "en-US",
    sampleIndex: 0,
    requireCitations: false,
  };
}

function makeContext(): CaptureContext {
  return {
    signal: new AbortController().signal,
    span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() },
    recordCost: vi.fn(),
  };
}

const VALID_PAYLOAD = {
  text: "Answer text.",
  format: "markdown" as const,
  truncated: false,
  responseTokensEst: 100,
  latencyMs: 2500,
  costUsd: 0.01,
};

describe("STORY-027 · scenario 2 · a payload failing validation is classified malformed, returns nothing usable, and increments the alarming metric", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const badCases: Array<[string, unknown]> = [
    ["wrong format value", { ...VALID_PAYLOAD, format: "json" }],
    ["missing latencyMs", { text: "x", format: "markdown", truncated: false, responseTokensEst: 1, costUsd: 0 }],
    [
      "a citation with no slot",
      { ...VALID_PAYLOAD, structuredCitations: [{ url: "https://example.com" }] },
    ],
    ["a string where a number belongs (latencyMs)", { ...VALID_PAYLOAD, latencyMs: "fast" }],
  ];

  it.each(badCases)("%s -> capture() rejects with CaptureFailureError('malformed_response'), never resolves", async (_name, payload) => {
    const adapter = new FakeVendorAdapter(payload);
    await expect(adapter.capture(makeInput(), makeContext())).rejects.toMatchObject({
      code: "malformed_response",
    });
  });

  it.each(badCases)("%s -> the rejection is a CaptureFailureError instance", async (_name, payload) => {
    const adapter = new FakeVendorAdapter(payload);
    await expect(adapter.capture(makeInput(), makeContext())).rejects.toBeInstanceOf(CaptureFailureError);
  });

  it("increments nominara_capture_malformed_response_total exactly once per failure, labeled engine_key/adapter_version", async () => {
    const counterSpy = vi.spyOn(metrics, "incrementCounter");
    const adapter = new FakeVendorAdapter({ ...VALID_PAYLOAD, format: "json" });
    await expect(adapter.capture(makeInput(), makeContext())).rejects.toThrow();
    expect(counterSpy).toHaveBeenCalledTimes(1);
    expect(counterSpy).toHaveBeenCalledWith("nominara_capture_malformed_response_total", {
      engine_key: "perplexity",
      adapter_version: "1.0.0-test",
    });
  });

  it("recordCost is NOT called on a malformed response — validation happens before cost recording", async () => {
    const ctx = makeContext();
    const adapter = new FakeVendorAdapter({ ...VALID_PAYLOAD, format: "json" });
    await expect(adapter.capture(makeInput(), ctx)).rejects.toThrow();
    expect(ctx.recordCost).not.toHaveBeenCalled();
  });

  it("positive control: a valid payload resolves — validation is the default path, no subclass opt-in needed", async () => {
    const ctx = makeContext();
    const adapter = new FakeVendorAdapter(VALID_PAYLOAD);
    const result = await adapter.capture(makeInput(), ctx);
    expect(result).toEqual(VALID_PAYLOAD);
    expect(ctx.recordCost).toHaveBeenCalledWith(VALID_PAYLOAD.costUsd);
  });

  it("the malformed counter is not incremented on the positive control", async () => {
    const counterSpy = vi.spyOn(metrics, "incrementCounter");
    const adapter = new FakeVendorAdapter(VALID_PAYLOAD);
    await adapter.capture(makeInput(), makeContext());
    expect(counterSpy).not.toHaveBeenCalled();
  });

  it("records the failure on ctx.span before throwing — R-06 is span-visible, not just logged", async () => {
    const ctx = makeContext();
    const adapter = new FakeVendorAdapter({ ...VALID_PAYLOAD, format: "json" });
    await expect(adapter.capture(makeInput(), ctx)).rejects.toThrow();
    expect(ctx.span.recordException).toHaveBeenCalledTimes(1);
    expect(ctx.span.recordException).toHaveBeenCalledWith(expect.objectContaining({ code: "malformed_response" }));
  });

  it("does NOT record a span exception on the positive control", async () => {
    const ctx = makeContext();
    const adapter = new FakeVendorAdapter(VALID_PAYLOAD);
    await adapter.capture(makeInput(), ctx);
    expect(ctx.span.recordException).not.toHaveBeenCalled();
  });
});
