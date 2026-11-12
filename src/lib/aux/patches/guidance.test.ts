import { describe, expect, it } from "vitest";
import { auxGuidanceSchema } from "../../../../contracts/aux/patch.schema.js";
import { GUIDANCE_ONLY_RULES, NON_FIXABLE_RULES, PATCHABLE_RULES, guidanceFor, guidanceForFinding } from "./guidance.js";

// STORY-053 AC9 — the non-fixable rules produce structured guidance and an alignment link, not an empty patch.
// The reference names twelve in aux-and-geo-analysis.md section 5 rule 4; the section 2 catalog marks fourteen with no auto-fix
// (AUX-R-003 and AUX-R-022 are the two it leaves out). The catalog is the finer source and this follows it.

const ALL = Array.from({ length: 34 }, (_, i) => `AUX-R-${String(i + 1).padStart(3, "0")}`);

describe("STORY-053 scenario 10 · a non-fixable rule's finding carries guidance and an alignment link", () => {
  it("names exactly the fourteen rules whose catalog row has no auto-fix", () => {
    expect([...NON_FIXABLE_RULES].sort()).toEqual(
      ["AUX-R-003", "AUX-R-005", "AUX-R-013", "AUX-R-019", "AUX-R-020", "AUX-R-021", "AUX-R-022", "AUX-R-025", "AUX-R-026", "AUX-R-027", "AUX-R-028", "AUX-R-029", "AUX-R-031", "AUX-R-033"],
    );
  });

  it.each([...["AUX-R-003", "AUX-R-005", "AUX-R-013", "AUX-R-019", "AUX-R-020", "AUX-R-021", "AUX-R-022", "AUX-R-025", "AUX-R-026", "AUX-R-027", "AUX-R-028", "AUX-R-029", "AUX-R-031", "AUX-R-033"]])(
    "%s has a summary, at least one step, and an alignment link",
    (code) => {
      const g = guidanceFor(code, { projectId: "p1", url: "https://acme.com/x" });
      expect(g).not.toBeNull();
      expect(g!.summary.length).toBeGreaterThan(20);
      expect(g!.steps.length).toBeGreaterThan(0);
      for (const s of g!.steps) expect(s.length).toBeGreaterThan(10);
      expect(g!.alignment_link).toEqual({ path: "/geo/alignment", target_url: "https://acme.com/x" });
    },
  );

  it("the patchable and the non-fixable rules partition the 34-rule catalog: no rule is both, none is neither", () => {
    const patchable = new Set(PATCHABLE_RULES);
    const non = new Set(NON_FIXABLE_RULES);
    for (const code of ALL) expect(patchable.has(code) !== non.has(code)).toBe(true);
    expect(patchable.size + non.size).toBe(34);
  });

  it("a rule that is fixable in the catalog but has no v1 patch kind (the sitemap) gets guidance without an alignment link", () => {
    expect([...GUIDANCE_ONLY_RULES]).toEqual(["AUX-R-007"]);
    const g = guidanceFor("AUX-R-007", { projectId: "p1", url: "https://acme.com/sitemap.xml" });
    expect(g).not.toBeNull();
    expect(g!.alignment_link).toBeNull();
  });

  it("a rule that has a patch has no guidance", () => {
    expect(guidanceFor("AUX-R-001", { projectId: "p1", url: null })).toBeNull();
  });

  it("an alignment link for a domain-level finding has no target url (null, not an invented one)", () => {
    expect(guidanceFor("AUX-R-003", { projectId: "p1", url: null })!.alignment_link).toEqual({ path: "/geo/alignment", target_url: null });
  });

  it("an unknown rule has none", () => {
    expect(guidanceFor("AUX-R-999", { projectId: "p1", url: null })).toBeNull();
  });
});

// STORY-194 AC2 / decision 98b - every finding read serves a patch or guidance, never neither.
describe("STORY-194 AC2 · a finding is served a patch or guidance, across the whole rule catalog", () => {
  const ctx = { projectId: "p1", url: "https://acme.com/x" };
  const base = { title: "A title", rationale: "Engines cannot quote this page cleanly." };

  it.each(ALL)("%s without a patch is served schema-valid guidance (the catalog rationale is the fallback)", (code) => {
    const g = guidanceForFinding(code, { ...ctx, ...base, hasPatch: false });
    expect(g).not.toBeNull();
    expect(auxGuidanceSchema.safeParse(g).success).toBe(true);
  });

  it("a fixable rule whose patch is missing or gate-refused falls back to the rationale plus the alignment link", () => {
    const g = guidanceForFinding("AUX-R-001", { ...ctx, ...base, hasPatch: false })!;
    expect(g.summary).toBe(base.rationale);
    expect(g.alignment_link).toEqual({ path: "/geo/alignment", target_url: "https://acme.com/x" });
  });

  it("a rule with no guidance text and no catalog row falls back to the title, never null", () => {
    const g = guidanceForFinding("AUX-R-999", { ...ctx, title: "Unknown rule", rationale: null, hasPatch: false })!;
    expect(g.summary).toBe("Unknown rule");
    expect(auxGuidanceSchema.safeParse(g).success).toBe(true);
  });

  it.each(ALL)("%s with a patch carries no guidance (patch XOR guidance)", (code) => {
    expect(guidanceForFinding(code, { ...ctx, ...base, hasPatch: true })).toBeNull();
  });

  it("a rule with curated text keeps its curated guidance, not the fallback", () => {
    expect(guidanceForFinding("AUX-R-021", { ...ctx, ...base, hasPatch: false })).toEqual(guidanceFor("AUX-R-021", ctx));
  });
});
