import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { authorityTaskFingerprint, recoveryTaskCount } from "./displacement-recovery.js";

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

  it("NEW-C-6 — the domain match ignores case; two gaps on one domain are ONE task, because the fingerprint is per domain (decision 2026-10-08)", () => {
    expect(recoveryTaskCount([gap("A.com"), gap("a.com")], [], new Set(["a.com"]))).toBe(1);
    expect(recoveryTaskCount([gap("a.com"), gap("b.com"), gap("A.COM")], [], new Set(["a.com", "b.com"]))).toBe(2);
  });
});

describe("NEW-C-6 · authorityTaskFingerprint", () => {
  it("AC2 — is sha256('authority:{project_id}:{domain}') with the domain lower-cased", () => {
    const expected = createHash("sha256").update("authority:proj-1:example.com").digest();
    expect(authorityTaskFingerprint("proj-1", "Example.COM").equals(expected)).toBe(true);
  });

  it("AC2 — differs by project and by domain", () => {
    expect(authorityTaskFingerprint("p1", "a.com").equals(authorityTaskFingerprint("p2", "a.com"))).toBe(false);
    expect(authorityTaskFingerprint("p1", "a.com").equals(authorityTaskFingerprint("p1", "b.com"))).toBe(false);
  });
});
