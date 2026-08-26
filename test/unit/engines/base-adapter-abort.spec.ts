import { describe, expect, it, vi } from "vitest";
import { BaseCaptureAdapter } from "../../../src/lib/engines/base-adapter.js";
import type { CaptureInput, EngineKey } from "../../../src/lib/engines/contract.js";
import * as metrics from "../../../src/lib/telemetry/metrics.js";

// STORY-027 · scenario 6 — "Abort mid-capture -> The signal is honoured and
// no partial row is written." Three checkpoints only: pre-fetch, post-fetch,
// pre-return `signal.throwIfAborted()` (no extra AbortController plumbing).
const VALID_PAYLOAD = {
  text: "Answer text.",
  format: "markdown" as const,
  truncated: false,
  responseTokensEst: 100,
  latencyMs: 2500,
  costUsd: 0.01,
};

class AbortAwareFakeAdapter extends BaseCaptureAdapter {
  readonly engineKey: EngineKey = "perplexity";
  readonly captureMode = "api" as const;
  readonly adapterVersion = "1.0.0-test";
  readonly supportsCitations = true;
  readonly concurrencyPerTask = 4;

  fetchInvoked = false;

  constructor(private readonly deferred: Promise<unknown>) {
    super();
  }

  protected async fetchVendorResponse(): Promise<unknown> {
    this.fetchInvoked = true;
    return this.deferred;
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

describe("STORY-027 · scenario 6 · an abort mid-capture is honoured and yields nothing persistable", () => {
  it("an already-aborted signal before capture() rejects immediately, vendor-fetch is never invoked", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new AbortAwareFakeAdapter(Promise.resolve(VALID_PAYLOAD));
    const recordCost = vi.fn();

    await expect(
      adapter.capture(makeInput(), {
        signal: controller.signal,
        span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() },
        recordCost,
      }),
    ).rejects.toThrow();

    expect(adapter.fetchInvoked).toBe(false);
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("aborted while the vendor-fetch is in flight rejects, recordCost is never called", async () => {
    const controller = new AbortController();
    let resolveDeferred!: (value: unknown) => void;
    const deferred = new Promise((resolve) => {
      resolveDeferred = resolve;
    });
    const adapter = new AbortAwareFakeAdapter(deferred);
    const recordCost = vi.fn();

    const capturePromise = adapter.capture(makeInput(), {
      signal: controller.signal,
      span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() },
      recordCost,
    });

    controller.abort();
    resolveDeferred(VALID_PAYLOAD);

    await expect(capturePromise).rejects.toThrow();
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("aborted after a valid payload arrives but before return still rejects (pre-return checkpoint)", async () => {
    const controller = new AbortController();
    const adapter = new AbortAwareFakeAdapter(Promise.resolve(VALID_PAYLOAD));
    const recordCost = vi.fn(() => {
      // Abort lands between recordCost and the final return.
      controller.abort();
    });

    await expect(
      adapter.capture(makeInput(), {
        signal: controller.signal,
        span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() },
        recordCost,
      }),
    ).rejects.toThrow();

    expect(recordCost).toHaveBeenCalledTimes(1);
  });

  it("an abort rejection is distinguishable from malformed_response — the malformed counter has zero calls", async () => {
    const counterSpy = vi.spyOn(metrics, "incrementCounter");
    const controller = new AbortController();
    controller.abort();
    const adapter = new AbortAwareFakeAdapter(Promise.resolve(VALID_PAYLOAD));

    await expect(
      adapter.capture(makeInput(), {
        signal: controller.signal,
        span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() },
        recordCost: vi.fn(),
      }),
    ).rejects.not.toMatchObject({ code: "malformed_response" });

    expect(counterSpy).not.toHaveBeenCalled();
  });
});
