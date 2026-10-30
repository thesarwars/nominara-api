import { describe, expect, it } from "vitest";
import { rawCaptureSchema, type CaptureContext } from "../contract.js";
import { LicensedSerpAdapter } from "./licensed-serp.js";
import { SerpApiProvider } from "./serpapi-provider.js";

// STORY-029 · scenario 1 · live call per surface. OPT-IN: runs only when SERP_LIVE=1 AND SERP_API_KEY are both set. Never part of CI
// (CI sets neither). EVERY RUN SPENDS SEARCHES - an AI Overview that loads on demand costs two, AI Mode one - and the Free plan has 250
// a month. Run by hand, and only when you mean to:
//   SERP_LIVE=1 SERP_API_KEY=... pnpm vitest run src/lib/engines/serp/serp.live.spec.ts
// Logs counts only, never the key or the answer text.
const key = process.env.SERP_API_KEY;
const enabled = process.env.SERP_LIVE === "1" && Boolean(key);

describe.skipIf(!enabled)("STORY-029 · scenario 1 · live SerpApi capture", () => {
  for (const surface of ["google_ai_mode", "google_aio"] as const) {
    it(`${surface}: a valid capture, async flag recorded, live mode`, async () => {
      const ctx: CaptureContext = {
        signal: new AbortController().signal,
        span: { setAttribute: () => undefined, recordException: () => undefined, end: () => undefined },
        recordCost: () => undefined,
      };
      const adapter = new LicensedSerpAdapter(surface, { provider: new SerpApiProvider({ apiKey: key as string }), timeoutMs: 60_000 });
      const result = await adapter.capture({ promptText: "how to choose a CRM for a small business", locale: "en-US", sampleIndex: 0, requireCitations: true, requestMode: "live" }, ctx);
      expect(rawCaptureSchema.safeParse(result).success).toBe(true);
      // Either an answer or a flagged genuine absence - never a silent empty.
      expect(result.text.length > 0 || (result.flags ?? []).length > 0).toBe(true);
      console.log(JSON.stringify({ surface, chars: result.text.length, citations: result.structuredCitations?.length ?? 0, elements: result.structuredElements?.length ?? 0, asyncGenerated: result.asyncGenerated }));
    }, 90_000);
  }
});
