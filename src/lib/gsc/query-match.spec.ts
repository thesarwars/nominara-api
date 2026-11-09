import { describe, expect, it } from "vitest";
import { LOW_CONFIDENCE_BELOW, QUERY_MATCH_FLOOR, matchQueryToPrompt, trigramSimilarity } from "./query-match.js";

const prompts = [
  { id: "p-2", text: "best crm for small business" },
  { id: "p-1", text: "best crm for startups" },
  { id: "p-3", text: "how do i migrate away from spreadsheets" },
];

// STORY-115 J2-J4 - the fuzzy query join: documented, deterministic, floored, never exact.
describe("STORY-115 fuzzy query match", () => {
  it("S115-16a: the floor is the documented 0.80", () => {
    expect(QUERY_MATCH_FLOOR).toBe(0.8);
    expect(LOW_CONFIDENCE_BELOW).toBeGreaterThan(QUERY_MATCH_FLOOR);
  });

  it("S115-16b: case, punctuation and spacing do not change the similarity", () => {
    expect(trigramSimilarity("Best CRM, for startups?", "best  crm for startups")).toBe(1);
  });

  it("S115-16c: similarity is symmetric and bounded", () => {
    const ab = trigramSimilarity("best crm for startups", "best crm for enterprises");
    expect(ab).toBe(trigramSimilarity("best crm for enterprises", "best crm for startups"));
    expect(ab).toBeGreaterThanOrEqual(0);
    expect(ab).toBeLessThan(1);
    expect(trigramSimilarity("", "")).toBe(0);
  });

  it("S115-16d: known pairs join with their method and confidence", () => {
    const exactAfterNormalising = matchQueryToPrompt("Best CRM for startups?", prompts);
    expect(exactAfterNormalising).toMatchObject({ promptId: "p-1", method: "trigram", confidence: 1 });
    const plural = matchQueryToPrompt("best crm for small businesses", prompts);
    expect(plural).toMatchObject({ promptId: "p-2", method: "trigram" });
    expect(plural!.confidence).toBeGreaterThanOrEqual(QUERY_MATCH_FLOOR);
  });

  it.each([
    ["best crm for enterprises", "a sibling intent differing in one word"],
    ["best crm", "a prefix of a prompt"],
    ["crm", "a single word"],
    ["cheap flights to lisbon", "an unrelated query"],
    ["", "an empty query"],
  ])("S115-17: %j is below the floor and is NOT joined at all (%s)", (query) => {
    expect(matchQueryToPrompt(query, prompts)).toBeNull();
  });

  it("S115-16e: deterministic, and a tie goes to the lowest prompt id whatever the input order", () => {
    const twins = [
      { id: "b", text: "best crm for startups" },
      { id: "a", text: "best crm for startups" },
    ];
    expect(matchQueryToPrompt("best crm for startups", twins)?.promptId).toBe("a");
    expect(matchQueryToPrompt("best crm for startups", [...twins].reverse())?.promptId).toBe("a");
    const first = matchQueryToPrompt("best crm for small businesses", prompts);
    expect(matchQueryToPrompt("best crm for small businesses", prompts)).toEqual(first);
  });

  it("S115-15: a match below LOW_CONFIDENCE_BELOW is flagged low confidence; a match is never exact", () => {
    const weak = matchQueryToPrompt("best crm for small businesses", prompts)!;
    expect(weak.lowConfidence).toBe(weak.confidence < LOW_CONFIDENCE_BELOW);
    const strong = matchQueryToPrompt("best crm for startups", prompts)!;
    expect(strong.lowConfidence).toBe(false);
    expect((strong as { exact?: boolean }).exact).toBeUndefined();
  });
});
