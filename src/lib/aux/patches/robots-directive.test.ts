import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots } from "../robots.js";
import { evaluateRobotsTxt } from "../site-files.js";
import { PatchRejectedError } from "./types.js";
import { VERIFICATION_BOUNDS, assertAccessNotReduced, buildRobotsPatch, finaliseRobotsPatch } from "./robots-directive.js";

// STORY-053 AC5 (aux-and-geo-analysis.md section 5, schemas/geo-and-vectors.md `kind='robots'`) — a crawler-directive patch is
// parsed and re-serialised, must parse cleanly, and must not reduce access for ANY agent relative to the file it patches. The
// check is on the OUTCOME, not on the generator: a patch from any rule, or a hand-built one, passes through the same gate.

const URL = "https://acme.com/robots.txt";
const sha = (s: string): Buffer => createHash("sha256").update(s).digest();
const BLOCKED = "User-agent: GPTBot\nDisallow: /\n";
const WILDCARD = "User-agent: *\nDisallow: /private\nDisallow: /\n";

describe("STORY-053 scenario 1 · a robots patch has a reversal and a precondition hash", () => {
  const draft = buildRobotsPatch({ ruleCode: "AUX-R-001", targetUrl: URL, body: BLOCKED, bodyHash: sha(BLOCKED) })!;

  it("is kind robots, appends an Allow block and carries the sha256 of the file it was made from", () => {
    expect(draft.kind).toBe("robots");
    expect(draft.contentAfter.startsWith(BLOCKED)).toBe(true);
    expect(draft.contentAfter).toContain("User-agent: GPTBot\nAllow: /\n");
    expect(draft.contentBeforeHash.equals(sha(BLOCKED))).toBe(true);
    expect(draft.preconditions).toEqual([{ kind: "file_hash", value: `sha256:${sha(BLOCKED).toString("hex")}` }]);
  });

  it("carries a reversal that removes exactly what was appended, and the result is the original file", () => {
    expect(draft.reversal.operation).toBe("remove_block");
    expect(draft.contentAfter.replace(draft.reversal.content!, "")).toBe(BLOCKED);
  });

  it("states a unified diff of the append and an explanation", () => {
    expect(draft.unifiedDiff).toMatch(/^--- a\/robots\.txt\n\+\+\+ b\/robots\.txt\n@@ /);
    expect(draft.unifiedDiff).toContain("+User-agent: GPTBot");
    expect(draft.explanation.length).toBeGreaterThan(20);
  });

  it("clears the finding it was made for: the patched file no longer fires AUX-R-001", () => {
    expect(evaluateRobotsTxt({ status: 200, body: BLOCKED }, ["/"]).map((f) => f.rule_code)).toContain("AUX-R-001");
    expect(evaluateRobotsTxt({ status: 200, body: draft.contentAfter }, ["/"]).map((f) => f.rule_code)).not.toContain("AUX-R-001");
  });

  it("opens every blocked AI agent and leaves an unrelated agent's rules alone", () => {
    const body = "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /tmp\n";
    const d = buildRobotsPatch({ ruleCode: "AUX-R-001", targetUrl: URL, body, bodyHash: sha(body) })!;
    expect(d.contentAfter).toContain("User-agent: GPTBot\nAllow: /\n");
    expect(d.contentAfter).toContain("User-agent: ClaudeBot\nAllow: /\n");
    expect(d.contentAfter).not.toContain("User-agent: Googlebot\nAllow");
  });

  it("AUX-R-002: names the AI agents that only inherit a restrictive wildcard", () => {
    const d = buildRobotsPatch({ ruleCode: "AUX-R-002", targetUrl: URL, body: "User-agent: *\nDisallow: /private\n", bodyHash: sha("x") })!;
    // The named group REPLACES the wildcard for that agent, so the wildcard's other restrictions are carried over: opening "/" must not
    // also open the paths the site restricted for everyone.
    for (const agent of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) expect(d.contentAfter).toContain(`User-agent: ${agent}\nDisallow: /private\nAllow: /\n`);
    const after = parseRobots(d.contentAfter);
    expect(isAllowed(after, "GPTBot", "/")).toBe(true);
    expect(isAllowed(after, "GPTBot", "/private")).toBe(false);
  });

  it("a file with nothing to open yields no patch (null is not an empty patch)", () => {
    const open = "User-agent: *\nAllow: /\n";
    expect(buildRobotsPatch({ ruleCode: "AUX-R-001", targetUrl: URL, body: open, bodyHash: sha(open) })).toBeNull();
  });

  it("a file without a trailing newline is not corrupted: the appended block starts on its own line", () => {
    const body = "User-agent: GPTBot\nDisallow: /";
    const d = buildRobotsPatch({ ruleCode: "AUX-R-001", targetUrl: URL, body, bodyHash: sha(body) })!;
    expect(d.contentAfter).toContain("Disallow: /\n\nUser-agent: GPTBot\nAllow: /\n");
  });
});

