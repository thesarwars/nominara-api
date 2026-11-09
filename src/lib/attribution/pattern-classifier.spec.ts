import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ATTRIBUTION_PATTERNS, SUBSTITUTION_CO_MOVEMENT_COPY } from "../../../contracts/attribution/index.js";
import { ATTRIBUTION_THRESHOLDS, classifyUrl, substitutionNote, type UrlFigures } from "./pattern-classifier.js";

// STORY-114 patterns - scoring-models.md section 11. Scenario numbers are the story's Test scenarios table.

const T = ATTRIBUTION_THRESHOLDS;
const base: UrlFigures = { citations: 5, citationsPrior: 5, aiSessions: 100, aiSessionsPrior: 100, organicClicks: 40 };
const fig = (over: Partial<UrlFigures>): UrlFigures => ({ ...base, ...over });

describe("STORY-114 S10 - every documented pattern is reachable from fixtures", () => {
  it("dual_visibility: cited, AI sessions, organic clicks present", () => {
    expect(classifyUrl(fig({}))).toBe("dual_visibility");
  });
  it("ai_only: cited, AI sessions, organic clicks measured at zero", () => {
    expect(classifyUrl(fig({ organicClicks: 0 }))).toBe("ai_only");
  });
  it("organic_only: not cited, organic clicks > 0", () => {
    expect(classifyUrl(fig({ citations: 0, citationsPrior: 0, aiSessions: 0, aiSessionsPrior: 0, organicClicks: 9 }))).toBe("organic_only");
  });
  it("ai_substitution_candidate: citations up, sessions down more than 10 percent, n >= 30", () => {
    expect(classifyUrl(fig({ citations: 9, citationsPrior: 5, aiSessions: 60, aiSessionsPrior: 100 }))).toBe("ai_substitution_candidate");
  });
  it("invisible_both: no citations, no AI sessions", () => {
    expect(classifyUrl(fig({ citations: 0, citationsPrior: 0, aiSessions: 0, aiSessionsPrior: 0, organicClicks: 0 }))).toBe("invisible_both");
  });
  it("insufficient_data: a side below its evidence minimum", () => {
    expect(classifyUrl(fig({ aiSessions: 3 }))).toBe("insufficient_data");
  });
  it("the fixtures above cover the whole documented set", () => {
    expect(new Set(ATTRIBUTION_PATTERNS)).toEqual(new Set(["dual_visibility", "ai_only", "organic_only", "ai_substitution_candidate", "invisible_both", "insufficient_data"]));
  });
});

describe("STORY-114 S11 - insufficient data is assigned, never blank, at either side's minimum", () => {
  it("sessions: MIN - 1 is insufficient, MIN is enough", () => {
    expect(classifyUrl(fig({ aiSessions: T.MIN_AI_SESSIONS - 1, aiSessionsPrior: T.MIN_AI_SESSIONS - 1 }))).toBe("insufficient_data");
    expect(classifyUrl(fig({ aiSessions: T.MIN_AI_SESSIONS, aiSessionsPrior: T.MIN_AI_SESSIONS }))).toBe("dual_visibility");
  });
  it("citations: sessions present but no citations is insufficient, not blank and not invisible", () => {
    expect(classifyUrl(fig({ citations: 0, citationsPrior: 0, organicClicks: 0 }))).toBe("insufficient_data");
  });
  it("citations at their minimum with sessions below theirs is insufficient", () => {
    expect(classifyUrl(fig({ citations: T.MIN_CITATIONS, aiSessions: 1, aiSessionsPrior: 1 }))).toBe("insufficient_data");
  });
  it("every classification is one of the documented patterns, over a grid of inputs (never undefined)", () => {
    const counts = [0, 1, 29, 30, 31, 500];
    for (const citations of counts) for (const citationsPrior of counts) for (const aiSessions of counts) for (const aiSessionsPrior of counts) {
      for (const organicClicks of [null, 0, 1, 80]) {
        expect(ATTRIBUTION_PATTERNS).toContain(classifyUrl({ citations, citationsPrior, aiSessions, aiSessionsPrior, organicClicks }));
      }
    }
  });
});

