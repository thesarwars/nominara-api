import { describe, expect, it } from "vitest";
import { taskGenerationConditionSchema } from "./task-generation.schema.js";
import { TASK_CONDITION_KINDS, taskGenerateJobPayloadSchema } from "./task-generate-job.schema.js";

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
  it("STORY-193 AC2 · the condition kinds are their own constant, pinned to the task-generation contract", () => {
    const kinds = taskGenerationConditionSchema.options.map((o) => o.shape.kind.value);
    expect([...TASK_CONDITION_KINDS].sort()).toEqual([...kinds].sort());
  });
  it("STORY-193 AC3 · a value the trigger_kind column cannot hold (geo_finding, metric_window) is rejected at the boundary", () => {
    for (const kind of ["geo_finding", "metric_window"]) {
      expect(taskGenerateJobPayloadSchema.safeParse({ ...base, triggerKinds: [kind] }).success, kind).toBe(false);
    }
  });
  it("STORY-193 AC3 · a valid column value (entity_node, and the borrowed kinds) is accepted", () => {
    for (const kind of ["entity_node", "schema_missing", "sentiment_negative", "aux_finding"]) {
      expect(taskGenerateJobPayloadSchema.safeParse({ ...base, triggerKinds: [kind] }).success, kind).toBe(true);
    }
  });
  it("STORY-193 AC4 · the producers' shapes are unchanged: the AUX audit's ['aux_finding'] and the rollup's unnarrowed job both parse", () => {
    expect(taskGenerateJobPayloadSchema.safeParse({ ...base, triggerKinds: ["aux_finding"] }).success).toBe(true);
    expect(taskGenerateJobPayloadSchema.parse(base).triggerKinds).toBeUndefined();
  });
});
