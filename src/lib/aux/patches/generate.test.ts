import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSiteFilePatch } from "./generate.js";
import { PatchRejectedError } from "./types.js";

// STORY-053 — the dispatcher over the site-file rules the crawl evaluates today (AUX-R-001, 002, 003, 004, 007).

const sha = (s: string): Buffer => createHash("sha256").update(s).digest();
const BLOCKED = "User-agent: GPTBot\nDisallow: /\n";
const site = (over: Partial<Parameters<typeof generateSiteFilePatch>[0]["site"]> = {}) => ({
  origin: "https://acme.com", siteName: "Acme", projectId: "p1", pageUrls: ["https://acme.com/", "https://acme.com/pricing"],
  robots: { body: BLOCKED, hash: sha(BLOCKED) }, llms: null as { body: string } | null, llmsPatchable: true, ...over,
});
const input = (ruleCode: string, over: Partial<Parameters<typeof generateSiteFilePatch>[0]["site"]> = {}) => ({
  ruleCode, targetUrl: "https://acme.com/robots.txt", url: "https://acme.com/robots.txt", site: site(over),
});

describe("STORY-053 scenario 1 · the generator produces a patch per fixable site-file rule", () => {
  it("AUX-R-001 and AUX-R-002 produce a robots patch", () => {
    const r1 = generateSiteFilePatch(input("AUX-R-001"));
    expect(r1.outcome).toBe("patch");
    if (r1.outcome === "patch") expect(r1.draft.kind).toBe("robots");
    const r2 = generateSiteFilePatch(input("AUX-R-002", { robots: { body: "User-agent: *\nDisallow: /private\n", hash: sha("w") } }));
    expect(r2.outcome).toBe("patch");
  });

  it("AUX-R-004 produces a markdown llms.txt patch", () => {
    const r = generateSiteFilePatch({ ...input("AUX-R-004"), targetUrl: "https://acme.com/llms.txt" });
    expect(r.outcome === "patch" && r.draft.kind === "markdown" && r.draft.targetUrl).toBe("https://acme.com/llms.txt");
  });

  it("AUX-R-004 offers no patch when the judged /llms.txt cannot be told absent or present (an error answer, or the file lives elsewhere)", () => {
    const r = generateSiteFilePatch({ ...input("AUX-R-004", { llmsPatchable: false }), targetUrl: "https://acme.com/llms.txt" });
    expect(r.outcome).toBe("none");
  });

  it("every draft carries a reversal and a 32-byte precondition hash", () => {
    for (const code of ["AUX-R-001", "AUX-R-004"]) {
      const r = generateSiteFilePatch(input(code));
      if (r.outcome !== "patch") throw new Error("expected a patch");
      expect(r.draft.reversal.operation).toBeTruthy();
      expect(r.draft.contentBeforeHash).toHaveLength(32);
      expect(r.draft.preconditions.length).toBeGreaterThan(0);
    }
  });
});

describe("STORY-053 scenario 10 · a rule with no patch gets guidance", () => {
  it.each(["AUX-R-003", "AUX-R-005", "AUX-R-022"])("%s -> guidance, never an empty patch", (code) => {
    const r = generateSiteFilePatch(input(code));
    expect(r.outcome).toBe("guidance");
    if (r.outcome === "guidance") expect(r.guidance.steps.length).toBeGreaterThan(0);
  });

  it("the sitemap rule is guidance-only in v1", () => {
    expect(generateSiteFilePatch(input("AUX-R-007")).outcome).toBe("guidance");
  });
});

describe("STORY-053 scenario 4 · the generator's output is gated, whichever rule it serves", () => {
  it("a robots file with nothing to open yields outcome none (no empty patch)", () => {
    const open = "User-agent: *\nAllow: /\n";
    expect(generateSiteFilePatch(input("AUX-R-001", { robots: { body: open, hash: sha(open) } })).outcome).toBe("none");
  });

  it("no robots body to patch (the file was not read) yields none, not a guess", () => {
    expect(generateSiteFilePatch(input("AUX-R-001", { robots: null })).outcome).toBe("none");
  });

  it("an unknown rule is none; a rule the crawl does not evaluate is none", () => {
    expect(generateSiteFilePatch(input("AUX-R-999")).outcome).toBe("none");
  });

  it("PatchRejectedError is what a gate failure raises (the handler records it, it does not abort the audit)", () => {
    expect(new PatchRejectedError("would_reduce_access", "x").reason).toBe("would_reduce_access");
  });
});
