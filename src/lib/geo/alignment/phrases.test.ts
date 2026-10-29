import { describe, expect, it } from "vitest";
import { classifyNodeType, accuracyWarningFor, requiresHumanReview } from "./node-types.js";
import { extractNodeCandidates, normalisePhrase } from "./phrases.js";

const docs = (texts: readonly string[]) => texts.map((text, i) => ({ url: `https://d${String(i)}.example/p`, text }));
const find = (candidates: ReturnType<typeof extractNodeCandidates>, normalized: string) => candidates.find((c) => c.normalized === normalized);

describe("STORY-059 - normalisePhrase", () => {
  it("lowercases, folds punctuation and whitespace, keeps digits and %", () => {
    expect(normalisePhrase("  SOC 2,  Type-II  ")).toBe("soc 2 type ii");
    expect(normalisePhrase("99.9% Uptime")).toBe("99.9% uptime");
  });
  it("is stable under its own output", () => {
    const once = normalisePhrase("Single   Sign-On (SSO)");
    expect(normalisePhrase(once)).toBe(once);
  });
});

describe("STORY-059 AC4 / scenario 3 and 4 - prevalence: >= 0.30 of the cited documents is a category requirement, below it is one author's preference", () => {
  const withPhrase = (n: number, total: number) => docs(Array.from({ length: total }, (_, i) => (i < n ? "Our platform offers audit logging today." : "Our platform is fast.")));

  it("scenario 3 - a concept in most cited documents is produced, with its prevalence and its evidence", () => {
    const out = extractNodeCandidates(withPhrase(7, 10));
    const node = find(out, "audit logging")!;
    expect(node.docCount).toBe(7);
    expect(node.docRatio).toBeCloseTo(0.7, 12);
    expect(node.evidenceUrl).toBe("https://d0.example/p");
    expect(node.evidenceSnippet).toContain("audit logging");
  });
  it("boundary - exactly 3 of 10 (0.30) is kept", () => {
    expect(find(extractNodeCandidates(withPhrase(3, 10)), "audit logging")).toBeDefined();
  });
  it("scenario 4 - 2 of 10 (0.20) is NOT produced", () => {
    expect(find(extractNodeCandidates(withPhrase(2, 10)), "audit logging")).toBeUndefined();
  });
  it("boundary - 0.29 is not kept (29 of 100)", () => {
    expect(find(extractNodeCandidates(withPhrase(29, 100)), "audit logging")).toBeUndefined();
    expect(find(extractNodeCandidates(withPhrase(30, 100)), "audit logging")).toBeDefined();
  });
  it("prevalence counts DOCUMENTS, not occurrences: one document saying it ten times is one document", () => {
    const out = extractNodeCandidates(docs([Array(10).fill("audit logging").join(". "), "nothing relevant here", "unrelated words only", "more filler text", "another document"]));
    expect(find(out, "audit logging")).toBeUndefined();
  });
  it("frequency is the total number of occurrences across the corpus", () => {
    const out = extractNodeCandidates(docs(["audit logging. audit logging.", "audit logging."]));
    const node = find(out, "audit logging")!;
    expect(node.frequency).toBe(3);
    expect(node.docCount).toBe(2);
  });
  it("an empty corpus yields nothing (no division by zero), and an empty document counts in the denominator", () => {
    expect(extractNodeCandidates([])).toEqual([]);
    const out = extractNodeCandidates(docs(["audit logging", "", "", ""]));
    expect(find(out, "audit logging")).toBeUndefined(); // 1 of 4 = 0.25
  });
});

describe("STORY-059 - candidates are 2 to 5 token noun-phrase-like runs bounded by function words", () => {
  const all = (text: string) => extractNodeCandidates(docs([text])).map((c) => c.normalized);

  it("a run is cut at function words: 'tools for teams' is not one phrase", () => {
    const out = all("The best reporting tools for teams");
    expect(out).toContain("best reporting tools");
    expect(out).toContain("reporting tools");
    expect(out).not.toContain("tools for teams");
    expect(out).not.toContain("the best reporting tools");
  });
  it("no single word and no phrase above 5 tokens", () => {
    const out = all("alpha beta gamma delta epsilon zeta eta theta");
    expect(out.every((p) => p.split(" ").length >= 2 && p.split(" ").length <= 5)).toBe(true);
    expect(out).not.toContain("alpha");
  });
  it("punctuation ends a phrase", () => {
    expect(all("single sign-on, role based access")).not.toContain("on role");
    expect(all("single sign-on, role based access")).toContain("role based access");
  });
  it("overlapping windows of one run are all candidates: which is the concept is decided later, by the embeddings", () => {
    const out = all("soc 2 type ii report");
    expect(out).toContain("soc 2 type ii report");
    expect(out).toContain("type ii");
  });
  it("is deterministic: the same input, the same order", () => {
    const text = "audit logging and role based access control with single sign-on";
    expect(all(text)).toEqual(all(text));
  });
});

describe("STORY-059 AC5 - typing by a deterministic keyword map", () => {
  it.each([
    ["soc 2 type ii report", "compliance"],
    ["hipaa compliance", "compliance"],
    ["gdpr", "compliance"],
    ["99.9% uptime", "metric"],
    ["50% faster reports", "metric"],
    ["per seat pricing", "pricing_term"],
    ["free trial", "pricing_term"],
    ["integrates with slack", "integration"],
    ["salesforce integration", "integration"],
    ["healthcare", "industry"],
    ["financial services teams", "industry"],
    ["marketing managers", "persona"],
    ["audit logging", "capability"],
  ] as const)("%s is %s", (phrase, type) => {
    expect(classifyNodeType(phrase)).toBe(type);
  });
  it("is deterministic and total: any phrase gets a type", () => {
    expect(classifyNodeType("zzz qqq")).toBe(classifyNodeType("zzz qqq"));
    expect(typeof classifyNodeType("zzz qqq")).toBe("string");
  });
});

describe("STORY-059 scenario 12 / AC13 - compliance, metric and pricing set the review flag and carry a warning", () => {
  it.each(["compliance", "metric", "pricing_term"] as const)("%s requires human review and has a warning", (type) => {
    expect(requiresHumanReview(type)).toBe(true);
    expect(accuracyWarningFor(type)).toMatch(/true of your/i);
  });
  it.each(["capability", "integration", "persona", "industry", "entity", "differentiator"] as const)("%s does not, and has no warning", (type) => {
    expect(requiresHumanReview(type)).toBe(false);
    expect(accuracyWarningFor(type)).toBeNull();
  });
});
