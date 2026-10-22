import { describe, expect, it } from "vitest";
import { MAX_STORED_TEXT_CHARS, sanitiseText } from "./sanitise.js";

// STORY-049 AC11 — crawled content is untrusted. The bytes of a page are stored exactly as fetched, in object storage
// (aux-and-geo-analysis.md AUX-R-027 needs the script a site ships). What is sanitised is the TEXT that reaches Postgres.
describe("STORY-049 AC11 · sanitiseText (text that reaches Postgres)", () => {
  it("removes NUL, which Postgres text cannot hold (a robots.txt with one would otherwise fail the whole audit write)", () => {
    expect(sanitiseText("User-agent: *\u0000Disallow: /")).toBe("User-agent: *Disallow: /");
  });

  it("removes other C0 and C1 control characters but keeps tab, newline and carriage return", () => {
    expect(sanitiseText("a\u0007b\u001bc\u0085d\te\nf\rg")).toBe("abcd\te\nf\rg");
  });

  it("replaces a lone surrogate with U+FFFD rather than emitting invalid UTF-8", () => {
    expect(sanitiseText("x\ud800y")).toBe("x�y");
    expect(sanitiseText("ok \u{1F600}")).toBe("ok \u{1F600}");
  });

  it("caps the length in characters and never splits a surrogate pair", () => {
    expect(sanitiseText("abcdef", 3)).toBe("abc");
    expect(sanitiseText("a\u{1F600}b", 2)).toBe("a\u{1F600}".slice(0, 1)); // 2 code units would split the pair: it is dropped whole
    expect(sanitiseText("abc", 3)).toBe("abc");
  });

  it("an empty string stays empty, and the default cap is the stated constant", () => {
    expect(sanitiseText("")).toBe("");
    expect(sanitiseText("x".repeat(MAX_STORED_TEXT_CHARS + 5)).length).toBe(MAX_STORED_TEXT_CHARS);
  });
});
