import { describe, expect, it } from "vitest";
import { ifNoneMatchMatches } from "./if-none-match.js";

describe("STORY-078 AC12 · If-None-Match matching (weak comparison, never an error)", () => {
  const tag = "0123456789abcdef0123456789abcdef";

  it("matches the current tag, quoted, strong or weak", () => {
    expect(ifNoneMatchMatches(`"${tag}"`, tag)).toBe(true);
    expect(ifNoneMatchMatches(`W/"${tag}"`, tag)).toBe(true);
  });

  it("matches when any tag in a list matches, with or without spaces", () => {
    expect(ifNoneMatchMatches(`"a", "${tag}"`, tag)).toBe(true);
    expect(ifNoneMatchMatches(`"a","b",W/"${tag}"`, tag)).toBe(true);
  });

  it("does not match a different tag, a prefix of the tag, or an absent header", () => {
    expect(ifNoneMatchMatches('"other"', tag)).toBe(false);
    expect(ifNoneMatchMatches(`"${tag.slice(0, 8)}"`, tag)).toBe(false);
    expect(ifNoneMatchMatches(undefined, tag)).toBe(false);
    expect(ifNoneMatchMatches("", tag)).toBe(false);
  });

  it("the wildcard matches any current representation", () => {
    expect(ifNoneMatchMatches("*", tag)).toBe(true);
  });

  it("a header that does not parse is treated as absent (the representation is sent), not as an error", () => {
    expect(ifNoneMatchMatches(tag, tag)).toBe(false);
    expect(ifNoneMatchMatches(`"${tag}`, tag)).toBe(false);
    expect(ifNoneMatchMatches(`,,"${tag}"`, tag)).toBe(false);
    expect(ifNoneMatchMatches(`"a",,"${tag}"`, tag)).toBe(false);
  });
});
