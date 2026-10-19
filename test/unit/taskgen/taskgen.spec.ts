import { describe, expect, it } from "vitest";
import { QUEUE_HANDLERS } from "../../../src/lib/queue/handlers.js";
import { compileMetricWindow, effectiveWindowDays, runFloorCells } from "../../../src/lib/taskgen/compile.js";
import { taskFingerprint } from "../../../src/lib/taskgen/fingerprint.js";
import { impactScore, strengthOf } from "../../../src/lib/taskgen/impact.js";
import { renderTemplate } from "../../../src/lib/taskgen/template.js";
import { authorityTaskFingerprint } from "../../../src/lib/analytics/displacement-recovery.js";
import type { MetricWindowCondition } from "../../../contracts/tasks/index.js";

const PROJECT = "0198f6a0-0000-7000-8000-000000000001";
const base: MetricWindowCondition = { kind: "metric_window", metric: "sov", direction: "down", change: "relative", threshold: 0.15, window_days: 7, min_n: 30, sustained_days: 3, engine_scope: "each_engine" };

describe("STORY-063 · taskgen fingerprint", () => {
  it("is deterministic and separates rule, project and scope", () => {
    const a = taskFingerprint("TG-SOV-DROP-ENGINE", PROJECT, "gemini");
    expect(a.equals(taskFingerprint("TG-SOV-DROP-ENGINE", PROJECT, "gemini"))).toBe(true);
    expect(a.equals(taskFingerprint("TG-SOV-DROP-ENGINE", PROJECT, "chatgpt"))).toBe(false);
    expect(a.equals(taskFingerprint("TG-PRESENCE-LOSS", PROJECT, "gemini"))).toBe(false);
    expect(a.equals(taskFingerprint("TG-SOV-DROP-ENGINE", "0198f6a0-0000-7000-8000-000000000002", "gemini"))).toBe(false);
    expect(a).toHaveLength(32);
  });

  it("does not collide with the authority fingerprint the recovery plan uses (same domain, different namespace)", () => {
    expect(taskFingerprint("TG-X", PROJECT, "seed.com").equals(authorityTaskFingerprint(PROJECT, "seed.com"))).toBe(false);
  });

  it("a delimiter inside the scope cannot forge another rule's fingerprint", () => {
    expect(taskFingerprint("A", PROJECT, "b:c").equals(taskFingerprint("A:b", PROJECT, "c"))).toBe(false);
  });
});

describe("STORY-063 · taskgen impact", () => {
  it("is 100 * weight * strength, clamped to 0..100", () => {
    expect(impactScore(0.8, 0.5)).toBeCloseTo(40, 6);
    expect(impactScore(1, 1)).toBe(100);
    expect(impactScore(2, 1)).toBe(100);
    expect(impactScore(0.8, 0)).toBe(0);
    expect(impactScore(-1, 1)).toBe(0);
  });

  it("strength is 0.5 at the threshold and rises to 1 at twice the threshold", () => {
    expect(strengthOf(0.15, 0.15)).toBe(0.5);
    expect(strengthOf(0.3, 0.15)).toBe(1);
    expect(strengthOf(0.9, 0.15)).toBe(1);
    expect(strengthOf(0.225, 0.15)).toBeCloseTo(0.75, 6);
    expect(strengthOf(0.01, 0.15)).toBe(0.5);
  });
});

describe("STORY-063 · taskgen template", () => {
  it("substitutes known placeholders and leaves an unknown one visible rather than blank", () => {
    expect(renderTemplate("Share of voice dropped on {engine}", { engine: "gemini" })).toBe("Share of voice dropped on gemini");
    expect(renderTemplate("{a} and {missing}", { a: 1 })).toBe("1 and {missing}");
  });

  it("does not re-expand a substituted value", () => {
    expect(renderTemplate("{a}", { a: "{b}", b: "x" })).toBe("{b}");
  });
});

