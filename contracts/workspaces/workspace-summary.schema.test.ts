import { describe, expect, it } from "vitest";
import { workspaceSummaryResponseSchema } from "./workspace-summary-response.schema.js";

const base = {
  workspace_id: "11111111-1111-7111-8111-111111111111",
  plan_key: "growth",
  window_days: 30,
  projects: [],
  engines: [{ engine_key: "gemini", data_source: "live" }],
  health: { projects_used: 0, projects_limit: 3, prompts_used: 0, prompts_limit: null, credits: null },
};

describe("NEW-B-2 · workspace summary contract", () => {
  it("accepts an empty matrix and null limits (null is not zero)", () => {
    expect(workspaceSummaryResponseSchema.parse(base)).toEqual(base);
  });
  it("refuses a window other than 30 days and an unknown data_source", () => {
    expect(workspaceSummaryResponseSchema.safeParse({ ...base, window_days: 7 }).success).toBe(false);
    expect(
      workspaceSummaryResponseSchema.safeParse({ ...base, engines: [{ engine_key: "x", data_source: "mock" }] }).success,
    ).toBe(false);
  });
  it("is strict", () => {
    expect(workspaceSummaryResponseSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
