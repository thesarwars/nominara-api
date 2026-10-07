import { describe, expect, it } from "vitest";
import { PLAYBOOK_TEMPLATES, playbookTemplateFor } from "../../../src/lib/sources/playbook-templates.js";
import { isSeedableSourceClass } from "../../../src/lib/scoring/index.js";

describe("STORY-055 · playbook templates", () => {
  const seedable = ["community_forum", "review_marketplace", "developer_platform", "news_media", "blog"];

  it("#1 one template per seedable class, none for a non-seedable class", () => {
    for (const c of seedable) {
      expect(isSeedableSourceClass(c, false)).toBe(true);
      expect(playbookTemplateFor(c)?.slug).toBe(`playbook-${c}`);
    }
    for (const c of ["vendor_owned", "academic", "government", "encyclopedic", "other"]) expect(playbookTemplateFor(c)).toBeNull();
  });

  it("#2 every template carries a disclosure, a named do-not list and a verification step", () => {
    for (const t of PLAYBOOK_TEMPLATES) {
      expect(t.disclosure.toLowerCase()).toContain("affiliation");
      expect(t.doNot.length).toBeGreaterThanOrEqual(3);
      expect(t.verification).toMatch(/fetch/i);
      expect(t.outline.length).toBeGreaterThan(0);
    }
  });

  it("AC3 · a template never carries a rule without a link, and an empty list states its reason", () => {
    for (const t of PLAYBOOK_TEMPLATES) {
      for (const r of t.rules) expect(r.url).toMatch(/^https:\/\//);
      if (t.rules.length === 0) expect(t.rulesUnavailableReason).toEqual(expect.any(String));
    }
  });

  it("#11 a newer version supersedes, and the prior stays retrievable by version", () => {
    expect(playbookTemplateFor("blog", 1)?.version).toBe(1);
    expect(playbookTemplateFor("blog", 99)).toBeNull();
  });
});
