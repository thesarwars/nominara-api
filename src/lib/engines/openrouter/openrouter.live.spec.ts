import { describe, expect, it } from "vitest";
import { rawCaptureSchema, type CaptureContext } from "../contract.js";
import { OpenRouterAdapter, type OpenRouterEngineKey } from "./openrouter-adapter.js";
import { OpenRouterFreeProbe } from "./openrouter-free-probe.js";

// STORY-028 / owner decision 42 - live calls. OPT-IN and skipped by default: runs only when OPENROUTER_LIVE=1 AND OPENROUTER_API_KEY are
// both set. Never part of CI. The PAID block also needs OPENROUTER_LIVE_PAID=1, because EVERY RUN SPENDS CREDIT (about $0.07 gpt-5.4,
// $0.11 claude-sonnet-5.5, $0.006 perplexity/sonar per capture). The free block spends none, but free models are capped (50 requests a
// day on an account with no credit). Run by hand:
//   OPENROUTER_LIVE=1 OPENROUTER_API_KEY=... pnpm vitest run src/lib/engines/openrouter/openrouter.live.spec.ts
// To re-record the fixtures instead: scripts/record-openrouter-fixtures.mjs. Logs counts only, never the key or the answer text.
const key = process.env.OPENROUTER_API_KEY;
const enabled = process.env.OPENROUTER_LIVE === "1" && Boolean(key);
const paid = enabled && process.env.OPENROUTER_LIVE_PAID === "1";

const ctx = (): CaptureContext => ({
  signal: new AbortController().signal,
  span: { setAttribute: () => undefined, recordException: () => undefined, end: () => undefined },
  recordCost: () => undefined,
});

describe.skipIf(!enabled)("owner decision 42 - live free-model probe (plumbing only)", () => {
  it("a free gemma call returns text and costs nothing", async () => {
    const probe = new OpenRouterFreeProbe({ apiKey: key as string, model: "google/gemma-4-26b-a4b-it:free", nodeEnv: "test" });
    const result = await probe.probe("In two sentences, what is a CRM?");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.costUsd).toBe(0);
    console.log(JSON.stringify({ chars: result.text.length, latencyMs: result.latencyMs }));
  }, 60_000);

  it("the health probe reports the key healthy", async () => {
    const adapter = new OpenRouterAdapter({ engineKey: "perplexity", apiKey: key as string, timeoutMs: 15_000 });
    expect((await adapter.healthProbe()).ok).toBe(true);
  }, 30_000);
});

describe.skipIf(!paid)("owner decision 42 - live paid capture per engine (SPENDS CREDIT)", () => {
  for (const engine of ["perplexity", "chatgpt", "claude"] as const satisfies readonly OpenRouterEngineKey[]) {
    it(`${engine}: a valid capture with text, cost and latency`, async () => {
      const adapter = new OpenRouterAdapter({ engineKey: engine, apiKey: key as string, timeoutMs: 90_000 });
      const result = await adapter.capture({ promptText: "What are the best CRM tools for a 50-person startup?", locale: "en-US", sampleIndex: 0, requireCitations: true }, ctx());
      expect(rawCaptureSchema.safeParse(result).success).toBe(true);
      expect(result.latencyMs).toBeGreaterThan(0);
      console.log(JSON.stringify({ engine, chars: result.text.length, citations: result.structuredCitations?.length ?? 0, truncated: result.truncated, costUsd: result.costUsd }));
    }, 120_000);
  }
});
