import { describe, expect, it } from "vitest";
import { reparseResponseSchema } from "./reparse-response.schema.js";

// STORY-034 AC9 - the shape of the re-parse diff.

const snapshot = {
  normalizer_version: "n1",
  scoring_version: "v1",
  brand_present: true,
  brand_rank_position: 1,
  share_of_voice: 0.5,
  sentiment_label: "positive",
  sentiment_score: 0.4,
  citation_count: 1,
  owned_citation_count: 0,
  entities: [],
};
const response = { result_id: "01a06ccd-9e37-7f0c-957b-195fa6d263dd", scoring_version: "v1", changed: false, credits_charged: 0, before: snapshot, after: snapshot };

describe("reparseResponseSchema", () => {
  it("034-R1 · accepts a before/after pair", () => {
    expect(reparseResponseSchema.parse(response)).toEqual(response);
  });

  it("034-R2 · credits_charged can only be 0: a re-parse is free", () => {
    expect(reparseResponseSchema.safeParse({ ...response, credits_charged: 1 }).success).toBe(false);
  });

  it("034-R3 · a never-parsed capture is a null before, not a zero", () => {
    const before = { ...snapshot, brand_present: null, brand_rank_position: null, share_of_voice: null, sentiment_label: null, sentiment_score: null };
    expect(reparseResponseSchema.parse({ ...response, before }).before.share_of_voice).toBeNull();
  });

  it("034-R4 · refuses an unknown member (the diff is not a place to smuggle fields)", () => {
    expect(reparseResponseSchema.safeParse({ ...response, extra: 1 }).success).toBe(false);
    expect(reparseResponseSchema.safeParse({ ...response, after: { ...snapshot, extra: 1 } }).success).toBe(false);
  });
});
