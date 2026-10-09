import { describe, expect, it } from "vitest";
import { growthMapQuerySchema } from "../../../contracts/analytics/index.js";
import { narrowToEntitled, parseEngineFilter } from "../../../src/lib/analytics/engine-filter.js";

// NEW-A-14 — api-specification §7: `engines` is a comma list or `all`, and it
// only NARROWS the entitled set.

describe("NEW-A-14 · engine filter", () => {
  it("NEW-A-14 AC1 — the growth-map query accepts engines as a list or `all`", () => {
    expect(growthMapQuerySchema.safeParse({ engines: "gemini" }).success).toBe(true);
    expect(growthMapQuerySchema.safeParse({ engines: "gemini,chatgpt" }).success).toBe(true);
    expect(growthMapQuerySchema.safeParse({ engines: "all" }).success).toBe(true);
    expect(growthMapQuerySchema.safeParse({}).success).toBe(true);
  });

  it("NEW-A-14 AC1 — the query stays strict: topics and an `all` beside a key are still 400s", () => {
    expect(growthMapQuerySchema.safeParse({ topics: "x" }).success).toBe(false);
    expect(growthMapQuerySchema.safeParse({ engines: "all,gemini" }).success).toBe(false);
    expect(growthMapQuerySchema.safeParse({ engines: "" }).success).toBe(false);
    expect(growthMapQuerySchema.safeParse({ engines: "gemini,,chatgpt" }).success).toBe(false);
  });

  it("NEW-A-14 AC1 — absent and `all` mean no narrowing (null), a list is trimmed", () => {
    expect(parseEngineFilter(undefined)).toBeNull();
    expect(parseEngineFilter("all")).toBeNull();
    expect(parseEngineFilter(" gemini , chatgpt ")).toEqual(["gemini", "chatgpt"]);
  });

  it("NEW-A-14 AC2 — narrowing keeps only entitled engines and never widens", () => {
    expect(narrowToEntitled(["gemini"], ["gemini", "chatgpt"])).toEqual(["gemini"]);
    expect(narrowToEntitled(["claude"], ["gemini", "chatgpt"])).toEqual([]);
    expect(narrowToEntitled(["gemini", "claude"], ["gemini"])).toEqual(["gemini"]);
    expect(narrowToEntitled(null, ["gemini", "chatgpt"])).toEqual(["gemini", "chatgpt"]);
  });
});
