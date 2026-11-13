import { describe, expect, it } from "vitest";
import { gscPromptCandidatesQuerySchema, gscPromptCandidateSchema, gscPromptCandidatesSchema } from "./gsc.schema.js";

describe("STORY-115 AC11 · gscPromptCandidates contract", () => {
  const candidate = { text: "best crm for roofers", source: "gsc_query", report: "classic", label: "real Google query", impressions: 0, clicks: 0 };

  it("the query is strict, defaults to 90d and 25, and bounds the limit", () => {
    expect(gscPromptCandidatesQuerySchema.parse({})).toEqual({ timeframe: "90d", limit: 25 });
    expect(gscPromptCandidatesQuerySchema.parse({ limit: "50" }).limit).toBe(50);
    expect(gscPromptCandidatesQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(gscPromptCandidatesQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(gscPromptCandidatesQuerySchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("a candidate is labelled a real Google query from the classic report; a measured zero is a zero", () => {
    expect(gscPromptCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(gscPromptCandidateSchema.safeParse({ ...candidate, label: "generated" }).success).toBe(false);
    expect(gscPromptCandidateSchema.safeParse({ ...candidate, report: "ai_surface" }).success).toBe(false);
    expect(gscPromptCandidateSchema.safeParse({ ...candidate, ai_prompt_volume: 12 }).success).toBe(false);
  });

  it("the response is strict and a disconnected project is expressible with null frontier", () => {
    const response = { connected: false, health_status: null, window_days: 90, window_start: null, window_end: null, frontier: null, frontier_note: "n", limits_note: "n", candidates: [] };
    expect(gscPromptCandidatesSchema.safeParse(response).success).toBe(true);
    expect(gscPromptCandidatesSchema.safeParse({ ...response, estimated_volume: 1 }).success).toBe(false);
  });
});
