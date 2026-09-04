import { describe, expect, it } from "vitest";
import { isCommonWordBrand, proposeNegativeAliases } from "./common-words.js";

// STORY-043 scenario 16.
describe("STORY-043 · common-word brand detection", () => {
  it.each(["Notion", "Square", "Slack", "notion", "  NOTION  "])("flags %s", (name) => {
    expect(isCommonWordBrand(name)).toBe(true);
  });

  it.each(["HubSpot", "Salesforce", "Pipedrive", "Zendesk"])("does not flag %s", (name) => {
    expect(isCommonWordBrand(name)).toBe(false);
  });

  // The opposite failure, and the worse one: a negative alias SUPPRESSES real
  // mentions, so over-flagging costs a customer their own data.
  it("does not flag a multi-word name containing a common word", () => {
    expect(isCommonWordBrand("Square Payments")).toBe(false);
    expect(isCommonWordBrand("Notion Labs")).toBe(false);
  });

  it("handles an empty or whitespace name without flagging it", () => {
    expect(isCommonWordBrand("")).toBe(false);
    expect(isCommonWordBrand("   ")).toBe(false);
  });

  it("scenario 16 — proposes ordinary-sense phrases for a common-word brand", () => {
    const proposed = proposeNegativeAliases("Notion");
    expect(proposed).toContain("the notion");
    expect(proposed).toContain("a notion");
    expect(proposed.every((p) => p.includes("notion"))).toBe(true);
  });

  // The bare capitalised word IS very often the product, so proposing it as a
  // negative would suppress every genuine mention.
  it("never proposes the bare brand word itself", () => {
    expect(proposeNegativeAliases("Notion")).not.toContain("notion");
    expect(proposeNegativeAliases("Square")).not.toContain("square");
  });

  it("proposes nothing for a distinctive name", () => {
    expect(proposeNegativeAliases("HubSpot")).toEqual([]);
  });
});
