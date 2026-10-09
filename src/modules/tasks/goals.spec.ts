import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { AUDIT_METADATA_KEY } from "../../api/decorators/audit.decorator.js";
import { IDEMPOTENT_KEY } from "../../api/decorators/idempotent.decorator.js";
import { PROJECT_PARAM_KEY } from "../../api/decorators/project-param.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { createGoalRequestSchema, goalSchema, updateGoalRequestSchema } from "../../../contracts/tasks/index.js";
import { GoalsController } from "./goals.controller.js";

// STORY-065-A — route wiring and contract strictness (unit; the SQL is in
// test/integration/task-goals.spec.ts).
const CLUSTER = "0190a3f0-0000-7000-8000-000000000001";

describe("STORY-065-A · goals route wiring", () => {
  const reflector = new Reflector();
  const proto = GoalsController.prototype as unknown as Record<string, () => void>;

  it("[STORY-065 RBAC] list, create and abandon all require task:create (api-specification §3) and are project-scoped by :id", () => {
    for (const name of ["list", "create", "update"]) {
      expect(reflector.get(REQUIRE_PERMISSION_KEY, proto[name]!), name).toBe("task:create");
      expect(reflector.get(PROJECT_PARAM_KEY, proto[name]!), name).toBe("id");
    }
  });

  it("[STORY-065 #7] create and abandon are audited; create is idempotent", () => {
    expect(reflector.get(AUDIT_METADATA_KEY, proto.create!)).toMatchObject({ action: "goal.created", resourceType: "goal", resourceIdFrom: "response" });
    expect(reflector.get(AUDIT_METADATA_KEY, proto.update!)).toMatchObject({ action: "goal.abandoned", resourceType: "goal", paramName: "goalId" });
    expect(reflector.get(IDEMPOTENT_KEY, proto.create!)).toBe(true);
  });

  it("publishes listProjectGoals / createProjectGoal / updateProjectGoal operations", () => {
    expect(reflector.get(API_CONTRACT_KEY, proto.list!)).toMatchObject({ operationId: "listProjectGoals" });
    expect(reflector.get(API_CONTRACT_KEY, proto.create!)).toMatchObject({ operationId: "createProjectGoal" });
    expect(reflector.get(API_CONTRACT_KEY, proto.update!)).toMatchObject({ operationId: "updateProjectGoal" });
  });
});

describe("STORY-065-A · goal contracts", () => {
  const ok = { title: "Lift visibility", kind: "engine_score", target: { metric: "visibility_score", target_value: 60 } };

  it("[STORY-065 #1] accepts an engine_score goal and a topic_authority goal with a cluster", () => {
    expect(createGoalRequestSchema.safeParse(ok).success).toBe(true);
    expect(createGoalRequestSchema.safeParse({ ...ok, kind: "topic_authority", target: { ...ok.target, prompt_cluster_id: CLUSTER } }).success).toBe(true);
  });

  it("topic_authority without a cluster, engine_score with one, an unsupported kind, an out-of-range target and unknown keys are all refused", () => {
    expect(createGoalRequestSchema.safeParse({ ...ok, kind: "topic_authority" }).success).toBe(false);
    expect(createGoalRequestSchema.safeParse({ ...ok, target: { ...ok.target, prompt_cluster_id: CLUSTER } }).success).toBe(false);
    expect(createGoalRequestSchema.safeParse({ ...ok, kind: "custom" }).success).toBe(false);
    expect(createGoalRequestSchema.safeParse({ ...ok, target: { ...ok.target, target_value: 100.5 } }).success).toBe(false);
    expect(createGoalRequestSchema.safeParse({ ...ok, target: { ...ok.target, target_value: -1 } }).success).toBe(false);
    expect(createGoalRequestSchema.safeParse({ ...ok, baseline: { value: 1 } }).success).toBe(false);
    expect(createGoalRequestSchema.safeParse({ ...ok, target: { ...ok.target, engine_key: "gemini" } }).success).toBe(false);
  });

  it("[STORY-065-A kinds] only engine_score and topic_authority are creatable: each of the other five kinds in the table's CHECK is refused (owner decision 2026-10-08)", () => {
    for (const kind of ["prompt_recommendation", "citation_presence", "rendering_quality", "sentiment_recovery", "custom"]) {
      expect(createGoalRequestSchema.safeParse({ ...ok, kind }).success, kind).toBe(false);
      expect(createGoalRequestSchema.safeParse({ ...ok, kind, target: { ...ok.target, prompt_cluster_id: CLUSTER } }).success, `${kind} with a cluster`).toBe(false);
    }
  });

  it("abandon is the only caller transition: achieved, an empty body and extra keys are refused", () => {
    expect(updateGoalRequestSchema.safeParse({ status: "abandoned" }).success).toBe(true);
    expect(updateGoalRequestSchema.safeParse({ status: "achieved" }).success).toBe(false);
    expect(updateGoalRequestSchema.safeParse({}).success).toBe(false);
    expect(updateGoalRequestSchema.safeParse({ status: "abandoned", reason: "x" }).success).toBe(false);
  });

  it("[STORY-065 #3] the response declares baseline, current and target, and a null progress_pct is representable", () => {
    expect(Object.keys(goalSchema.shape)).toEqual(expect.arrayContaining(["baseline", "current", "target", "sample_state", "progress_pct"]));
    expect(goalSchema.shape.progress_pct.safeParse(null).success).toBe(true);
  });
});
