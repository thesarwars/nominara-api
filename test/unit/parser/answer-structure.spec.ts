import { describe, expect, it } from "vitest";
import type { AnswerElement } from "../../../src/lib/engines/contract.js";
import { classifyAnswerForm, classifyPositionClass } from "../../../src/lib/parser/answer-structure.js";

// STORY-040's twelve scenarios.

function element(kind: AnswerElement["kind"] = "ai_overview_element"): AnswerElement {
  return { kind, links: [] } as AnswerElement;
}

function position(text: string, needle: string, over: Partial<Parameters<typeof classifyPositionClass>[0]> = {}) {
  const start = text.indexOf(needle);
  return classifyPositionClass({
    text,
    mention: { start, end: start + needle.length },
    answerForm: "narrative",
    listPosition: null,
    ...over,
  });
}

describe("STORY-040 · answer form", () => {
  it("Scenario 1 — a ranked list", () => {
    const text = ["The best CRMs, ranked:", "", "1. HubSpot", "2. Salesforce", "3. Pipedrive"].join("\n");
    expect(classifyAnswerForm(text)).toMatchObject({ form: "ranked_list", fellBack: false });
  });

  it("Scenario 4 — a numbered list with NO ranking language is a neutral enumeration", () => {
    // Engines number neutral lists all the time. The ordinal alone is not a
    // claim that the engine stands behind an order.
    const text = ["Common options:", "", "1. HubSpot", "2. Salesforce"].join("\n");
    expect(classifyAnswerForm(text).form).toBe("neutral_enumeration");
  });

  it("Scenario 2 — a comparison table", () => {
    const text = ["| Tool | Seats |", "| --- | --- |", "| HubSpot | 50 |"].join("\n");
    expect(classifyAnswerForm(text).form).toBe("comparison_table");
  });

  it("does not read a two-line fragment as a table", () => {
    // A header and one row is not yet a comparison; three lines is the
    // smallest real table.
    expect(classifyAnswerForm(["| Tool |", "| --- |"].join("\n")).form).not.toBe("comparison_table");
  });

  it("Scenario 3 — a single recommendation", () => {
    expect(classifyAnswerForm("We recommend HubSpot for teams of this size.").form).toBe("single_recommendation");
  });

  it("Scenario 5 — prose is narrative", () => {
    expect(classifyAnswerForm("HubSpot and Salesforce both serve this market well.").form).toBe("narrative");
  });

  it("Scenario 12 — an unclassifiable answer falls back to narrative and RECORDS the fallback", () => {
    // Null would make the distribution over a window incomputable; an
    // unrecorded fallback would make narrative look like a finding rather
    // than the absence of one.
    const result = classifyAnswerForm("Mmm.");
    expect(result).toMatchObject({ form: "narrative", fellBack: true });
  });

  it("Scenario 9 — DERIVES the form from typed elements, and records the method", () => {
    // A `table_element` is a comparison table as a matter of fact; reading
    // the markdown to reach the same conclusion is a guess that happens to be
    // right.
    const derived = classifyAnswerForm("prose with no table at all", [element("table_element")]);
    expect(derived).toMatchObject({ form: "comparison_table", method: "derived" });
  });

  it("Scenario 10 — records `inferred` when there are no elements", () => {
    expect(classifyAnswerForm("1. HubSpot\n2. Salesforce").method).toBe("inferred");
  });
});

describe("STORY-040 · position class", () => {
  it("Scenario 6 — a recommendation clause", () => {
    expect(position("We recommend HubSpot for scaling teams.", "HubSpot").positionClass).toBe("recommendation");
  });

  it("Scenario 7 — an also-consider tail", () => {
    const text = ["We recommend Salesforce.", "", "Also consider:", "", "- HubSpot"].join("\n");
    expect(position(text, "HubSpot").positionClass).toBe("also_consider");
  });

  it("Scenario 8 — a warning is a caveat", () => {
    expect(position("However, HubSpot struggles at enterprise scale.", "HubSpot").positionClass).toBe("caveat");
  });

  it("a caveat INSIDE a recommendation clause is a caveat", () => {
    // Order matters: a sentence recommending a tool and then warning about it
    // is warning about it, and reading the recommendation first loses that.
    expect(position("We recommend HubSpot, however it struggles at scale.", "HubSpot").positionClass).toBe("caveat");
  });

  it("a ranked list position is `ranked`", () => {
    expect(position("1. HubSpot", "HubSpot", { answerForm: "ranked_list", listPosition: 1 }).positionClass).toBe("ranked");
  });

  it("falls through to neutral_list", () => {
    expect(position("- HubSpot", "HubSpot", { answerForm: "neutral_enumeration" }).positionClass).toBe("neutral_list");
  });
});

describe("STORY-040 · derived versus inferred", () => {
  const elements = [element(), element(), element()];

  it("Scenario 9 — the LEAD element is a recommendation, DERIVED", () => {
    // "Character-offset heuristics confuse a caveat at the end of a long
    // recommendation paragraph with a genuine trailing caveat. Per-element
    // references remove the guess entirely."
    const result = position("HubSpot", "HubSpot", { elements, elementIndex: 0 });
    expect(result).toEqual({ positionClass: "recommendation", method: "derived" });
  });

  it("the TRAILING element is a caveat, derived", () => {
    const result = position("HubSpot", "HubSpot", { elements, elementIndex: 2 });
    expect(result).toEqual({ positionClass: "caveat", method: "derived" });
  });

  it("a middle element takes the answer form's class", () => {
    expect(position("HubSpot", "HubSpot", { elements, elementIndex: 1, answerForm: "ranked_list" }).positionClass).toBe("ranked");
    expect(position("HubSpot", "HubSpot", { elements, elementIndex: 1, answerForm: "narrative" }).positionClass).toBe("neutral_list");
  });

  it("Scenario 10 — records `inferred` when the surface has no elements", () => {
    // The two paths have different reliability, and an analysis that mixed
    // them without knowing would over-trust the inferred half.
    expect(position("We recommend HubSpot.", "HubSpot").method).toBe("inferred");
  });

  it("falls back to inference rather than deriving from an out-of-range index", () => {
    expect(position("We recommend HubSpot.", "HubSpot", { elements, elementIndex: 9 }).method).toBe("inferred");
  });

  it("does not call an element a caveat when there are only two of them", () => {
    // With two elements a "trailing" one is just the second half of a short
    // answer, not a warning appended after the substance.
    const two = [element(), element()];
    expect(position("HubSpot", "HubSpot", { elements: two, elementIndex: 1 }).positionClass).not.toBe("caveat");
  });
});

describe("STORY-040 · movement", () => {
  it("Scenario 11 — the class is a per-mention value, so a change between captures is visible", () => {
    // "A brand that stays mentioned while sliding from recommendation to
    // also-consider is losing, and every mention-counting tool reports it as
    // flat." This asserts the shape that makes the trend possible at all:
    // the same brand, same prompt, two captures, two classes.
    const before = position("We recommend HubSpot for scaling teams.", "HubSpot").positionClass;
    const after = position(
      ["We recommend Salesforce.", "", "Also consider:", "", "- HubSpot"].join("\n"),
      "HubSpot",
    ).positionClass;

    expect(before).toBe("recommendation");
    expect(after).toBe("also_consider");
    expect(before).not.toBe(after);
  });
});
