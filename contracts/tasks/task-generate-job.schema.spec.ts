import { describe, expect, it } from "vitest";
import { taskGenerateJobPayloadSchema } from "./task-generate-job.schema.js";

const base = { workspaceId: "0190f3a4-7b1e-7c3a-8f2d-1a2b3c4d5e6f", kid: "k1", projectId: "0190f3a4-7b1e-7c3a-8f2d-1a2b3c4d5e70" };

describe("STORY-052 AC10 · the task.generate job payload", () => {
  it("accepts the AUX producer's shape: a project narrowed to aux_finding", () => {
    expect(taskGenerateJobPayloadSchema.parse({ ...base, triggerKinds: ["aux_finding"] })).toEqual({ ...base, triggerKinds: ["aux_finding"] });
  });
  it("accepts the rollup producer's shape: a project and a day, no narrowing", () => {
    expect(taskGenerateJobPayloadSchema.parse({ ...base, metricDate: "2026-10-23" }).triggerKinds).toBeUndefined();
  });
  it("rejects an unknown key rather than dropping it", () => {
    expect(taskGenerateJobPayloadSchema.safeParse({ ...base, severity: "critical" }).success).toBe(false);
  });
  it("rejects an empty trigger list (it would narrow the evaluation to nothing) and a malformed day", () => {
    expect(taskGenerateJobPayloadSchema.safeParse({ ...base, triggerKinds: [] }).success).toBe(false);
    expect(taskGenerateJobPayloadSchema.safeParse({ ...base, metricDate: "23/10/2026" }).success).toBe(false);
  });
});
