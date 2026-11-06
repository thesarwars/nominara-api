// STORY-111 / NFR-CMP-01 - the minimisation pass.
//
// Contact identifiers in response text (emails, phone numbers, street addresses) become typed placeholders in the fields that SURFACE
// in the interface and in exports: `answer_captures.response_excerpt`, the shared-cache excerpt, and the sentiment evidence text. It
// runs on the way IN (before persistence) for the excerpt, because redaction on the way out leaves the data in storage, in backups and
// in every export path written afterwards.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - Personal names are PRESERVED. They are very often brand or product names ("Michael Kors", "Ben & Jerry's"); stripping them would
//     destroy the measurement. They are never indexed, searched or profiled (minimise.spec.ts + names-not-indexed.spec.ts).
//   - It does not touch the retained raw object or the dual-written `payload`, which keep the verbatim text for audit fidelity under
//     shorter retention and a stricter access path (raw-object.ts).
//
// Pure: no I/O, no clock, no state. Idempotent: placeholders contain no digit, @ or street word, so a second pass changes nothing.

export const PLACEHOLDERS = Object.freeze({ email: "[email]", phone: "[phone]", street_address: "[address]" });
export type PlaceholderKind = keyof typeof PLACEHOLDERS;
export type ReplacementCounts = Record<PlaceholderKind, number>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// A street address: a house number (optionally with a letter), up to four capitalised name words, and a street-type word.
const STREET_TYPE = "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Square|Sq)";
const STREET = new RegExp(`\\b\\d{1,5}[A-Za-z]?\\s+(?:[A-Z][A-Za-z.'-]*\\s+){0,3}${STREET_TYPE}\\b`, "g");

// A phone number: a run of digits and separators that has a leading + or at least one separator/parenthesis (so a bare 10-digit count
// is NOT a phone) and 9 to 15 digits in total (so a date, 8 digits, is not one either).
const PHONE_CANDIDATE = /(?<![\w.])(?:\+\d|\(\d)[\d\s().-]{6,}\d|(?<![\w.-])\d{2,4}[\s.-]\d{2,4}(?:[\s.-]\d{2,4}){1,3}(?![\w-])/g;

function digitCount(s: string): number {
  return s.replace(/\D/g, "").length;
}

export interface MinimisedText {
  readonly text: string;
  readonly replaced: ReplacementCounts;
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: PlaceholderKind;
}

/** Every identifier in `text`, non-overlapping, leftmost first; at equal starts email beats address beats phone. */
function findSpans(text: string): Span[] {
  const found: Span[] = [];
  for (const m of text.matchAll(EMAIL)) found.push({ start: m.index, end: m.index + m[0].length, kind: "email" });
  for (const m of text.matchAll(STREET)) found.push({ start: m.index, end: m.index + m[0].length, kind: "street_address" });
  for (const m of text.matchAll(PHONE_CANDIDATE)) {
    const digits = digitCount(m[0]);
    // ISO dates (2024-01-15) and version-like runs have too few digits; a long run with separators is a phone.
    if (digits < 9 || digits > 15 || /^\d{4}-\d{2}-\d{2}$/.test(m[0].trim())) continue;
    found.push({ start: m.index, end: m.index + m[0].length, kind: "phone" });
  }
  const order: Record<PlaceholderKind, number> = { email: 0, street_address: 1, phone: 2 };
  found.sort((a, b) => a.start - b.start || order[a.kind] - order[b.kind]);
  const out: Span[] = [];
  let cursor = 0;
  for (const span of found) {
    if (span.start < cursor) continue;
    out.push(span);
    cursor = span.end;
  }
  return out;
}

export function minimiseText(input: string): MinimisedText {
  const replaced: ReplacementCounts = { email: 0, phone: 0, street_address: 0 };
  let text = "";
  let cursor = 0;
  for (const span of findSpans(input)) {
    text += input.slice(cursor, span.start) + PLACEHOLDERS[span.kind];
    replaced[span.kind] += 1;
    cursor = span.end;
  }
  return { text: text + input.slice(cursor), replaced };
}

/** The persisted excerpt: minimise the WHOLE text first, then cut, so a cut can never leave half an identifier behind. */
export function minimiseExcerpt(text: string, maxChars: number): string {
  return minimiseText(text).text.slice(0, maxChars);
}

/**
 * `text.slice(start, end)` with identifiers replaced, found in the FULL text so an identifier the window cuts through is still replaced
 * (a window that ends mid-address must not surface its first half). The sentiment evidence text is built this way.
 */
export function minimiseWindow(text: string, start: number, end: number): string {
  let out = "";
  let cursor = start;
  for (const span of findSpans(text)) {
    if (span.end <= start || span.start >= end) continue;
    out += text.slice(cursor, Math.max(cursor, span.start)) + PLACEHOLDERS[span.kind];
    cursor = Math.min(end, span.end);
  }
  return out + text.slice(cursor, end);
}
