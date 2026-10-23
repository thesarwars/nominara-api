import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pageMatches, sha256Tag } from "./precondition.js";

// STORY-053 AC3 / scenario 9 — the interface states plainly whether the page still matches. null is "not re-checked since the patch
// was made", which is not the same as false (changed) and not the same as true (unchanged).

const sha = (s: string): Buffer => createHash("sha256").update(s).digest();
const robots = (body: string) => ({ kind: "robots" as const, contentBeforeHash: sha(body), preconditions: [{ kind: "file_hash" as const, value: sha256Tag(sha(body)) }] });
const llmsAbsent = { kind: "markdown" as const, contentBeforeHash: sha(""), preconditions: [{ kind: "file_absent" as const, value: null }] };

describe("STORY-053 scenario 9 · the customer is told whether the page changed since generation", () => {
  it("sha256Tag is the 'sha256:' form the preconditions carry", () => {
    expect(sha256Tag(sha("a"))).toBe(`sha256:${sha("a").toString("hex")}`);
  });

  it("robots: the latest audit's robots hash equals the patch's -> true; differs -> false (the file changed, surfaced)", () => {
    expect(pageMatches(robots("A"), { robotsHash: sha("A"), llmsTxtPresent: true })).toBe(true);
    expect(pageMatches(robots("A"), { robotsHash: sha("B"), llmsTxtPresent: true })).toBe(false);
  });

  it("robots: an audit that could not read robots.txt says nothing (null), and with no audit at all it is null too", () => {
    expect(pageMatches(robots("A"), { robotsHash: null, llmsTxtPresent: null })).toBeNull();
    expect(pageMatches(robots("A"), null)).toBeNull();
  });

  it("a file_absent precondition holds while the latest audit finds no llms.txt, breaks once one exists, and is null when unknown", () => {
    expect(pageMatches(llmsAbsent, { robotsHash: null, llmsTxtPresent: false })).toBe(true);
    expect(pageMatches(llmsAbsent, { robotsHash: null, llmsTxtPresent: true })).toBe(false);
    expect(pageMatches(llmsAbsent, { robotsHash: null, llmsTxtPresent: null })).toBeNull();
  });

  it("a page-level patch (html_fragment, jsonld, structure) has nothing to compare until page hashes are audited: null, never a guess", () => {
    const page = { kind: "jsonld" as const, contentBeforeHash: sha("p"), preconditions: [{ kind: "page_hash" as const, value: sha256Tag(sha("p")) }] };
    expect(pageMatches(page, { robotsHash: sha("p"), llmsTxtPresent: false })).toBeNull();
  });

  it("an existing-llms.txt replacement (file_hash on markdown) cannot be compared either: null", () => {
    const replace = { kind: "markdown" as const, contentBeforeHash: sha("x"), preconditions: [{ kind: "file_hash" as const, value: sha256Tag(sha("x")) }] };
    expect(pageMatches(replace, { robotsHash: sha("x"), llmsTxtPresent: true })).toBeNull();
  });
});
