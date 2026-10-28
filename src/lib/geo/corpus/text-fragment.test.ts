import { describe, expect, it } from "vitest";
import { passageFromTextFragment } from "./text-fragment.js";

// STORY-058 AC3 - a citation's text directive IS the passage the engine quoted.
describe("passageFromTextFragment", () => {
  it("AC3 - a plain start is the passage, percent-decoded", () => {
    expect(passageFromTextFragment("teams%20compare%20options")).toBe("teams compare options");
  });
  it("AC3 - start,end keeps both quoted ends", () => {
    expect(passageFromTextFragment("The%20first,the%20last")).toBe("The first the last");
  });
  it("AC3 - prefix- and -suffix context terms are not part of the quote", () => {
    expect(passageFromTextFragment("before-,the%20quoted%20text,-after")).toBe("the quoted text");
    expect(passageFromTextFragment("before-,start,end,-after")).toBe("start end");
  });
  it("AC3 - only the first of several directives is used", () => {
    expect(passageFromTextFragment("first%20one&text=second%20one")).toBe("first one");
  });
  it("AC3 - an empty, undecodable or whitespace-only directive is null so the caller falls back to a fetch", () => {
    expect(passageFromTextFragment("")).toBeNull();
    expect(passageFromTextFragment("%20%20")).toBeNull();
    expect(passageFromTextFragment("%E0%A4%A")).toBeNull();
    expect(passageFromTextFragment("-,-")).toBeNull();
  });
  it("AC3 - a literal comma inside the quote is percent-encoded and survives", () => {
    expect(passageFromTextFragment("one%2C%20two")).toBe("one, two");
  });
  it("AC3 - control characters (a NUL would fail the Postgres insert) are stripped; a directive that is only control characters is null", () => {
    expect(passageFromTextFragment("a%00b")).toBe("ab");
    expect(passageFromTextFragment("%00%01")).toBeNull();
  });
});
