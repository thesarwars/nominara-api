import { describe, expect, it } from "vitest";
import { taskEvidenceSchema, taskSchema, TASK_EVIDENCE_KINDS } from "./task-response.schema.js";
import { MEASURED_IMPACT_CAVEAT } from "./task-verification.schema.js";

const base = {
  id: "0190b1c0-0000-7000-8000-000000000001", short_ref: "HUB-1", project_id: "0190b1c0-0000-7000-8000-000000000002", goal_id: null, title: "t", description: "d",
  kind: "content", origin: "auto", status: "todo", severity: null, source: "content", rule_code: null, priority: 3, impact_score: 10, effort: null, assignee_id: null,
  due_at: null, dismissed_reason: null, resurface_at: null, completed_at: null, affected_url: null, seeding: false, review: null,
  evidence: null, measured_impact: null, patch: null, playbook_slug: null, created_at: "2026-11-12T00:00:00.000Z", updated_at: "2026-11-12T00:00:00.000Z",
};
const impact = {
  visibility_before: 1, visibility_after_14d: 2, delta: 1, window_days: 14, confidence: "low", method: "m", scoring_version: "v", caveat: MEASURED_IMPACT_CAVEAT,
  n_before: 1, n_after: 1, other_milestones_nearby: 0,
};

describe("STORY-194 · the task row's evidence, measured impact, patch and playbook on the wire", () => {
  it("[STORY-194 AC1] evidence kinds are the four record kinds and nothing else", () => {
    expect([...TASK_EVIDENCE_KINDS]).toEqual(["finding", "displacement", "geo_analysis", "source_gap"]);
    expect(taskEvidenceSchema.safeParse({ kind: "source_gap", id: "x" }).success).toBe(true);
    expect(taskEvidenceSchema.safeParse({ kind: "other", id: "x" }).success).toBe(false);
    expect(taskEvidenceSchema.safeParse({ kind: "finding", id: "x", extra: 1 }).success).toBe(false);
  });
  it("[STORY-194 AC1] the four new members are required: omitting any one is not a task (null is the 'none' value)", () => {
    expect(taskSchema.safeParse(base).success).toBe(true);
    for (const key of ["evidence", "measured_impact", "patch", "playbook_slug"]) {
      const { [key]: _drop, ...rest } = base as Record<string, unknown>;
      expect(taskSchema.safeParse(rest).success).toBe(false);
    }
  });
  it("[STORY-194 AC6] measured_impact needs the caveat and the delta; it is not coerced from 0", () => {
    expect(taskSchema.safeParse({ ...base, measured_impact: impact }).success).toBe(true);
    expect(taskSchema.safeParse({ ...base, measured_impact: { ...impact, caveat: "" } }).success).toBe(false);
    const { caveat: _c, ...noCaveat } = impact;
    expect(taskSchema.safeParse({ ...base, measured_impact: noCaveat }).success).toBe(false);
    expect(taskSchema.safeParse({ ...base, measured_impact: 0 }).success).toBe(false);
  });
});
