import { describe, expect, it } from "vitest";
import { fold, toOriginalSpan } from "../../../src/lib/parser/fold.js";
import { InvalidSpanError } from "../../../src/lib/parser/normalize.js";

// STORY-036 — the index back from folded space.
//
// The subtlest file in the parser: folding is NOT length-preserving, so an
// offset into the folded string is not an offset into the original. Every
// highlight the product ever renders depends on this mapping being exact, and
// a mapping that is off by one is invisible — the text still looks like text.

describe("fold", () => {
  it("lower-cases and strips diacritics", () => {
    expect(fold("CAFÉ Pricing").folded).toBe("cafe pricing");
  });

  it("SHORTENS the string, which is why the index exists", () => {
    // Built from escapes: "e" + U+0301 and precomposed "é" are
    // indistinguishable in source.
    const decomposed = "cafe\u0301";
    expect(decomposed.length).toBe(5);
    expect(fold(decomposed).folded).toBe("cafe");
    expect(fold(decomposed).folded.length).toBe(4);
  });

  it("maps every folded offset back to where it came from", () => {
    const original = "cafe\u0301 pricing";
    const folded = fold(original);

    // "pricing" starts at folded 5 and original 5 here; the interesting case
    // is that the map is consulted rather than assumed.
    const span = toOriginalSpan(folded, { start: folded.folded.indexOf("pricing"), end: folded.folded.length });
    expect(original.slice(span.start, span.end)).toBe("pricing");
  });

  it("maps back correctly ACROSS a decomposed character", () => {
    // The case a naive implementation gets wrong: everything after the accent
    // is shifted by the stripped combining mark.
    const original = "café pricing";
    const folded = fold(original);
    expect(folded.folded).toBe("cafe pricing");

    const span = toOriginalSpan(folded, { start: 5, end: 12 });
    expect(original.slice(span.start, span.end)).toBe("pricing");
    // Proves the shift is real rather than the two strings happening to align.
    expect(span.start).toBe(6);
  });

  it("maps the end of the string, so a match reaching the end is not short by one", () => {
    const original = "HubSpot";
    const folded = fold(original);
    const span = toOriginalSpan(folded, { start: 0, end: folded.folded.length });
    expect(original.slice(span.start, span.end)).toBe("HubSpot");
  });

  it("handles a character that folds to nothing", () => {
    // A lone combining mark occupies space in the original and none in the
    // folded string; the next folded character must map past it.
    const original = "áb";
    const folded = fold(original);
    expect(folded.folded).toBe("ab");
    expect(toOriginalSpan(folded, { start: 1, end: 2 }).start).toBe(2);
  });

  it("iterates by code point, so a surrogate pair is one character", () => {
    const original = "🚀 HubSpot";
    const folded = fold(original);
    const span = toOriginalSpan(folded, { start: folded.folded.indexOf("hubspot"), end: folded.folded.length });
    expect(original.slice(span.start, span.end)).toBe("HubSpot");
  });

  it("validates on the way out rather than returning a bad span", () => {
    const folded = fold("short");
    expect(() => toOriginalSpan(folded, { start: 3, end: 1 })).toThrow(InvalidSpanError);
    expect(() => toOriginalSpan(folded, { start: 0, end: 99 })).toThrow(/outside the folded string/);
  });
});
