import { describe, expect, it } from "vitest";
import { capturePlanJobSchema } from "./capture-plan-job.schema.js";

const BASE = {
  workspaceId: "01a06ccd-9e37-7f0c-957b-195fa6d263dd",
  kid: "k1",
  projectId: "01a06ccd-9e37-7f0c-957b-195fa6d263de",
  trigger: "scheduled",
};

describe("NEW-A-10 · capturePlanJobSchema", () => {
  it("accepts a scheduled plan job", () => {
    expect(capturePlanJobSchema.parse(BASE)).toEqual(BASE);
  });

  it.each([
    ["an unknown key", { ...BASE, credits: 0 }],
    ["an engine list", { ...BASE, engines: ["gemini"] }],
    ["a manual trigger", { ...BASE, trigger: "manual" }],
    ["a missing project", { ...BASE, projectId: undefined }],
    ["a non-uuid project", { ...BASE, projectId: "nope" }],
  ])("refuses %s", (_label, body) => {
    expect(capturePlanJobSchema.safeParse(body).success).toBe(false);
  });
});
