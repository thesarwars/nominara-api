import { describe, expect, it, vi } from "vitest";
import { BaseCaptureAdapter } from "../../../src/lib/engines/base-adapter.js";
import { captureFlagSchema, rawCaptureSchema, type CaptureContext, type CaptureInput, type EngineKey } from "../../../src/lib/engines/contract.js";
import { classifyCaptureFailure } from "../../../src/lib/engines/failure-taxonomy.js";
import * as metrics from "../../../src/lib/telemetry/metrics.js";

// STORY-027 · scenarios 3-4 · NFR-SIM-07 — "A policy refusal and a
// successful-but-empty response are not failures. Both return a valid
// capture flagged appropriately, and neither is ever retried." Retrying
// would bias the dataset toward answerable prompts (tracking-engine.md §2).
class RefusalOrEmptyFakeAdapter extends BaseCaptureAdapter {
  readonly engineKey: EngineKey = "chatgpt";
  readonly captureMode = "api" as const;
  readonly adapterVersion = "1.0.0-test";
  readonly supportsCitations = false;
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
    promptText: "What complaints do teams have about Acme CRM?",
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

const REFUSAL_PAYLOAD = {
  text: "I can't help with that request.",
  format: "markdown" as const,
  truncated: false,
  responseTokensEst: 12,
  latencyMs: 900,
  costUsd: 0.001,
  flags: ["engine_refused_to_answer"],
};

const EMPTY_PAYLOAD = {
  text: "",
  format: "markdown" as const,
  truncated: false,
  responseTokensEst: 0,
  latencyMs: 800,
  costUsd: 0.001,
  flags: ["empty_answer"],
};

describe("STORY-027 · scenarios 3-4 · NFR-SIM-07 · a refusal and an empty answer are valid captures, flagged, never retried", () => {
  it("a policy refusal resolves a valid RawCapture carrying engine_refused_to_answer, and does NOT throw", async () => {
    const adapter = new RefusalOrEmptyFakeAdapter(REFUSAL_PAYLOAD);
    const result = await adapter.capture(makeInput(), makeContext());
    expect(result.flags).toEqual(["engine_refused_to_answer"]);
  });

  it("a successful-but-empty answer resolves carrying an empty-answer flag, and does NOT throw", async () => {
    const adapter = new RefusalOrEmptyFakeAdapter(EMPTY_PAYLOAD);
    const result = await adapter.capture(makeInput(), makeContext());
    expect(result.flags).toEqual(["empty_answer"]);
  });

  it("neither is retryable — content_policy_refusal is not in the failure classifier's set at all", () => {
    expect(classifyCaptureFailure("content_policy_refusal")).toBeNull();
  });

  it("the malformed counter is NOT incremented for either case", async () => {
    const counterSpy = vi.spyOn(metrics, "incrementCounter");
    await new RefusalOrEmptyFakeAdapter(REFUSAL_PAYLOAD).capture(makeInput(), makeContext());
    await new RefusalOrEmptyFakeAdapter(EMPTY_PAYLOAD).capture(makeInput(), makeContext());
    expect(counterSpy).not.toHaveBeenCalled();
  });

  it("captureFlagSchema is a closed enum including at least engine_refused_to_answer and empty_answer", () => {
    expect(captureFlagSchema.safeParse("engine_refused_to_answer").success).toBe(true);
    expect(captureFlagSchema.safeParse("empty_answer").success).toBe(true);
    expect(captureFlagSchema.safeParse("made_up_flag").success).toBe(false);
  });

  it("flags on rawCaptureSchema is a string[] matching answer_captures.flags' text[] shape, and round-trips an empty array", () => {
    expect(
      rawCaptureSchema.safeParse({
        ...EMPTY_PAYLOAD,
        flags: [],
      }).success,
    ).toBe(true);
  });

  it("the base adapter passes flags through untouched — it never invents them", async () => {
    const adapter = new RefusalOrEmptyFakeAdapter({ ...REFUSAL_PAYLOAD, flags: ["engine_refused_to_answer"] });
    const result = await adapter.capture(makeInput(), makeContext());
    expect(result.flags).toEqual(["engine_refused_to_answer"]);
  });
});
