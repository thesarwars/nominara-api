import { describe, expect, it } from "vitest";
import {
  assertValidSpan,
  InvalidSpanError,
  normalize,
  NORMALIZER_VERSION,
  requiresReparse,
} from "../../../src/lib/parser/normalize.js";

// STORY-035's nine scenarios.
//
// This is the root of the parser chain: every character offset in the product
// is defined against `normalize`'s output, so a change here moves every stored
// highlight at once. The tests below are mostly about what the function must
// NOT do.

// ESCAPES, NOT LITERALS. A literal zero-width character in a test file is
// invisible in a diff and in a review, and one lost to an editor's cleanup
// would leave the test passing while asserting nothing.
const ZWSP = "\u200B";
const ZWNJ = "\u200C";
const ZWJ = "\u200D";
const BOM = "\uFEFF";

describe("STORY-035 · normalize — the four operations", () => {
  it("Scenario 1 — unifies CRLF and lone CR to LF", () => {
    expect(normalize("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("Scenario 2 — composes decomposed Unicode to NFC", () => {
    // BUILT FROM ESCAPES, not typed. "e" + U+0301 and the precomposed "é"
    // are indistinguishable on screen and in a diff, so a source literal
    // would silently become whichever form the editor last saved — and this
    // test would then assert nothing.
    const decomposed = "cafe\u0301 pricing";
    const composed = "caf\u00E9 pricing";
    expect(decomposed.length).toBe(13);
    expect(composed.length).toBe(12);

    // The reason it matters: an offset computed against the decomposed form
    // points one character further into the composed string than it should.
    expect(normalize(decomposed)).toBe(composed);
    expect(normalize(decomposed).length).toBe(12);
  });

  it("Scenario 3 — strips every zero-width character", () => {
    expect(normalize(`Hub${ZWSP}Spot${ZWNJ} C${ZWJ}RM${BOM}`)).toBe("HubSpot CRM");
  });

  it("Scenario 4 — collapses more than two consecutive blank lines to two", () => {
    // Four blank lines is five newlines; two blank lines is two newlines.
    expect(normalize("a\n\n\n\n\nb")).toBe("a\n\nb");
    // AND LEAVES TWO ALONE. "More than two" is the rule; collapsing exactly
    // two would be a fifth operation wearing the fourth's name.
    expect(normalize("a\n\nb")).toBe("a\n\nb");
    expect(normalize("a\nb")).toBe("a\nb");
  });

  it("Scenario 5 — PRESERVES markdown verbatim", () => {
    // The most damaging plausible simplification in this file. List position
    // and heading context feed prominence, position class and answer form; a
    // stripped string loses all of it invisibly.
    const markdown = [
      "## Best CRMs",
      "",
      "1. **HubSpot** — _intuitive_ pipelines",
      "2. [Salesforce](https://salesforce.com) — deeper reporting",
      "",
      "| Tool | Seats |",
      "| --- | --- |",
      "| HubSpot | 50 |",
      "",
      "> Some teams prefer Pipedrive.",
      "",
      "```json",
      '{ "a": 1 }',
      "```",
    ].join("\n");

    expect(normalize(markdown)).toBe(markdown);
  });

  it("does not trim, and does not touch whitespace inside a line", () => {
    // Every "harmless" extra cleanup shifts offsets. These are the three most
    // tempting ones, asserted as NON-operations.
    expect(normalize("  leading and trailing  ")).toBe("  leading and trailing  ");
    expect(normalize("two  spaces   inside")).toBe("two  spaces   inside");
    expect(normalize("\n\nleading blank lines")).toBe("\n\nleading blank lines");
  });

  it("does not normalise quotes, dashes or case", () => {
    expect(normalize("“smart” quotes — and an em dash")).toBe("“smart” quotes — and an em dash");
    expect(normalize("HubSpot")).toBe("HubSpot");
  });

  it("Scenario 6 — is deterministic, and idempotent", () => {
    const messy = `x\r\n\r\n\r\n\r\ncafé${ZWSP}`;
    expect(normalize(messy)).toBe(normalize(messy));
    // Idempotent as well as deterministic: re-normalising a normalised string
    // must be a no-op, or a double pass would shift offsets a single pass did
    // not.
    expect(normalize(normalize(messy))).toBe(normalize(messy));
  });

  it("leaves an empty string alone", () => {
    expect(normalize("")).toBe("");
  });
});

describe("STORY-035 · versioning", () => {
  it("stamps §6's documented identifier", () => {
    expect(NORMALIZER_VERSION).toBe("n1");
  });

  it("Scenario 7 — a differing version forces a re-parse", () => {
    expect(requiresReparse("n0")).toBe(true);
    expect(requiresReparse(NORMALIZER_VERSION)).toBe(false);
  });

  it("treats an ABSENT version as a mismatch", () => {
    // A row that makes no claim about which normalisation produced its
    // offsets must not be read as claiming the current one.
    expect(requiresReparse(null)).toBe(true);
    expect(requiresReparse(undefined)).toBe(true);
    expect(requiresReparse("")).toBe(true);
  });
});

describe("STORY-035 · span validation", () => {
  const text = "HubSpot CRM";

  it("accepts a span inside the string, including the empty one at the end", () => {
    expect(assertValidSpan({ start: 0, end: 7 }, text)).toEqual({ start: 0, end: 7 });
    // Half-open: end === length is the position AFTER the last character, and
    // is valid. `slice(11, 11)` is "".
    expect(assertValidSpan({ start: 11, end: 11 }, text)).toEqual({ start: 11, end: 11 });
  });

  it("Scenario 8 — rejects an offset past the end rather than clamping it", () => {
    // Clamping produces a highlight in slightly the wrong place, months
    // later, with nothing in any log.
    expect(() => assertValidSpan({ start: 0, end: 12 }, text)).toThrow(InvalidSpanError);
  });

  it("Scenario 9 — rejects an end before its start", () => {
    expect(() => assertValidSpan({ start: 7, end: 3 }, text)).toThrow(InvalidSpanError);
  });

  it("rejects a negative start and a non-integer offset", () => {
    expect(() => assertValidSpan({ start: -1, end: 3 }, text)).toThrow(InvalidSpanError);
    expect(() => assertValidSpan({ start: 0, end: 3.5 }, text)).toThrow(InvalidSpanError);
    expect(() => assertValidSpan({ start: Number.NaN, end: 3 }, text)).toThrow(InvalidSpanError);
  });

  it("names the caller in the message, so a matcher bug says which matcher", () => {
    expect(() => assertValidSpan({ start: 0, end: 99 }, text, "entity-matcher")).toThrow(/entity-matcher/);
  });

  it("a span taken from normalised text still indexes it after re-normalisation", () => {
    // The contract in one assertion: an offset is defined against the
    // NORMALISED string, and normalisation is idempotent, so the slice
    // survives a second pass.
    const normalised = normalize("Try **HubSpot**\r\n\r\n\r\n\r\nor Salesforce.");
    const span = { start: normalised.indexOf("HubSpot"), end: normalised.indexOf("HubSpot") + 7 };

    assertValidSpan(span, normalised);
    expect(normalised.slice(span.start, span.end)).toBe("HubSpot");
    expect(normalize(normalised).slice(span.start, span.end)).toBe("HubSpot");
  });
});
