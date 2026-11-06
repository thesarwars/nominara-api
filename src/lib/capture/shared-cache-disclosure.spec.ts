import { describe, expect, it } from "vitest";
import type { Cache } from "../cache/cache.port.js";
import { seedSharedCache, type CaptureCellInput } from "./execute-cell.js";

// STORY-111 / NFR-CMP-14, scenario 29 - the shared answer cache holds ONLY public engine answers to public questions, under a global key,
// with no tenant-derived content in the key or the value. (The opt-out, `no_shared_cache`, is enforced by the planner: capture-plan.handler.ts
// `sharedCacheEnabled`, manual-run.ts; the key's tenant-freedom is pinned by test/unit/capture-l1-cache-key.spec.ts.)
const WS = "01990000-0000-7000-8000-0000000000aa";
const PROJECT = "01990000-0000-7000-8000-0000000000bb";
const RUN = "01990000-0000-7000-8000-0000000000cc";
const PROMPT_ID = "01990000-0000-7000-8000-0000000000dd";

describe("STORY-111 shared cache entry (scenario 29)", () => {
  it("S29 neither the key nor the value carries any tenant-derived identifier, and the value's excerpt is minimised", async () => {
    const writes: { key: string; value: string }[] = [];
    const cache = { set: (key: string, value: string) => { writes.push({ key, value }); return Promise.resolve(); } } as unknown as Cache;
    const input: CaptureCellInput = {
      workspaceId: WS, projectId: PROJECT, runId: RUN, promptId: PROMPT_ID, promptText: "best crm for small teams", engineKey: "gemini",
      sampleIndex: 0, adapterVersion: "1.0.0", ttlSeconds: 3600, locale: "en-US", personaHint: null, normalizerVersion: "n1",
    };
    await seedSharedCache(cache, input, { format: "text", text: "Try Acme CRM. Write to sales@acme.example or call +1 415 555 2671.", truncated: false, latencyMs: 10, responseTokensEst: 12 } as never, new Date("2026-11-06T00:00:00Z"));
    expect(writes).toHaveLength(1);
    const { key, value } = writes[0]!;
    for (const id of [WS, PROJECT, RUN, PROMPT_ID]) {
      expect(key).not.toContain(id);
      expect(value).not.toContain(id);
    }
    expect(Object.keys(JSON.parse(value) as object).sort()).toEqual(["capturedAt", "contentHash", "excerpt", "payload", "v"]);
    const envelope = JSON.parse(value) as { excerpt: string };
    expect(envelope.excerpt).toContain("Try Acme CRM");
    expect(envelope.excerpt).not.toMatch(/sales@acme|555/);
  });
});
