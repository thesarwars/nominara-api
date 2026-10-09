import { describe, expect, it } from "vitest";
import { portalGrowthMapPointSchema, portalOverviewQuerySchema, portalProjectQuerySchema, portalTasksQuerySchema, portalTasksResponseSchema } from "./portal-read.schema.js";

// NEW-E-099a — the portal read contract. A request schema is .strict(): an unknown key is a 400, never a silent drop.
describe("NEW-E-099a · portal read contract", () => {
  const point = { d: "2026-10-01", visibility_score: 40, sov: 0.2, live_ratio: 1 };

  it("STORY-098 s12 · a portal growth-map point has no capture-count field (`cells`), for every token", () => {
    expect(portalGrowthMapPointSchema.safeParse(point).success).toBe(true);
    expect(portalGrowthMapPointSchema.safeParse({ ...point, cells: 12 }).success).toBe(false);
  });

  it("STORY-098 s10 · the project selector and an unknown query key: .strict() refuses the unknown key", () => {
    const project = "0198f6a0-0000-7000-8000-000000000001";
    expect(portalProjectQuerySchema.safeParse({ project, timeframe: "7d" }).success).toBe(true);
    expect(portalProjectQuerySchema.safeParse({ project, workspace_id: project }).success).toBe(false);
    expect(portalProjectQuerySchema.safeParse({ timeframe: "7d" }).success).toBe(false);
    expect(portalOverviewQuerySchema.safeParse({ scope: "x" }).success).toBe(false);
  });

  it("NEW-E-099b · the tasks query is .strict() and needs a project; the response carries no cost or capture field", () => {
    const project = "0198f6a0-0000-7000-8000-000000000001";
    expect(portalTasksQuerySchema.safeParse({ project }).success).toBe(true);
    expect(portalTasksQuerySchema.safeParse({ project, workspace_id: project }).success).toBe(false);
    expect(portalTasksQuerySchema.safeParse({}).success).toBe(false);
    const open = { title: "t", severity: null, status: "todo" };
    expect(portalTasksResponseSchema.safeParse({ completed: [], open: [open] }).success).toBe(true);
    expect(portalTasksResponseSchema.safeParse({ completed: [], open: [{ ...open, impact_score: 4 }] }).success).toBe(false);
    expect(portalTasksResponseSchema.safeParse({ completed: [], open: [{ ...open, status: "done" }] }).success).toBe(false);
  });
});