describe("STORY-114 S12 - the substitution candidate, boundary-tested at every threshold", () => {
  const sub = (over: Partial<UrlFigures>) => classifyUrl(fig({ citations: 6, citationsPrior: 5, aiSessionsPrior: 100, aiSessions: 80, ...over }));
  it("citation velocity must be strictly positive", () => {
    expect(sub({})).toBe("ai_substitution_candidate");
    expect(sub({ citations: 5 })).not.toBe("ai_substitution_candidate");
    expect(sub({ citations: 4 })).not.toBe("ai_substitution_candidate");
  });
  it("session velocity must be strictly below minus 10 percent", () => {
    expect(sub({ aiSessions: 89 })).toBe("ai_substitution_candidate"); // -11 percent
    expect(sub({ aiSessions: 90 })).not.toBe("ai_substitution_candidate"); // exactly -10 percent
    expect(sub({ aiSessions: 91 })).not.toBe("ai_substitution_candidate");
    expect(T.SUBSTITUTION_SESSION_DROP).toBe(0.1);
  });
  it("the base of the decline needs n >= 30 sessions", () => {
    expect(sub({ aiSessionsPrior: 30, aiSessions: 26 })).toBe("ai_substitution_candidate");
    expect(sub({ aiSessionsPrior: 29, aiSessions: 20 })).not.toBe("ai_substitution_candidate");
    expect(T.MIN_AI_SESSIONS).toBe(30);
  });
  it("a prior window with no sessions has no session velocity, so cannot be a substitution", () => {
    expect(sub({ aiSessionsPrior: 0, aiSessions: 0 })).not.toBe("ai_substitution_candidate");
  });
  it("it does not depend on whether Search Console is connected", () => {
    expect(sub({ organicClicks: null })).toBe("ai_substitution_candidate");
    expect(sub({ organicClicks: 0 })).toBe("ai_substitution_candidate");
  });
});

describe("STORY-114 S13 - the substitution copy is co-movement, from the shared constant", () => {
  it("is the contract's constant, and never asserts causation", () => {
    expect(substitutionNote("ai_substitution_candidate")).toBe(SUBSTITUTION_CO_MOVEMENT_COPY);
    expect(substitutionNote("dual_visibility")).toBeNull();
    expect(SUBSTITUTION_CO_MOVEMENT_COPY).toMatch(/moved together/);
    expect(SUBSTITUTION_CO_MOVEMENT_COPY).not.toMatch(/\b(because|caused|causes|due to|result of|led to)\b/i);
  });
});

describe("STORY-114 S14 - the thresholds live in one place", () => {
  it("no other file in the attribution library restates a threshold number", () => {
    const dir = __dirname;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts") && name !== "pattern-classifier.ts")) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/SUBSTITUTION_SESSION_DROP\s*[:=]|MIN_AI_SESSIONS\s*[:=]|MIN_CITATIONS\s*[:=]|<\s*-0\.1\b/);
    }
  });
  it("the thresholds are frozen and documented", () => {
    expect(Object.isFrozen(ATTRIBUTION_THRESHOLDS)).toBe(true);
    expect(readFileSync(join(__dirname, "pattern-classifier.ts"), "utf8")).toMatch(/PROVISIONAL/);
  });
});

describe("STORY-114 S15 - both absent is invisible, not omitted", () => {
  it("zero citations and zero sessions, with clicks unknown or zero", () => {
    for (const organicClicks of [null, 0]) {
      expect(classifyUrl({ citations: 0, citationsPrior: 0, aiSessions: 0, aiSessionsPrior: 0, organicClicks })).toBe("invisible_both");
    }
  });
});

describe("STORY-114 S16 - an unconnected source narrows the pattern set and never widens a classification", () => {
  it("with clicks unknown, neither ai_only nor organic_only is ever produced", () => {
    const counts = [0, 1, 29, 30, 500];
    for (const citations of counts) for (const aiSessions of counts) for (const citationsPrior of counts) for (const aiSessionsPrior of counts) {
      const pattern = classifyUrl({ citations, citationsPrior, aiSessions, aiSessionsPrior, organicClicks: null });
      expect(["ai_only", "organic_only"]).not.toContain(pattern);
    }
  });
  it("a page cited and visited with clicks unknown is dual_visibility, never the AI-only claim", () => {
    expect(classifyUrl(fig({ organicClicks: null }))).toBe("dual_visibility");
  });
  it("unknown clicks never produce a pattern a measured click count would not also allow", () => {
    const counts = [0, 1, 29, 30, 500];
    for (const citations of counts) for (const aiSessions of counts) for (const citationsPrior of counts) for (const aiSessionsPrior of counts) {
      const unknown = classifyUrl({ citations, citationsPrior, aiSessions, aiSessionsPrior, organicClicks: null });
      const allowed = [0, 1, 80].map((organicClicks) => classifyUrl({ citations, citationsPrior, aiSessions, aiSessionsPrior, organicClicks }));
      expect(allowed, `${String(citations)}/${String(aiSessions)}`).toContain(unknown);
    }
  });
});

describe("STORY-114 S9 - the classifier calls no model", () => {
  it("is a pure function: no network, no model client, no clock", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    classifyUrl(fig({}));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const source = readFileSync(join(__dirname, "pattern-classifier.ts"), "utf8");
    expect(source).not.toMatch(/^import .*(anthropic|openai|genai|engines|embedding|fetch|http)/im);
  });
});
