import { describe, expect, it } from "vitest";
import { PAGINATION_LIMIT_DEFAULT, PAGINATION_LIMIT_MAX } from "../common/pagination.schema.js";
import { resultsListQuerySchema, resultListItemSchema } from "./results-list.schema.js";

// STORY-034 AC7 - the cursor list's query.

describe("resultsListQuerySchema", () => {
  it("034-L1 · defaults the limit and takes no filters", () => {
    expect(resultsListQuerySchema.parse({})).toEqual({ limit: PAGINATION_LIMIT_DEFAULT });
  });

  it("034-L2 · clamps an over-large limit to the cap rather than refusing it", () => {
    expect(resultsListQuerySchema.parse({ limit: "9999" }).limit).toBe(PAGINATION_LIMIT_MAX);
  });

  it("034-L3 · refuses an unknown key (offset pagination is not offered)", () => {
    expect(resultsListQuerySchema.safeParse({ offset: 10 }).success).toBe(false);
    expect(resultsListQuerySchema.safeParse({ page: 2 }).success).toBe(false);
  });

  it("034-L4 · lowercases a uuid filter and refuses a non-uuid", () => {
    const upper = "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11";
    expect(resultsListQuerySchema.parse({ prompt_id: upper }).prompt_id).toBe(upper.toLowerCase());
    expect(resultsListQuerySchema.safeParse({ run_id: "not-a-uuid" }).success).toBe(false);
  });

  it("034-L5 · refuses a status outside the column's vocabulary and a window that is not a timestamp", () => {
    expect(resultsListQuerySchema.safeParse({ status: "simulated" }).success).toBe(false);
    expect(resultsListQuerySchema.safeParse({ from: "yesterday" }).success).toBe(false);
    expect(resultsListQuerySchema.safeParse({ from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" }).success).toBe(true);
  });
});

describe("resultListItemSchema", () => {
  const item = {
    result_id: "01a06ccd-9e37-7f0c-957b-195fa6d263dd",
    run_id: "01a06ccd-9e37-7f0c-957b-195fa6d263de",
    prompt_id: "01a06ccd-9e37-7f0c-957b-195fa6d263df",
    engine_key: "gemini",
    sample_index: 0,
    captured_at: "2026-10-01T00:00:00.000Z",
    status: "failed",
    error_code: "rate_limited",
    cache_layer: "live",
    brand_present: null,
    citation_count: 0,
    scoring_version: "v1",
    response_excerpt: null,
  };

  it("034-L6 · a cell that could not be captured is a full item: status, error code, null presence - not an empty object", () => {
    expect(resultListItemSchema.parse(item)).toEqual(item);
  });

  it("034-L7 · brand_present false and null are different facts and both are valid", () => {
    expect(resultListItemSchema.parse({ ...item, status: "parsed", error_code: null, brand_present: false }).brand_present).toBe(false);
    expect(resultListItemSchema.parse(item).brand_present).toBeNull();
  });
});
