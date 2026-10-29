import { describe, expect, it } from "vitest";
import { auxFindingEvidenceSchema } from "./aux-finding.schema.js";
import { auxRuleFindingSchema } from "./rule-finding.schema.js";

const base = {
  rule_code: "AUX-R-021",
  rule_version: "2026.10.2",
  severity: "high",
  measured_value: 1900,
  threshold_value: 1800,
  url: "https://example.com/p",
  evidence: { reason: "section_tokens", snippet: "Pricing", locator: "blocks[2]" },
  auto_fixable: false,
  guidance: { summary: "s", steps: ["a"], alignment_link: { path: "/geo/alignment", target_url: null } },
};

describe("STORY-051 rule finding contract", () => {
  it("STORY-051 AC3 · a finding carries measured value, threshold, URL, snippet and locator", () => {
    expect(auxRuleFindingSchema.parse(base)).toEqual(base);
  });
  it("STORY-051 AC3 · an unmeasured value is null and a measured zero stays 0", () => {
    expect(auxRuleFindingSchema.parse({ ...base, measured_value: null }).measured_value).toBeNull();
    expect(auxRuleFindingSchema.parse({ ...base, measured_value: 0 }).measured_value).toBe(0);
  });
  it("STORY-051 AC3 · an unknown key, a missing locator or an oversize snippet is refused", () => {
    expect(auxRuleFindingSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(auxRuleFindingSchema.safeParse({ ...base, evidence: { reason: "r", snippet: null } }).success).toBe(false);
    expect(auxRuleFindingSchema.safeParse({ ...base, evidence: { reason: "r", snippet: "x".repeat(201), locator: "l" } }).success).toBe(false);
  });
  it("STORY-051 AC3 · the evidence reads back through the stored-finding evidence union", () => {
    expect(auxFindingEvidenceSchema.safeParse(base.evidence).success).toBe(true);
  });
});
