import { describe, expect, it } from "vitest";
import { parseCapture } from "../../parser/parse-capture.js";
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

    // NEW-A-4 AC6, second half: run the capture through the REAL parse stage (default guarded
    // fetch) and require the vertexaisearch grounding redirects to resolve to more than one
    // distinct, non-wrapper domain. Logs counts only, never the key or the answer text.
    const parsed = await parseCapture(
      {
        resultId: "live-smoke",
        workspaceId: "live-smoke",
        projectId: "live-smoke",
        promptId: "live-smoke",
        engineKey: "gemini",
        capturedAt: new Date(),
        text: result.text,
        structuredCitations: (result.structuredCitations ?? []).map((c) => ({
          url: c.url,
          slot: c.slot,
          ...(c.title !== undefined ? { title: c.title } : {}),
        })),
        flags: [],
      },
      { rootDomain: "example.invalid", ownedDomains: [], competitorDomains: [], negativeAliases: [], aliases: [] },
    );
    const resolved = parsed.citations.filter((c) => c.httpStatus !== null);
    const domains = new Set(resolved.map((c) => c.domain));
    process.stdout.write(
      `gemini-live-smoke citations=${parsed.citations.length} resolved=${resolved.length} distinctDomains=${domains.size} latencyMs=${result.latencyMs}\n`,
    );
    expect(resolved.length).toBeGreaterThan(1);
    expect(domains.size).toBeGreaterThan(1);
    expect([...domains].some((d) => d.endsWith("vertexaisearch.cloud.google.com"))).toBe(false);
  }, 90_000);
});