describe("STORY-053 scenario 4 · a directive patch that would block an agent is rejected outright", () => {
  const before = "User-agent: *\nAllow: /\n";
  const finalise = (appended: string, rule = "AUX-R-001"): unknown =>
    finaliseRobotsPatch({ ruleCode: rule, targetUrl: URL, before, beforeHash: sha(before), appended, explanation: "e" });

  it("rejects a new Disallow for a named agent, naming the agent and the path", () => {
    try {
      finalise("\nUser-agent: GPTBot\nDisallow: /\n");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PatchRejectedError);
      expect((e as PatchRejectedError).reason).toBe("would_reduce_access");
      expect((e as PatchRejectedError).detail).toMatchObject({ agent: "gptbot", path: "/" });
    }
  });

  it("rejects a wildcard block that would shut out every agent (against a file that restricted nobody)", () => {
    const open = "User-agent: *\nDisallow:\n";
    expect(() =>
      finaliseRobotsPatch({ ruleCode: "AUX-R-001", targetUrl: URL, before: open, beforeHash: sha(open), appended: "\nUser-agent: *\nDisallow: /\n", explanation: "e" }),
    ).toThrowError(PatchRejectedError);
  });

  it("rejects a block of one path (a reduction does not have to be total)", () => {
    expect(() => finalise("\nUser-agent: ClaudeBot\nDisallow: /pricing\n")).toThrowError(/would_reduce_access|reduce/);
  });

  it("rejects it whichever rule produced it", () => {
    for (const rule of ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-999"]) {
      expect(() => finalise("\nUser-agent: PerplexityBot\nDisallow: /\n", rule)).toThrowError(PatchRejectedError);
    }
  });

  it("rejects a reduction hidden inside an otherwise-permissive block", () => {
    expect(() => finalise("\nUser-agent: GPTBot\nAllow: /\nDisallow: /docs\n")).toThrowError(PatchRejectedError);
  });

  it("assertAccessNotReduced compares two whole files: an agent allowed before and blocked after fails, any other direction passes", () => {
    expect(() => assertAccessNotReduced("User-agent: *\nAllow: /\n", "User-agent: *\nDisallow: /\n")).toThrowError(PatchRejectedError);
    expect(() => assertAccessNotReduced("User-agent: *\nDisallow: /\n", "User-agent: *\nAllow: /\n")).not.toThrow();
    expect(() => assertAccessNotReduced(BLOCKED, BLOCKED)).not.toThrow();
  });

  it("a block that only restates what is already blocked is not a reduction", () => {
    expect(() => assertAccessNotReduced(BLOCKED, [BLOCKED, "\nUser-agent: GPTBot\nDisallow: /secret\n"].join(""))).not.toThrow();
  });

  it("rejects an appended block that does not parse", () => {
    try {
      finalise("\nthis is not a directive\n");
      expect.unreachable();
    } catch (e) {
      expect((e as PatchRejectedError).reason).toBe("malformed_robots");
    }
  });
});

describe("STORY-053 scenario 5 · a directive patch that only permits is accepted and its output parses", () => {
  it("accepts an Allow-only block and re-serialises it with no unparseable line", () => {
    const before = WILDCARD;
    const d = finaliseRobotsPatch({
      ruleCode: "AUX-R-002", targetUrl: URL, before, beforeHash: sha(before), appended: "\nUser-agent: GPTBot\nAllow: /\n", explanation: "e",
    });
    expect(d.contentAfter).toBe([before, "\nUser-agent: GPTBot\nAllow: /\n"].join(""));
    expect(evaluateRobotsTxt({ status: 200, body: d.contentAfter }, ["/"]).some((f) => f.rule_code === "AUX-R-003")).toBe(false);
  });

  it("a file that already had an unparseable line is not made worse, and is not blamed for it", () => {
    const before = "User-agent: GPTBot\nDisallow: /\ngarbage line\n";
    expect(() =>
      finaliseRobotsPatch({ ruleCode: "AUX-R-001", targetUrl: URL, before, beforeHash: sha(before), appended: "\nUser-agent: GPTBot\nAllow: /\n", explanation: "e" }),
    ).not.toThrow();
  });
});

describe("STORY-053 AC5 · the verification is bounded so it cannot hold the commit lock for long", () => {
  const rules = (n: number): string => Array.from({ length: n }, (_, i) => `Disallow: /p${i}`).join("\n");
  it("the worst case at the bounds is under one hundred million matcher calls", () => {
    const { rules: r, agents: a } = VERIFICATION_BOUNDS;
    // paths: 2 fixed + 3 probes per rule, over before AND after; each check evaluates two files of up to `r` rules.
    const calls = a * (2 + 3 * 2 * r) * 2 * r;
    expect(calls).toBeLessThan(100_000_000);
  });
  it("refuses a file one rule over the bound, and accepts one at it", () => {
    const at = `User-agent: *\n${rules(VERIFICATION_BOUNDS.rules)}\n`;
    expect(() => assertAccessNotReduced(at, at)).not.toThrow();
    const over = `User-agent: *\n${rules(VERIFICATION_BOUNDS.rules + 1)}\n`;
    expect(() => assertAccessNotReduced(over, over)).toThrowError(PatchRejectedError);
  });
  it("finishes a file at both bounds quickly", () => {
    const named = VERIFICATION_BOUNDS.agents - 20; // plus the eight AI tokens, `*` and the unlisted stand-in
    const agents = Array.from({ length: named }, (_, i) => `User-agent: bot${i}\nDisallow: /a\n`).join("\n");
    const file = `${agents}\nUser-agent: *\n${rules(VERIFICATION_BOUNDS.rules - named - 1)}\n`;
    const started = Date.now();
    assertAccessNotReduced(file, `${file}\nUser-agent: extra\nAllow: /\n`);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
