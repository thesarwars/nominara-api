import { describe, expect, it } from "vitest";
import { taskBaselineMetricsSchema, taskGenerationConditionSchema, taskPlaybookPayloadSchema } from "./index.js";

describe("STORY-063 · task generation condition grammar", () => {
  const sov = { kind: "metric_window", metric: "sov", direction: "down", change: "relative", threshold: 0.15, window_days: 7, min_n: 30, engine_scope: "each_engine" };

  it("accepts a closed predicate template", () => {
    expect(taskGenerationConditionSchema.safeParse(sov).success).toBe(true);
  });

  it("is strict: an unknown key (for example a SQL fragment) is a parse failure, not a silent drop", () => {
    expect(taskGenerationConditionSchema.safeParse({ ...sov, where: "1=1" }).success).toBe(false);
    expect(taskGenerationConditionSchema.safeParse({ kind: "sql", text: "select 1" }).success).toBe(false);
  });

  it("refuses a metric outside the closed set and a non-positive threshold or sample floor", () => {
    expect(taskGenerationConditionSchema.safeParse({ ...sov, metric: "sov; drop table tasks" }).success).toBe(false);
    expect(taskGenerationConditionSchema.safeParse({ ...sov, threshold: 0 }).success).toBe(false);
    expect(taskGenerationConditionSchema.safeParse({ ...sov, min_n: 0 }).success).toBe(false);
  });

  it("baseline metrics keep null distinct from 0", () => {
    const base = { captured_at: "2026-10-19T00:00:00.000Z", metric_date: "2026-10-19", window_days: 7, engine_key: "all", cells_total: 0, sov: null, presence_rate: null, visibility_score: null, owned_citation_count: null };
    expect(taskBaselineMetricsSchema.parse(base).sov).toBeNull();
    expect(taskBaselineMetricsSchema.parse({ ...base, sov: 0 }).sov).toBe(0);
    expect(taskBaselineMetricsSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("the playbook payload always carries a do-not list", () => {
    const payload = { target_url: null, target_domain: "x.com", angle: "a", quoted_rules: [], contribution_outline: [], disclosure_required: true, do_not: [] };
    expect(taskPlaybookPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