describe("STORY-063 · taskgen compile (closed grammar to parameterised SQL)", () => {
  it("binds every condition value as a parameter and never inlines one", () => {
    const { text, values } = compileMetricWindow({ ...base, threshold: 0.1234567, min_n: 4321, window_days: 9 }, { projectId: PROJECT, metricDate: "2026-10-14", scoringVersion: "v1", timezone: "UTC", engineWindowDays: {} });
    expect(values).toContain(0.1234567);
    expect(values).toContain(4321);
    expect(values).toContain(9);
    for (const literal of ["0.1234567", "4321", PROJECT, "2026-10-14"]) expect(text).not.toContain(literal);
    expect(text).toMatch(/\$1\b/u);
  });

  it("[STORY-063 #2] 'sustained' is compiled in: the statement counts breaching RUNS and binds the day floor as a parameter", () => {
    const { text, values } = compileMetricWindow({ ...base, sustained_days: 5 }, { projectId: PROJECT, metricDate: "2026-10-14", scoringVersion: "v1", timezone: "UTC", engineWindowDays: {} });
    // capped by the capture runs that exist in the window: min(sustained_days, runs)
    expect(text).toMatch(/runs_breached,\s*0\)\s*>=\s*LEAST\(\$\d+::int,\s*s\.current_runs\)/u);
    expect(values).toContain(5);
    expect(text).not.toMatch(/runs_breached,\s*0\)\s*>=\s*(LEAST\()?5\b/u);
  });

  it("is built only from fixed fragments: every metric and direction compiles to a statement with no condition text in it", () => {
    for (const metric of ["sov", "presence_rate", "owned_citation_count"] as const) {
      for (const direction of ["down", "up"] as const) {
        for (const change of ["relative", "absolute"] as const) {
          const { text } = compileMetricWindow({ ...base, metric, direction, change }, { projectId: PROJECT, metricDate: "2026-10-14", scoringVersion: "v1", timezone: "UTC", engineWindowDays: {} });
          expect(text).toContain("FROM metric_daily");
          expect(text).not.toMatch(/;|--|\/\*/u);
        }
      }
    }
  });
});

describe("STORY-063 · the task.generate queue has a handler", () => {
  it("registers task.generate", () => {
    expect(Object.keys(QUEUE_HANDLERS)).toContain("task.generate");
  });
});

describe("STORY-063 · the window a rule compares is derived from the plan's cadence", () => {
  it("[STORY-063 #14] a cadence with under two runs in the window (weekly 7.5 days, Growth 3.75 days) widens a 7-day rule to 14; daily and hourly keep it", () => {
    expect(effectiveWindowDays(7, { full: 4 })).toBe(14);
    expect(effectiveWindowDays(7, { full: 8 })).toBe(14); // 1.87 runs in 7 days: owner decision 2026-10-19
    expect(effectiveWindowDays(7, { full: 9 })).toBe(7); // 3.33 days: two runs fit in 7 days
    expect(effectiveWindowDays(7, { full: 8, priority: 8 })).toBe(14);
    expect(effectiveWindowDays(7, { full: 4, priority: 30 })).toBe(7);
    expect(effectiveWindowDays(7, { full: 30, priority: 720 })).toBe(7);
  });

  it("[STORY-063 #14] the widening is the smallest whole multiple covering the interval, and a wide rule window is left alone", () => {
    expect(effectiveWindowDays(14, { full: 4 })).toBe(28); // 14 days hold 1.87 runs: the same rule, applied to the rule's own window
    expect(effectiveWindowDays(14, { full: 8 })).toBe(14); // 3.75 days: 3.7 runs
    expect(effectiveWindowDays(3, { full: 4 })).toBe(9); // 7.5 days -> 3 x 3
    expect(effectiveWindowDays(7, { full: 1 })).toBe(35); // a 30-day interval
  });

  it("[STORY-063 #14] no usable cadence means the rule's own window: absent, empty, malformed, zero or negative", () => {
    for (const cadence of [null, undefined, {}, [], "weekly", 4, { full: 0 }, { full: -4 }, { full: "4" }, { full: Number.NaN }]) {
      expect(effectiveWindowDays(7, cadence)).toBe(7);
    }
  });
});

describe("STORY-063 · the cells a run needs to count come from the same cadence data", () => {
  it("[STORY-063 #4] ceil(min_n x interval / window): about 17 at Starter, 9 at Growth, 5 at Business, 1 at Enterprise", () => {
    expect(runFloorCells(30, 14, { full: 4 })).toBe(17); // 30 / 1.87 runs
    expect(runFloorCells(30, 14, { full: 8 })).toBe(9); // 30 / 3.73
    expect(runFloorCells(30, 7, { full: 4, priority: 30 })).toBe(5); // 30 / 7
    expect(runFloorCells(30, 7, { full: 30, priority: 720 })).toBe(1);
  });

  it("[STORY-063 #4] no usable cadence assumes a run a day, and the floor is never under one cell", () => {
    expect(runFloorCells(30, 7, null)).toBe(5);
    expect(runFloorCells(30, 14, {})).toBe(3);
    expect(runFloorCells(0, 7, { full: 4 })).toBe(1);
  });
});
