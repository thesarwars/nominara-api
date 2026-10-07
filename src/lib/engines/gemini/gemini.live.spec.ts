import { describe, expect, it } from "vitest";
import { rawCaptureSchema, type CaptureContext } from "../contract.js";
import { GeminiApiAdapter } from "./gemini-api-adapter.js";

// STORY-028 · scenario 1 · live call. OPT-IN: runs only when GEMINI_LIVE=1 AND GEMINI_API_KEY are
// both set. Never part of CI (CI sets neither). Costs real money; run by hand:
//   GEMINI_LIVE=1 GEMINI_API_KEY=... pnpm vitest run src/lib/engines/gemini/gemini.live.spec.ts
const key = process.env.GEMINI_API_KEY;
const enabled = process.env.GEMINI_LIVE === "1" && Boolean(key);

describe.skipIf(!enabled)("STORY-028 · scenario 1 · live Gemini capture", () => {
  it("returns text, citations and latency", async () => {
    const ctx: CaptureContext = {
      signal: new AbortController().signal,
      span: { setAttribute: () => undefined, recordException: () => undefined, end: () => undefined },
      recordCost: () => undefined,
    };
    const adapter = new GeminiApiAdapter({ apiKey: key as string, timeoutMs: 30_000 });
    const result = await adapter.capture(
      { promptText: "What are the best CRM tools for a 50-person startup?", locale: "en-US", sampleIndex: 0, requireCitations: true },
      ctx,
    );
    expect(rawCaptureSchema.safeParse(result).success).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect((result.structuredCitations ?? []).length).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThan(0);
  }, 40_000);
});
