// STORY-036 — case and diacritic folding that can be undone.
//
// `tracking-engine.md` Stage 2: "Case and diacritic folding, WITH THE
// ORIGINAL SPAN PRESERVED FOR RENDERING."
//
// That clause is the whole difficulty. Folding is not length-preserving:
// NFD decomposition turns "é" into "e" + U+0301 and stripping the combining
// mark then removes a character, so an offset into the folded string is not
// an offset into the original. A matcher that folded and reported folded
// offsets would highlight the wrong characters in every answer containing an
// accent, and would do it silently — the text still looks like text.
//
// So folding carries an index back. `foldedToOriginal[i]` is the offset in
// the ORIGINAL string that folded character `i` came from, and the array has
// one extra entry at the end so a half-open end offset maps too.

import { assertValidSpan, type Span } from "./normalize.js";

export interface FoldedText {
  /** Lower-cased, diacritic-stripped. Matching runs against this. */
  readonly folded: string;
  /** The string it was folded FROM. Every reported span indexes this. */
  readonly original: string;
  /** `foldedToOriginal[i]` — where folded character `i` began in `original`. */
  readonly foldedToOriginal: readonly number[];
}

/** Combining marks, which is what NFD separates a diacritic into. */
const COMBINING = /\p{M}/u;

/**
 * Fold for matching, keeping a way back to the original offsets.
 *
 * PER CHARACTER, NOT PER STRING. `text.normalize("NFD").toLowerCase()` is one
 * line and loses the correspondence completely: there is no way to ask which
 * original character a given folded character came from once both
 * transformations have been applied wholesale. Doing it a character at a time
 * costs a loop and buys an exact inverse.
 *
 * `toLowerCase` CAN LENGTHEN a character — "ß" lowercases to itself but
 * uppercase "İ" (U+0130) lowercases to two code units — so each folded
 * character produced by one original character maps back to that same
 * original offset. A span landing inside such an expansion still starts and
 * ends at real original offsets.
 */
export function fold(text: string): FoldedText {
  let folded = "";
  const foldedToOriginal: number[] = [];

  // Iterated by CODE POINT, not by code unit: a surrogate pair is one
  // character, and splitting it would fold half an emoji.
  let originalIndex = 0;
  for (const character of text) {
    const decomposed = character.normalize("NFD");
    let stripped = "";
    for (const part of decomposed) {
      if (!COMBINING.test(part)) stripped += part;
    }
    // A character that is ONLY a combining mark folds to nothing. It still
    // occupies space in the original, and the next folded character maps past
    // it, which is exactly right.
    const lowered = stripped.toLowerCase();
    for (const unit of lowered) {
      folded += unit;
      for (let i = 0; i < unit.length; i += 1) foldedToOriginal.push(originalIndex);
    }
    originalIndex += character.length;
  }

  // The extra entry: a half-open end offset of `folded.length` maps to
  // `text.length`. Without it every match that reaches the end of the string
  // would report an end offset one character short.
  foldedToOriginal.push(text.length);

  return { folded, original: text, foldedToOriginal };
}

/**
 * Map a span in the folded string back to the original.
 *
 * Validated on the way out. An offset that does not index the original is a
 * matcher bug, and `assertValidSpan` exists so it surfaces here rather than
 * as a highlight that lands two characters left months later.
 */
export function toOriginalSpan(text: FoldedText, foldedSpan: Span, context = "fold"): Span {
  const start = text.foldedToOriginal[foldedSpan.start];
  const end = text.foldedToOriginal[foldedSpan.end];
  if (start === undefined || end === undefined) {
    throw new Error(`${context}: folded span [${foldedSpan.start}, ${foldedSpan.end}) is outside the folded string`);
  }
  return assertValidSpan({ start, end }, text.original, context);
}
