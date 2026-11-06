import { createHash } from "node:crypto";

// STORY-081 - the open-vocabulary entity detector. It reads an engine's answer and returns the SPANS where the answer itself presents a named entity.
//
// A name that is not spanned here does not exist for the rest of the tool. That is the guarantee: `DetectedSpan` can only be constructed in this file
// (its constructor is private and token-guarded, and the factory is a module-local closure, not a member), and `buildEntityRows` (build-rows.ts) accepts
// nothing else - there is no input that takes a bare name. A well-known competitor the model mentions in running prose is NOT spanned, so it cannot be
// returned, however plausible it is (FR-TL-02: "A name the capture did not produce cannot be returned").
//
// WHAT COUNTS AS THE ANSWER PRESENTING AN ENTITY - structure, not vocabulary. Three shapes, in an answer that is already normalised (every offset indexes it):
//   a bold phrase           **Name**
//   a link's text           [Name](https://...)
//   a list item's lead      "1. Name - ..." / "- Name: ..."
// Anything in running prose is deliberately not detected: this detector prefers a missed name to an invented one, and the scope line says so.

const CONSTRUCT = Symbol("nominara.competitor-finder.detected-span");
let make: (start: number, end: number, sourceDigest: string) => DetectedSpan;

/** A character range of a source text where the answer presents an entity. Constructible only by `detectEntitySpans`. */
export class DetectedSpan {
  readonly start: number;
  readonly end: number;
  /** A digest of the text this span was detected in: a span cannot build a row from any other text. */
  readonly sourceDigest: string;

  private constructor(token: symbol, start: number, end: number, sourceDigest: string) {
    if (token !== CONSTRUCT) throw new Error("a DetectedSpan can only be produced by detectEntitySpans");
    this.start = start;
    this.end = end;
    this.sourceDigest = sourceDigest;
  }

  static {
    make = (start, end, sourceDigest) => new DetectedSpan(CONSTRUCT, start, end, sourceDigest);
  }
}

export const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface DetectOptions {
  /** Names that are not competitors (the page's own brand), compared case-insensitively. */
  readonly excludeNames: readonly string[];
}

const MAX_WORDS = 5;
const MAX_CHARS = 60;
/** Headings and labels that structure an answer without naming anything. */
const LABELS: ReadonlySet<string> = new Set([
  "note", "notes", "summary", "conclusion", "overview", "pros", "cons", "key features", "features", "pricing", "best for", "sources", "source",
  "top picks", "recommendation", "recommendations", "key takeaways", "takeaway", "tip", "tips", "why", "how", "what", "disclaimer", "caveat", "bottom line",
]);

interface Raw {
  readonly start: number;
  readonly end: number;
}

const BOLD = /(\*\*|__)(?=\S)([^*_\n]{1,80}?)(?<=\S)\1/gu;
const LINK = /\[([^\]\n]{1,80})\]\((?:[^)\s]+)\)/gu;
const LIST_LEAD = /^[ \t]*(?:\d{1,3}[.)]|[-*•])[ \t]+(?!\*\*|__|\[)([^\n]*)$/gmu;
const LEAD_STOP = /[:–—(,]|\s-\s/u;

function trimmed(text: string, start: number, end: number): Raw | null {
  let s = start;
  let e = end;
  while (s < e && /[\s"'“”‘’*_`]/u.test(text[s]!)) s += 1;
  while (e > s && /[\s"'“”‘’*_`.,;:!?]/u.test(text[e - 1]!)) e -= 1;
  return e > s ? { start: s, end: e } : null;
}

function plausible(name: string): boolean {
  if (name.length === 0 || name.length > MAX_CHARS) return false;
  if (!/^[\p{Lu}\d]/u.test(name)) return false;
  if (name.split(/\s+/u).length > MAX_WORDS) return false;
  if (/https?:\/\//u.test(name)) return false;
  if (/[.!?]\s/u.test(name)) return false;
  return !LABELS.has(name.toLowerCase());
}

/** The spans where the answer presents a named entity, in document order, one per distinct name (the first). */
export function detectEntitySpans(text: string, options: DetectOptions): DetectedSpan[] {
  const raws: Raw[] = [];
  for (const m of text.matchAll(BOLD)) {
    const start = m.index + m[1]!.length;
    const t = trimmed(text, start, start + m[2]!.length);
    if (t !== null) raws.push(t);
  }
  for (const m of text.matchAll(LINK)) {
    const start = m.index + 1;
    const t = trimmed(text, start, start + m[1]!.length);
    if (t !== null) raws.push(t);
  }
  for (const m of text.matchAll(LIST_LEAD)) {
    const lead = m[1]!;
    const base = m.index + m[0].length - lead.length;
    const stop = LEAD_STOP.exec(lead);
    const t = trimmed(text, base, base + (stop === null ? lead.length : stop.index));
    if (t !== null) raws.push(t);
  }
  const digest = digestOf(text);
  const excluded = new Set(options.excludeNames.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const out: DetectedSpan[] = [];
  for (const raw of [...raws].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const name = text.slice(raw.start, raw.end);
    const key = name.toLowerCase();
    if (!plausible(name) || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(make(raw.start, raw.end, digest));
  }
  return out;
}
