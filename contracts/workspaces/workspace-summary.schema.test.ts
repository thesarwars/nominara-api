import { describe, expect, it } from "vitest";
import { lastScanSchema, projectListItemSchema } from "../projects/project-list-response.schema.js";
import { summaryProjectSchema, workspaceSummaryResponseSchema } from "./workspace-summary-response.schema.js";

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

  // STORY-175 AC1 - `last_scan` is additive, nullable, strict, and null is not "queued".
  describe("STORY-175 AC1 · last_scan", () => {
    const scan = {
      run_id: "33333333-3333-7333-8333-333333333333",
      status: "running",
      trigger: "manual",
      planned_cells: 17,
      settled_cells: 11,
      captured_cells: 11,
      started_at: "2026-10-12T13:00:00.000Z",
      completed_at: null,
      rolled_up: false,
    };
    it("STORY-175 AC1: accepts a full scan object, with completed_at and started_at nullable", () => {
      expect(lastScanSchema.parse(scan)).toEqual(scan);
      expect(lastScanSchema.safeParse({ ...scan, started_at: null }).success).toBe(true);
      expect(lastScanSchema.safeParse({ ...scan, status: "completed", completed_at: "2026-10-12T13:08:00.000Z" }).success).toBe(true);
    });
    it("STORY-175 AC1: refuses an unknown status, a missing key, an extra key and a negative count", () => {
      expect(lastScanSchema.safeParse({ ...scan, status: "done" }).success).toBe(false);
      const { rolled_up: _omit, ...missing } = scan;
      expect(lastScanSchema.safeParse(missing).success).toBe(false);
      expect(lastScanSchema.safeParse({ ...scan, extra: 1 }).success).toBe(false);
      expect(lastScanSchema.safeParse({ ...scan, planned_cells: -1 }).success).toBe(false);
    });
    // Optional ON THE SCHEMA so the published change reads as additive (diff.ts rates a new REQUIRED
    // response field `major`); the API always emits it, null when the project has no run.
    it("STORY-175 AC1: last_scan is on the project list row and, by derivation, the summary row - null or an object, optional for old payloads", () => {
      for (const schema of [projectListItemSchema, summaryProjectSchema]) {
        expect(schema.shape.last_scan.safeParse(null).success).toBe(true);
        expect(schema.shape.last_scan.safeParse(scan).success).toBe(true);
        expect(schema.shape.last_scan.safeParse(undefined).success).toBe(true);
        expect(schema.shape.last_scan.safeParse({ ...scan, extra: 1 }).success).toBe(false);
      }
    });
  });
});
