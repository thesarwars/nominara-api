import type { CompetitorFinderEntity } from "../../../contracts/tools/index.js";
import { hostOf, REDIRECT_WRAPPER_HOSTS } from "../visibility-scan/scan-result.js";
import { DetectedSpan, digestOf } from "./detect-entities.js";

// STORY-081 - the response builder. A row is CONSTRUCTED FROM A DETECTED SPAN: the name is read out of the answer at the span's offsets, never supplied. The
// parameters below take spans and the answer they were detected in - there is no parameter that carries a name, so a name the capture did not produce
// cannot be represented, and a future call site cannot skip a check that is not a check at all.

const EXCERPT_CHARS = 280;
const LINK_URL = /\[[^\]\n]*\]\(([^)\s]+)\)/gu;

export interface AnswerCitation {
  readonly url: string;
  readonly title?: string | undefined;
  readonly slot: number;
}

export interface BuildRowsInput {
  /** The normalised answer the spans were detected in. */
  readonly text: string;
  readonly spans: readonly DetectedSpan[];
  readonly citations: readonly AnswerCitation[];
}

const stem = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** The registrable-ish label of a host: `www.ledgerlark.example` -> `ledgerlark`. */
function hostStem(host: string): string {
  const labels = host.split(".");
  return stem(labels.length >= 2 ? labels[labels.length - 2]! : host);
}

function lineBounds(text: string, at: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const nl = text.indexOf("\n", at);
  return { start, end: nl === -1 ? text.length : nl };
}

function excerptOf(text: string, line: { start: number; end: number }, spanStart: number): string {
  const full = text.slice(line.start, line.end).trim();
  if (full.length <= EXCERPT_CHARS) return full;
  const from = Math.max(line.start, spanStart - Math.floor(EXCERPT_CHARS / 2));
  return text.slice(from, Math.min(line.end, from + EXCERPT_CHARS)).trim();
}

/** The domain the ANSWER cited for this entity: a link on the entity's own line, else a citation whose host or title is the entity. Otherwise null - never a guess. */
function citedDomain(text: string, line: { start: number; end: number }, name: string, citations: readonly AnswerCitation[]): string | null {
  const wanted = stem(name);
  const lineText = text.slice(line.start, line.end);
  const linked = [...lineText.matchAll(LINK_URL)].map((m) => hostOf(m[1]!)).filter((h) => h !== "");
  const own = linked.find((h) => hostStem(h) === wanted);
  if (own !== undefined) return own;
  for (const c of citations) {
    const host = hostOf(c.url);
    if (host === "" || REDIRECT_WRAPPER_HOSTS.has(host)) continue;
    if (hostStem(host) === wanted) return host;
  }
  // A link on the entity's line whose host is not the entity's own (a review site, say) is still what the answer cited for that line.
  return linked.length === 1 ? linked[0]! : null;
}

export function buildEntityRows(input: BuildRowsInput): CompetitorFinderEntity[] {
  const digest = digestOf(input.text);
  return input.spans.map((span) => {
    if (!(span instanceof DetectedSpan)) throw new Error("an entity row can only be built from a DetectedSpan");
    if (span.sourceDigest !== digest) throw new Error("this span was detected in a different text");
    if (span.start < 0 || span.end > input.text.length || span.end <= span.start) throw new Error("a span outside its text");
    const name = input.text.slice(span.start, span.end);
    const line = lineBounds(input.text, span.start);
    return {
      name,
      span: { char_start: span.start, char_end: span.end },
      excerpt: excerptOf(input.text, line, span.start),
      cited_domain: citedDomain(input.text, line, name, input.citations),
    };
  });
}
