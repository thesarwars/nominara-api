import { describe, expect, it, vi } from "vitest";
import { BaseCaptureAdapter } from "../../../src/lib/engines/base-adapter.js";
import type { CaptureContext, CaptureInput, EngineKey } from "../../../src/lib/engines/contract.js";
import { resolveEngine } from "../../../src/lib/engines/registry.js";

// STORY-027 T18 — concurrency. concurrencyPerTask >= 1 for every active
// adapter; two concurrent capture() calls on the SAME instance must not
// share or interleave mutable state; one adapter failing must never affect
// a concurrent capture on a DIFFERENT engine's adapter instance
// (tracking-engine.md FR-SIM-01b: "a single engine outage never blocks the
// others").
const ACTIVE_ENGINE_KEYS = ["google_aio", "google_ai_mode", "perplexity", "chatgpt", "gemini", "claude"] as const;

function makeInput(promptText: string): CaptureInput {
  return { promptText, locale: "en-US", sampleIndex: 0, requireCitations: false };
}

function makeContext(recordCost: (usd: number) => void): CaptureContext {
  return {
    signal: new AbortController().signal,
    span: { setAttribute: vi.fn(), recordException: vi.fn(), end: vi.fn() },
    recordCost,
  };
}

describe("STORY-027 · T18 · concurrency", () => {
  it("concurrencyPerTask is >= 1 for all 6 active adapters", () => {
    for (const engineKey of ACTIVE_ENGINE_KEYS) {
      const adapter = resolveEngine(engineKey);
      expect(adapter.concurrencyPerTask, engineKey).toBeGreaterThanOrEqual(1);
    }
  });

  it("two concurrent capture() calls on the SAME adapter instance resolve their own distinct payloads, with exactly 2 recordCost calls total", async () => {
    const adapter = resolveEngine("perplexity");
    const recordCost = vi.fn();

    const [normalResult, refusalResult] = await Promise.all([
      adapter.capture(makeInput("normal"), makeContext(recordCost)),
      adapter.capture(makeInput("refusal"), makeContext(recordCost)),
    ]);

    expect(normalResult.flags ?? []).not.toContain("engine_refused_to_answer");
    expect(refusalResult.flags).toEqual(["engine_refused_to_answer"]);
    expect(recordCost).toHaveBeenCalledTimes(2);
  });

  it("does not interleave state across many concurrent calls on one instance — each call's own case is preserved end to end", async () => {
    const adapter = resolveEngine("chatgpt");
    const cases = ["normal", "empty", "truncated", "redirect_heavy_citations", "priced_product_element"] as const;

    const results = await Promise.all(
      cases.map((fixtureCase) => adapter.capture(makeInput(fixtureCase), makeContext(vi.fn()))),
    );

    expect(results[1]?.flags).toEqual(["empty_answer"]); // "empty"
    expect(results[2]?.truncated).toBe(true); // "truncated"
    for (const [index, fixtureCase] of cases.entries()) {
      if (fixtureCase !== "truncated") {
        expect(results[index]?.truncated, fixtureCase).toBe(false);
      }
    }
  });

  class FailingAdapter extends BaseCaptureAdapter {
    readonly engineKey: EngineKey = "gemini";
    readonly captureMode = "api" as const;
    readonly adapterVersion = "1.0.0-test";
    readonly supportsCitations = true;
    readonly concurrencyPerTask = 1;

    protected async fetchVendorResponse(): Promise<unknown> {
      return { text: "broken", format: "not-a-real-format" };
    }

    async healthProbe() {
      return { ok: true, latencyMs: 0 };
    }
  }

  it("one adapter instance failing does not affect a concurrent capture on a DIFFERENT engine's adapter instance", async () => {
    const failing = new FailingAdapter();
    const healthy = resolveEngine("claude");

    const [failingOutcome, healthyOutcome] = await Promise.allSettled([
      failing.capture(makeInput("normal"), makeContext(vi.fn())),
      healthy.capture(makeInput("normal"), makeContext(vi.fn())),
    ]);

    expect(failingOutcome.status).toBe("rejected");
    expect(healthyOutcome.status).toBe("fulfilled");
    if (healthyOutcome.status === "fulfilled") {
      expect(healthyOutcome.value.text.length).toBeGreaterThan(0);
    }
  });
});
