// STORY-038 step 1 — the evidence span.
//
// `tracking-engine.md` Stage 4: "extract the evidence span: the enclosing
// sentence, extended to the enclosing clause pair when a contrastive
// conjunction ('however', 'but', 'although', 'while', 'though') links across
// the mention. Hard cap 400 characters."
//
// AC3 IS THE REASON THIS FILE IS SEPARATE AND TESTED ON ITS OWN: "The
// evidence span is stored on every mention. THERE IS NO SENTIMENT VERDICT
// WITHOUT THE SENTENCE THAT CAUSED IT." The story says why — "'this mention
// is negative' is an assertion; 'this mention is negative because of this
// sentence' is evidence, and it is also what makes the driver analysis
// possible." The span is also the ONLY thing the arbiter is ever shown, so
// its bound is an injection control as much as a cost one.

import { assertValidSpan, type Span } from "../normalize.js";

/** §4's list, verbatim. A pivot away from the mention changes what the sentence means about it. */
export const CONTRASTIVE_CONJUNCTIONS: readonly string[] = ["however", "but", "although", "while", "though"];

/** "Hard cap 400 characters", from the reference. */
export const EVIDENCE_CAP = 400;

/**
 * Sentence terminators, with the two cases that make a naive split wrong.
 *
 * A period inside "e.g." or "v2.1" is not a sentence end, and splitting on
 * every `.` would cut an evidence span mid-clause and lose the cue that
 * decided the verdict. Requiring whitespace-then-capital after the terminator
 * is the cheap version of that rule and handles both.
 */
const SENTENCE_END = /[.!?]["'”’)\]]*\s+(?=[A-Z"'“‘([]|$)/gu;

/** Sentence boundaries as offsets into `text`, half-open. */
function sentences(text: string): Span[] {
  const bounds: Span[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    if (match.index === undefined) continue;
    const end = match.index + match[0].length;
    bounds.push({ start, end });
    start = end;
  }
  if (start < text.length) bounds.push({ start, end: text.length });
  return bounds.length > 0 ? bounds : [{ start: 0, end: text.length }];
}

export interface EvidenceWindow {
  readonly span: Span;
  readonly text: string;
  /** Whether the window was widened across a contrastive conjunction. */
  readonly extended: boolean;
  /** Whether the hard cap trimmed it. */
  readonly capped: boolean;
}

/**
 * The evidence for one mention.
 *
 * EXTENDED ACROSS A CONTRASTIVE PIVOT, and only across one. "HubSpot is easy
 * to use. However, it struggles at scale." carries its verdict in the second
 * sentence and the mention is in the first; a window stopping at the sentence
 * boundary would read an endorsement where the answer said the opposite.
 * Extending across EVERY sentence would eventually swallow the whole answer
 * and make the verdict untraceable, which is what the cap is for.
 *
 * THE CAP TRIMS AROUND THE MENTION, not from the start. A 900-character
 * sentence truncated at 400 from its beginning can cut the mention itself out
 * of its own evidence — the one thing the span must always contain.
 */
export function evidenceWindow(text: string, mention: Span): EvidenceWindow {
  assertValidSpan(mention, text, "evidence-window");

  const bounds = sentences(text);
  const index = bounds.findIndex((sentence) => mention.start >= sentence.start && mention.start < sentence.end);
  const home = bounds[index === -1 ? bounds.length - 1 : index]!;

  let span = { ...home };
  let extended = false;

  // Look one sentence either way. The pivot can precede the mention ("Most
  // teams like it. However, HubSpot struggles at scale.") or follow it, and
  // both put the verdict outside the mention's own sentence.
  const next = bounds[bounds.indexOf(home) + 1];
  const previous = bounds[bounds.indexOf(home) - 1];
  if (next !== undefined && startsWithContrastive(text.slice(next.start, next.end))) {
    span = { start: span.start, end: next.end };
    extended = true;
  } else if (previous !== undefined && startsWithContrastive(text.slice(home.start, home.end))) {
    span = { start: previous.start, end: span.end };
    extended = true;
  }

  const capped = span.end - span.start > EVIDENCE_CAP;
  if (capped) span = trimAround(span, mention);

  return { span, text: text.slice(span.start, span.end), extended, capped };
}

function startsWithContrastive(sentence: string): boolean {
  const first = sentence.trimStart().toLowerCase();
  return CONTRASTIVE_CONJUNCTIONS.some((word) => first.startsWith(`${word} `) || first.startsWith(`${word},`));
}

/**
 * Keep the mention centred, and never cut it out.
 *
 * A mention longer than the cap keeps its own span and nothing else — the
 * evidence is then exactly the entity, which is honest about there being no
 * room for context rather than showing a fragment of a name.
 */
function trimAround(span: Span, mention: Span): Span {
  const mentionLength = mention.end - mention.start;
  if (mentionLength >= EVIDENCE_CAP) return { start: mention.start, end: mention.end };

  const slack = EVIDENCE_CAP - mentionLength;
  const before = Math.floor(slack / 2);
  const start = Math.max(span.start, mention.start - before);
  const end = Math.min(span.end, start + EVIDENCE_CAP);
  // Re-anchored: clamping the end can leave room at the front that the first
  // pass did not use, and a window shorter than the cap for no reason loses
  // context the verdict may depend on.
  return { start: Math.max(span.start, end - EVIDENCE_CAP), end };
}
