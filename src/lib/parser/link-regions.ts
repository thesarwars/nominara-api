// STORY-036 — the regions a match inside is a citation rather than a mention.
//
// `tracking-engine.md` Stage 2: "A match inside a URL, a code span, or a
// markdown link target is recorded with `in_link=true` and **excluded from
// prominence** — a brand appearing only inside a citation URL is a citation,
// not a mention."
//
// RECORDED, NOT DROPPED, and the difference is a product decision the story
// spells out: "the interface shows it in the citation panel, and the task
// generator treats it as a content gap — 'you are being linked but not
// described' — which is a genuinely useful finding." Dropping the match would
// throw that away; counting it toward prominence would inflate presence for a
// brand nobody actually discussed.
//
// THIS IS WHY THE NORMALISER PRESERVES MARKDOWN. Every region below is found
// by reading markdown structure. Against a stripped string none of them
// exists, and every brand inside every citation URL would count as a mention.

export interface Region {
  readonly start: number;
  readonly end: number;
}

/**
 * The scanners, in the order they are applied.
 *
 * FENCED CODE FIRST, because a fence can contain anything — including text
 * that looks like a link — and everything inside it is already excluded. A
 * link scanner run first would find "links" inside a code sample and report
 * regions that overlap the fence for no benefit.
 *
 * `g` and `u` on every pattern; each is used with `matchAll`, which requires
 * the global flag and would otherwise loop forever.
 */
const SCANNERS: readonly RegExp[] = [
  // Fenced code blocks. Non-greedy, and tolerant of an unterminated fence at
  // the end of a truncated answer — engines do return those.
  /```[\s\S]*?(?:```|$)/gu,
  // Inline code. Single backtick pairs only; a doubled backtick span is rare
  // enough in engine output that supporting it would be speculative.
  /`[^`\n]*`/gu,
  // A markdown link's TARGET, not its text. `[HubSpot](https://hubspot.com)`
  // mentions HubSpot in the text — that is a real mention — and only the
  // parenthesised target is a link region.
  /\]\(([^)\s]*)/gu,
  // Bare URLs. Terminated by whitespace or a closing bracket, and trailing
  // sentence punctuation is trimmed by the pattern rather than swallowed:
  // "see https://hubspot.com." should not put the full stop in the URL.
  /\bhttps?:\/\/[^\s)<>\]]*[^\s)<>\].,;:!?]/gu,
];

/**
 * Every region of `text` in which a match is a citation rather than a mention.
 *
 * Merged and sorted, so a lookup is a scan rather than a search through
 * overlapping intervals — the regions from different scanners routinely
 * overlap (a bare URL inside a code fence hits two).
 */
export function linkRegions(text: string): Region[] {
  const found: Region[] = [];
  for (const scanner of SCANNERS) {
    for (const match of text.matchAll(scanner)) {
      const start = match.index;
      if (start === undefined) continue;
      found.push({ start, end: start + match[0].length });
    }
  }
  return merge(found);
}

function merge(regions: Region[]): Region[] {
  if (regions.length === 0) return [];
  const sorted = [...regions].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Region[] = [sorted[0]!];
  for (const region of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (region.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, region.end) };
    } else {
      merged.push(region);
    }
  }
  return merged;
}

/**
 * Whether a span lies inside any region.
 *
 * OVERLAP, NOT CONTAINMENT. A match that merely starts inside a URL and runs
 * past its end is still a match against a URL's characters, and treating it
 * as a plain mention would let a crafted answer smuggle presence past the
 * exclusion by ending an alias one character beyond a link.
 */
export function overlapsRegion(regions: readonly Region[], span: { start: number; end: number }): boolean {
  return regions.some((region) => span.start < region.end && span.end > region.start);
}
