import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { goalMetricSchema } from "../../../contracts/tasks/index.js";
import { GOAL_CONTRIBUTES_SQL, GOAL_METRIC_TRIGGERS } from "../../../src/lib/goals/contribution.js";
import { GOAL_METRIC_DIRECTION, goalProgressPct, goalReached } from "../../../src/lib/rollup/refresh-project-goals.js";

// STORY-065 — the pure parts of the goal refresh and the contribution table. The SQL halves are in
// test/integration/task-goals.spec.ts and project-tasks.spec.ts.
describe("STORY-065 · goal direction, reaching and progress", () => {
  it("direction is fixed per metric and no metric is lower-is-better, so no metric maps to `down`", () => {
    for (const metric of goalMetricSchema.options) expect(GOAL_METRIC_DIRECTION[metric], metric).toBe("up");
    expect(Object.keys(GOAL_METRIC_DIRECTION).sort()).toEqual([...goalMetricSchema.options].sort());
    expect(Object.values(GOAL_METRIC_DIRECTION)).not.toContain("down");
  });

  it("[STORY-065 #6] reaching the target is inclusive, in the goal's direction", () => {
    expect(goalReached("up", 60, 60)).toBe(true);
    expect(goalReached("up", 59.999, 60)).toBe(false);
    expect(goalReached("up", 0, 0)).toBe(true);
    expect(goalReached("down", 40, 40)).toBe(true);
    expect(goalReached("down", 40.001, 40)).toBe(false);
  });

  it("progress runs from baseline to target, 2 places, clamped to 0..100", () => {
    expect(goalProgressPct("up", 40, 50, 60)).toBe(50);
    expect(goalProgressPct("up", 40, 40, 60)).toBe(0);
    expect(goalProgressPct("up", 40, 60, 60)).toBe(100);
    expect(goalProgressPct("up", 40, 35, 60)).toBe(0);
    expect(goalProgressPct("up", 40, 99, 60)).toBe(100);
    expect(goalProgressPct("up", 40, 41, 63)).toBe(4.35);
    expect(goalProgressPct("down", 60, 50, 40)).toBe(50);
    expect(goalProgressPct("down", 60, 70, 40)).toBe(0);
    expect(goalProgressPct("down", 60, 30, 40)).toBe(100);
  });

  it("an unmeasured baseline has no progress, and a zero span is 100 once reached and 0 before (never a division by zero)", () => {
    expect(goalProgressPct("up", null, 50, 60)).toBeNull();
    expect(goalProgressPct("up", 50, 50, 50)).toBe(100);
    expect(goalProgressPct("up", 50, 49, 50)).toBe(0);
    expect(goalProgressPct("down", 50, 50, 50)).toBe(100);
    expect(Number.isFinite(goalProgressPct("up", 50, 51, 50) as number)).toBe(true);
  });
});

describe("STORY-065 · the contribution table", () => {
  const migration = readFileSync(new URL("../../../src/db/migrations/sql/0004_rollups_aux_tasks_geo_tools.up.sql", import.meta.url), "utf8");
  const checked = /trigger_kind\s+text\s+NOT NULL CHECK \(trigger_kind IN\s*\(([^)]*)\)/u.exec(migration)?.[1] ?? "";
  const allowed = new Set([...checked.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!));

  it("lists a trigger only if the rule table's CHECK allows it (a typo would silently match nothing)", () => {
    expect(allowed.size).toBeGreaterThan(10);
    for (const [metric, triggers] of Object.entries(GOAL_METRIC_TRIGGERS)) {
      expect(triggers.length, metric).toBeGreaterThan(0);
      for (const trigger of triggers) expect(allowed.has(trigger), `${metric}: ${trigger}`).toBe(true);
    }
  });

  it("has an entry for every goal metric, and the SQL it builds names each one", () => {
    expect(Object.keys(GOAL_METRIC_TRIGGERS).sort()).toEqual([...goalMetricSchema.options].sort());
    for (const metric of goalMetricSchema.options) expect(GOAL_CONTRIBUTES_SQL).toContain(`WHEN '${metric}' THEN`);
  });

  it("is static SQL: no placeholder, and a goal with no recognised metric matches nothing", () => {
    expect(GOAL_CONTRIBUTES_SQL).not.toMatch(/\$\d/u);
    expect(GOAL_CONTRIBUTES_SQL).toContain("ELSE ARRAY[]::text[] END");
  });
});
