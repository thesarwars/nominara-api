import { describe, expect, it } from "vitest";
import { parseConfirmedCredits, requireConfirmedCredits } from "./confirmed-credits.js";

// api-specification.md section 1, `X-Nominara-Confirmed-Credits`: "Echoes the exact figure shown to the operator."
// One parser for the guard (flat-priced routes) and for the inline-debit routes (prompt activation), so the two
// cannot disagree about what a well-formed header is.

describe("STORY-046 AC3 - parseConfirmedCredits", () => {
  it("reads an exact non-negative integer, and 0 is a figure, not an absence", () => {
    expect(parseConfirmedCredits("200")).toBe(200);
    expect(parseConfirmedCredits(" 7 ")).toBe(7);
    expect(parseConfirmedCredits("0")).toBe(0);
  });

  it("takes the first value of a repeated header", () => {
    expect(parseConfirmedCredits(["3", "9"])).toBe(3);
  });

  it("reports an absent or blank header as null, never as 0", () => {
    expect(parseConfirmedCredits(undefined)).toBeNull();
    expect(parseConfirmedCredits("")).toBeNull();
    expect(parseConfirmedCredits("   ")).toBeNull();
    expect(parseConfirmedCredits([])).toBeNull();
  });

  it.each(["200abc", "2.5", "-1", "two", "1e3", "0x10"])("refuses %s: it was not echoed from a quote", (value) => {
    expect(() => parseConfirmedCredits(value)).toThrowError(expect.objectContaining({ code: "validation_failed" }));
  });
});

describe("STORY-046 AC3 - requireConfirmedCredits", () => {
  it("refuses an absent figure, the way the deep-scan route does", () => {
    expect(() => requireConfirmedCredits(null)).toThrowError(expect.objectContaining({ code: "validation_failed" }));
  });

  it("passes a figure through, 0 included", () => {
    expect(requireConfirmedCredits(0)).toBe(0);
    expect(requireConfirmedCredits(12)).toBe(12);
  });
});
