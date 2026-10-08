import { describe, expect, it } from "vitest";
import { recoveryTaskCount } from "./displacement-recovery.js";

// NEW-C-5 AC1 — `recovery_task_count` is derived the way the recovery plan
// derives its tasks (STORY-057 AC6/AC8): one content task per concept gap, one
// authority task per citation gap on a SEEDABLE domain, none for a
// non-seedable one (recorded and visible, not actionable).
const gap = (domain: string) => ({ url: `https://${domain}/a`, domain, source_class: "blog", held_by: ["Rival"], brand_present: false });
const concept = (name: string) => ({ concept: name, prevalence: 0.5, evidence_url: "https://e.com" });

describe("NEW-C-5 · recoveryTaskCount", () => {
  it("AC1 — one authority task per citation gap on a seedable domain", () => {
    expect(recoveryTaskCount([gap("a.com"), gap("b.com")], [], new Set(["a.com", "b.com"]))).toBe(2);
  });

  it("AC1 — a non-seedable domain yields no task", () => {
    expect(recoveryTaskCount([gap("a.com"), gap("b.com")], [], new Set(["a.com"]))).toBe(1);
    expect(recoveryTaskCount([gap("a.com")], [], new Set())).toBe(0);
  });

  it("AC1 — one content task per concept gap, added to the authority tasks", () => {
    expect(recoveryTaskCount([gap("a.com")], [concept("x"), concept("y")], new Set(["a.com"]))).toBe(3);
  });

  it("AC1 — empty gaps give 0, a number and not null", () => {
    expect(recoveryTaskCount([], [], new Set(["a.com"]))).toBe(0);
  });

  it("AC1 — the domain match ignores case; two gaps on one domain are two tasks (one per gap)", () => {
    expect(recoveryTaskCount([gap("A.com"), gap("a.com")], [], new Set(["a.com"]))).toBe(2);
  });
});
