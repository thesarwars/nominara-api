import { describe, expect, it, vi } from "vitest";
import { BaseCaptureAdapter } from "../../../src/lib/engines/base-adapter.js";
import { captureInputSchema, rawCaptureSchema, type CaptureContext, type CaptureInput, type EngineKey } from "../../../src/lib/engines/contract.js";

// STORY-027 T18 — boundary values. Numeric constants matter exactly here:
// sampleIndex/latencyMs/responseTokensEst/costUsd's floor is 0 (a genuine
// value, not absence); citation slot's floor is 1 (STORY-027 Implementation
// decisions — the position-weight formula divides by zero at slot 0).
describe("STORY-027 · T18 · boundary values", () => {
  const validInput = {
    promptText: "x",
    locale: "en-US",
    sampleIndex: 0,
    requireCitations: false,
  };

  it("sampleIndex: 0 is valid", () => {
    expect(captureInputSchema.safeParse(validInput).success).toBe(true);
  });

  it("sampleIndex: -1 is invalid", () => {
    expect(captureInputSchema.safeParse({ ...validInput, sampleIndex: -1 }).success).toBe(false);
  });

  it("empty-string promptText fails validation", () => {
    expect(captureInputSchema.safeParse({ ...validInput, promptText: "" }).success).toBe(false);
  });

  it("a long promptText passes", () => {
    expect(captureInputSchema.safeParse({ ...validInput, promptText: "x".repeat(2000) }).success).toBe(true);
  });

  it("locale 'en-US' shape passes; a malformed shape is rejected", () => {
    expect(captureInputSchema.safeParse({ ...validInput, locale: "en-US" }).success).toBe(true);
    expect(captureInputSchema.safeParse({ ...validInput, locale: "english" }).success).toBe(false);
    expect(captureInputSchema.safeParse({ ...validInput, locale: "EN_us" }).success).toBe(false);
  });

  const validCapture = {
    text: "Answer",
    format: "markdown" as const,
    truncated: false,
    responseTokensEst: 0,
    latencyMs: 0,
    costUsd: 0,
  };

  it("costUsd: 0 (a cached/free capture) is valid", () => {
    expect(rawCaptureSchema.safeParse(validCapture).success).toBe(true);
  });

  it("latencyMs: 0 is valid", () => {
    expect(rawCaptureSchema.safeParse({ ...validCapture, latencyMs: 0 }).success).toBe(true);
  });

  it("responseTokensEst: 0 is valid", () => {
    expect(rawCaptureSchema.safeParse({ ...validCapture, responseTokensEst: 0 }).success).toBe(true);
  });

  it("citation slot: 1 is the minimum valid", () => {
    expect(
      rawCaptureSchema.safeParse({ ...validCapture, structuredCitations: [{ url: "https://example.com", slot: 1 }] })
        .success,
    ).toBe(true);
  });

  it("citation slot: 0 FAILS validation (1-based; the position-weight formula divides by zero at 0)", () => {
    expect(
      rawCaptureSchema.safeParse({ ...validCapture, structuredCitations: [{ url: "https://example.com", slot: 0 }] })
        .success,
    ).toBe(false);
  });

  class FakeAdapter extends BaseCaptureAdapter {
    readonly engineKey: EngineKey = "perplexity";
    readonly captureMode = "api" as const;
    readonly adapterVersion = "1.0.0-test";
    readonly supportsCitations = true;
    readonly concurrencyPerTask = 1;

    protected async fetchVendorResponse(): Promise<unknown> {
      return validCapture;
    }

    async healthProbe() {
      return { ok: true, latencyMs: 0 };
    }
  }

  function makeInput(): CaptureInput {
    return { promptText: "x", locale: "en-US", sampleIndex: 0, requireCitations: false };
  }

  function makeContext(recordCost: (usd: number) => void): CaptureContext {
    return {
      signal: new AbortController().signal,
      span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() },
      recordCost,
    };
  }

  it("costUsd: 0 still calls recordCost(0) — a free capture is a real cost record, not a skipped one", async () => {
    const recordCost = vi.fn();
    const adapter = new FakeAdapter();
    await adapter.capture(makeInput(), makeContext(recordCost));
    expect(recordCost).toHaveBeenCalledWith(0);
    expect(recordCost).toHaveBeenCalledTimes(1);
  });
});
