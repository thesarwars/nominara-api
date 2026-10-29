import { describe, expect, it } from "vitest";
import { CORPUS } from "./constants.js";
import { queryTermsOf, selectTopChunks } from "./lexical.js";

const chunk = (index: number, text: string) => ({ index, text, tokenCount: text.split(/\s+/).length });

describe("lexical selection - STORY-058 AC6", () => {
  it("AC6 - keeps 3 per URL (reference constant)", () => {
    expect(CORPUS.keepPerUrl).toBe(3);
  });
  it("AC6 - query terms are the prompts' words: lower-cased, de-duplicated, stop words dropped", () => {
    expect(queryTermsOf(["How do teams compare Reporting tools?", "reporting tools for the teams"]).sort()).toEqual(["compare", "reporting", "teams", "tools"]);
  });
  it("AC6 - scenario 6: navigation boilerplate is not selected over substance", () => {
    const chunks = [
      chunk(0, "Home About Pricing Contact Login Sign up Blog Careers Privacy Terms"),
      chunk(1, "Teams compare reporting tools by export formats and scheduled delivery"),
      chunk(2, "Reporting tools differ in how teams schedule reports"),
      chunk(3, "Cookie settings accept all reject all manage preferences"),
      chunk(4, "Choosing between reporting tools: what teams ask"),
      chunk(5, "Copyright 2026 all rights reserved"),
    ];
    const kept = selectTopChunks(chunks, queryTermsOf(["how do teams compare reporting tools"]));
    expect(kept.map((c) => c.index).sort()).toEqual([1, 2, 4]);
  });
  it("AC6 - a chunk with no overlap at all is never kept, even when fewer than 3 match", () => {
    const kept = selectTopChunks([chunk(0, "nothing relevant"), chunk(1, "reporting tools here")], ["reporting"]);
    expect(kept.map((c) => c.index)).toEqual([1]);
  });
  it("AC6 - no query terms, or no chunks, keeps nothing", () => {
    expect(selectTopChunks([chunk(0, "reporting")], [])).toEqual([]);
    expect(selectTopChunks([], ["reporting"])).toEqual([]);
  });
  it("AC6 - ties break on document order, deterministically", () => {
    const same = [chunk(0, "reporting"), chunk(1, "reporting"), chunk(2, "reporting"), chunk(3, "reporting")];
    expect(selectTopChunks(same, ["reporting"]).map((c) => c.index)).toEqual([0, 1, 2]);
  });
  it("AC6 - a repeated term does not let one chunk dominate by length alone (saturation)", () => {
    const kept = selectTopChunks(
      [chunk(0, "reporting ".repeat(60)), chunk(1, "reporting tools teams compare"), chunk(2, "tools teams")],
      ["reporting", "tools", "teams", "compare"],
      1,
    );
    expect(kept[0]!.index).toBe(1);
  });
});
