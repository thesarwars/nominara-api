import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateLlmsTxt } from "../site-files.js";
import { buildLlmsTxtPatch, buildStructurePatch } from "./markdown.js";

// STORY-053 AC1 (kind markdown) — the llms.txt file for AUX-R-004 (a Nominara template filled with the site's own URLs) and the
// answer-shaped structure template for AUX-R-023.

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const ORIGIN = "https://acme.com";
const PAGES = ["https://acme.com/", "https://acme.com/pricing", "https://acme.com/docs/getting-started", "https://other.example/x"];
const input = { ruleCode: "AUX-R-004", origin: ORIGIN, siteName: "Acme", pageUrls: PAGES, existing: null as string | null };

describe("STORY-053 scenario 1 · a markdown patch for llms.txt is valid, with a reversal and a precondition hash", () => {
  const d = buildLlmsTxtPatch(input);

  it("is kind markdown, targets /llms.txt, and passes the same check that raised the finding", () => {
    expect(d.kind).toBe("markdown");
    expect(d.targetUrl).toBe("https://acme.com/llms.txt");
    expect(evaluateLlmsTxt({ status: 200, body: d.contentAfter }, null)).toEqual([]);
  });

  it("an absent file: the precondition is that it is still absent, the hash is of nothing, the reversal deletes the file", () => {
    expect(d.preconditions).toEqual([{ kind: "file_absent", value: null }]);
    expect(d.contentBeforeHash.toString("hex")).toBe(sha(""));
    expect(d.reversal).toEqual({ operation: "delete_file", content: null });
    expect(d.unifiedDiff).toContain("+# Acme");
  });

  it("an existing invalid file: the precondition is its hash and the reversal restores it", () => {
    const existing = "Welcome to Acme\n- not a link\n";
    const r = buildLlmsTxtPatch({ ...input, existing });
    expect(r.preconditions).toEqual([{ kind: "file_hash", value: `sha256:${sha(existing)}` }]);
    expect(r.reversal).toEqual({ operation: "replace_file", content: existing });
    expect(r.contentBeforeHash.toString("hex")).toBe(sha(existing));
  });
});

describe("STORY-053 scenario 2 · every value is the site's own, or a template word", () => {
  const d = buildLlmsTxtPatch(input);
  const links = [...d.contentAfter.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]!);

  it("links only to pages of the site's own sitemap, on the same origin", () => {
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(PAGES).toContain(l);
    expect(links).not.toContain("https://other.example/x");
  });

  it("invents no description: the only prose is the template's, and the draft says how it was derived", () => {
    expect(d.contentAfter).not.toMatch(/^>/m);
    expect(d.derivation).toMatch(/sitemap/i);
    expect(d.derivation).toMatch(/no description/i);
  });

  it("link text is the URL path, humanised, and the root is named by the site", () => {
    expect(d.contentAfter).toContain("[Acme](https://acme.com/)");
    expect(d.contentAfter).toContain("[Pricing](https://acme.com/pricing)");
    expect(d.contentAfter).toContain("[Docs / Getting started](https://acme.com/docs/getting-started)");
  });

  it("caps the list at 50 links, and a site name with markup characters cannot break the file", () => {
    const many = Array.from({ length: 80 }, (_, i) => `https://acme.com/p${i}`);
    const big = buildLlmsTxtPatch({ ...input, pageUrls: many, siteName: "Ac]me (the) <b>\n# x" });
    expect([...big.contentAfter.matchAll(/\]\(https?:/g)]).toHaveLength(50);
    expect(big.contentAfter.split("\n")[0]).toBe("# Ac]me (the) <b> # x");
    expect(evaluateLlmsTxt({ status: 200, body: big.contentAfter }, null)).toEqual([]);
  });

  it("with no pages at all it is still a valid file: a title and nothing invented", () => {
    const d0 = buildLlmsTxtPatch({ ...input, pageUrls: [] });
    expect(evaluateLlmsTxt({ status: 200, body: d0.contentAfter }, null)).toEqual([]);
  });
});

describe("STORY-053 scenario 1 · a structure patch (AUX-R-023) is a Nominara template with the page's own heading", () => {
  const md = "# Acme CRM\n\nAcme CRM tracks your pipeline.\n\n## Pricing\n\nFrom 18 USD.\n";
  const d = buildStructurePatch({ ruleCode: "AUX-R-023", targetUrl: "https://acme.com/crm", markdown: md });

  it("is kind markdown, inserts a summary slot after the first heading, and states the diff", () => {
    expect(d.kind).toBe("markdown");
    expect(d.contentAfter.startsWith("# Acme CRM\n\n## Summary")).toBe(true);
    expect(d.contentAfter).toContain("Acme CRM");
    expect(d.unifiedDiff).toContain("+## Summary");
  });

  it("makes no claim: the slot is a placeholder the customer fills in, never text", () => {
    expect(d.contentAfter).toMatch(/\[Write .* in your own words/);
    expect(d.requiresHumanReview).toBe(false);
  });

  it("carries the page hash, and a reversal that returns the page", () => {
    expect(d.contentBeforeHash.toString("hex")).toBe(sha(md));
    expect(d.reversal.operation).toBe("replace_file");
    expect(d.reversal.content).toBe(md);
  });

  it("a page with no heading cannot be patched: rejected, not guessed", () => {
    expect(() => buildStructurePatch({ ruleCode: "AUX-R-023", targetUrl: "https://acme.com/", markdown: "just text\n" })).toThrowError(/no_heading|heading/);
  });
});

describe("STORY-053 AC6 · a sitemap path segment cannot inject a line into the generated file", () => {
  it("an encoded newline and heading in a sitemap URL stays on its one link line", () => {
    const d = buildLlmsTxtPatch({ ...input, pageUrls: ["https://acme.com/a%0A%23%20Injected", "https://acme.com/b%0D%0A-%20[x](https://evil.example)"] });
    const lines = d.contentAfter.split("\n");
    expect(lines.filter((l) => l.startsWith("#")).sort()).toEqual(["# Acme", "## Pages"].sort());
    expect(lines.filter((l) => l.startsWith("- ")).length).toBe(2);
    expect(d.contentAfter).not.toMatch(/\n# Injected/);
  });
});
