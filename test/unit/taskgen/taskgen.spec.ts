import { describe, expect, it } from "vitest";
import { QUEUE_HANDLERS } from "../../../src/lib/queue/handlers.js";
import { compileMetricWindow } from "../../../src/lib/taskgen/compile.js";
import { taskFingerprint } from "../../../src/lib/taskgen/fingerprint.js";
import { impactScore, strengthOf } from "../../../src/lib/taskgen/impact.js";
import { renderTemplate } from "../../../src/lib/taskgen/template.js";
import { authorityTaskFingerprint } from "../../../src/lib/analytics/displacement-recovery.js";
import type { MetricWindowCondition } from "../../../contracts/tasks/index.js";

const PROJECT = "0198f6a0-0000-7000-8000-000000000001";
const base: MetricWindowCondition = { kind: "metric_window", metric: "sov", direction: "down", change: "relative", threshold: 0.15, window_days: 7, min_n: 30, engine_scope: "each_engine" };

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
    const { text, values } = compileMetricWindow({ ...base, threshold: 0.1234567, min_n: 4321, window_days: 9 }, { projectId: PROJECT, metricDate: "2026-10-14", scoringVersion: "v1" });
    expect(values).toContain(0.1234567);
    expect(values).toContain(4321);
    expect(values).toContain(9);
    for (const literal of ["0.1234567", "4321", PROJECT, "2026-10-14"]) expect(text).not.toContain(literal);
    expect(text).toMatch(/\$1\b/u);
  });

  it("is built only from fixed fragments: every metric and direction compiles to a statement with no condition text in it", () => {
    for (const metric of ["sov", "presence_rate", "owned_citation_count", "negative_mention_rate"] as const) {
      for (const direction of ["down", "up"] as const) {
        for (const change of ["relative", "absolute"] as const) {
          const { text } = compileMetricWindow({ ...base, metric, direction, change }, { projectId: PROJECT, metricDate: "2026-10-14", scoringVersion: "v1" });
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
