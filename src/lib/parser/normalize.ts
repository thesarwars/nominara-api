// STORY-035 — the one normalisation every character offset in the product is
// computed against.
//
// `tracking-engine.md` Stage 1, in full: "CRLF→LF, Unicode NFC, strip
// zero-width characters, collapse more than two consecutive blank lines.
// **Nothing else.** Offsets in `highlight_map` are computed against this
// normalized string, and the normalization is versioned so a change forces a
// re-parse rather than silently shifting spans."
//
// FOUR OPERATIONS, NOT FIVE. STORY-035's AC1 says "exactly five operations"
// and then enumerates four — the same four the reference enumerates. The
// count is a slip in the story; the enumeration is what both documents agree
// on, and spec-navigation puts the reference above prose about it. Recorded
// as a specification defect rather than a fifth operation invented to make
// the number true.
//
// THE FOUR-OPERATION LIMIT IS THE WHOLE POINT OF THIS FILE. Every additional
// "harmless" cleanup — trimming, quote normalisation, collapsing whitespace
// inside a line — shifts offsets, and every shift silently moves every
// highlight in every stored capture. A stored span is a promise about a
// string that no longer exists.
//
// AND MARKDOWN IS PRESERVED, NEVER STRIPPED. Structure is signal: a brand at
// position one of a numbered list is a different observation from the same
// brand in a closing caveat. List position and heading context feed
// prominence, position class and answer form, and a stripped string loses all
// of it in a way that is invisible in the text.

/**
 * The version stamped on every capture, from `api-specification.md` §6's
 * worked example — the only place a value for this field is written down.
 *
 * BUMP THIS FOR ANY CHANGE TO `normalize`, including one that looks
 * cosmetic. The version is not a description of the function; it is the
 * thing that makes stored offsets safe to trust, and a change without a bump
 * turns every highlight in the database into a silent lie.
 */
export const NORMALIZER_VERSION = "n1";

/**
 * U+200B–U+200D and U+FEFF — zero-width space, non-joiner, joiner, BOM.
 *
 * Written as ESCAPES, not as the characters themselves. A literal zero-width
 * character in source is invisible in a diff and in a review, which is the
 * one property you least want in the pattern that decides what gets deleted
 * from every stored answer.
 */
// AN ALTERNATION, NOT A CHARACTER CLASS. `no-misleading-character-class` is
// right to refuse the class form: U+200D is the zero-width JOINER, and inside
// a class it reads as though it could join with its neighbours, which makes
// the set ambiguous to anyone auditing what gets deleted. Four alternatives
// are four alternatives.
const ZERO_WIDTH = /\u200B|\u200C|\u200D|\uFEFF/gu;

/** Three or more newlines, i.e. more than two consecutive blank lines. */
const EXCESS_BLANK_LINES = /\n{3,}/gu;

/**
 * The four operations, in order, and nothing else.
 *
 * PURE AND DETERMINISTIC: no configuration, no locale, no clock. The same
 * input produces the same output in every process, which is what lets an
 * offset computed in a worker be trusted by a browser months later.
 *
 * The order matters in one place: zero-width characters are stripped AFTER
 * NFC composition, because composition can itself produce or consume
 * combining characters, and stripping first would leave the result dependent
 * on which form the engine happened to send.
 */
export function normalize(text: string): string {
  return text
    // 1. CRLF→LF. Lone CR too: a classic-Mac line ending is still a line
    //    ending, and leaving it would make its offset depend on the engine.
    .replace(/\r\n?/gu, "\n")
    // 2. Unicode NFC.
    .normalize("NFC")
    // 3. Zero-width characters.
    .replace(ZERO_WIDTH, "")
    // 4. More than two consecutive blank lines collapse to two.
    .replace(EXCESS_BLANK_LINES, "\n\n");
}

/**
 * A half-open character range `[start, end)` into a normalised string.
 *
 * Half-open because that is what `String.prototype.slice` takes and what
 * every offset in `mention_facts` (`char_start`, `char_end`) is written as;
 * a closed range would differ from both by one at exactly the boundary
 * nobody tests.
 */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export class InvalidSpanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSpanError";
  }
}

/**
 * Reject an impossible span loudly rather than clamping it.
 *
 * A clamped span renders as a highlight in slightly the wrong place, months
 * later, with nothing in any log — and it looks like a matcher that is
 * "mostly right" instead of one that is broken. Throwing means a matcher bug
 * surfaces in its own first test.
 *
 * Returns the span so a caller can validate inline at the point of use.
 */
export function assertValidSpan(span: Span, text: string, context = "span"): Span {
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) {
    throw new InvalidSpanError(`${context}: offsets must be integers, got [${span.start}, ${span.end})`);
  }
  if (span.start < 0) {
    throw new InvalidSpanError(`${context}: start ${span.start} is negative`);
  }
  if (span.end < span.start) {
    throw new InvalidSpanError(`${context}: end ${span.end} precedes start ${span.start}`);
  }
  if (span.end > text.length) {
    throw new InvalidSpanError(`${context}: end ${span.end} is past the end of a ${text.length}-character string`);
  }
  return span;
}

/**
 * Whether a stored capture's offsets can be trusted against today's normaliser.
 *
 * A MISMATCH FORCES A RE-PARSE, and never a reinterpretation. That is the
 * difference between an accuracy improvement and a data corruption:
 * reinterpreting old offsets against a new normalisation produces highlights
 * that land in the wrong place, with no error anywhere and nothing to
 * distinguish them from correct ones.
 *
 * An ABSENT version counts as a mismatch. A row written before this file
 * existed — or by anything that did not stamp the column — makes no claim
 * about which normalisation produced its offsets, and "no claim" must not
 * read as "the current one".
 */
export function requiresReparse(storedVersion: string | null | undefined): boolean {
  return storedVersion !== NORMALIZER_VERSION;
}
