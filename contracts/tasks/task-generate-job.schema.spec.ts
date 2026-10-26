import { describe, expect, it } from "vitest";
import { taskGenerationConditionSchema } from "./task-generation.schema.js";
import { TASK_TRIGGER_KINDS, taskGenerateJobPayloadSchema } from "./task-generate-job.schema.js";

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
  it("rejects a trigger kind that no rule can have (a typo would narrow the evaluation to nothing)", () => {
    expect(taskGenerateJobPayloadSchema.safeParse({ ...base, triggerKinds: ["aux_findings"] }).success).toBe(false);
  });
  it("lists exactly the condition kinds of the task-generation contract", () => {
    const kinds = taskGenerationConditionSchema.options.map((o) => o.shape.kind.value);
    expect([...TASK_TRIGGER_KINDS].sort()).toEqual([...kinds].sort());
  });
});
