// STORY-058 AC3 - the passage a citation's text directive quotes.
//
// `citation_facts.text_fragment` holds what follows `#:~:text=` : `[prefix-,]start[,end][,-suffix]`, percent-encoded, possibly with
// further `&text=` directives. The prefix and suffix are only context for the browser to find the quote; the quote is `start` (to
// `end`). The text BETWEEN start and end is not in the directive, so a start,end pair is joined as the two quoted ends and never
// padded with invented text.
// CHOSEN APPROXIMATION (recorded in the story): the joined ends are not a substring of the page; only the most recent directive of a page,
// and its first `&text=`, is kept (candidates.ts).

import { sanitiseText } from "../../aux/sanitise.js";

const MAX_PASSAGE_CHARS = 4000;

export function passageFromTextFragment(fragment: string): string | null {
  const first = fragment.split("&")[0] ?? "";
  const parts = first.split(",");
  if (parts.length > 1 && parts[0]!.endsWith("-")) parts.shift();
  if (parts.length > 1 && parts[parts.length - 1]!.startsWith("-")) parts.pop();
  const decoded: string[] = [];
  for (const part of parts.slice(0, 2)) {
    let text: string;
    try {
      text = decodeURIComponent(part);
    } catch {
      return null;
    }
    // A NUL would fail the Postgres insert and abort the build's whole write transaction (the readable path sanitises the same way).
    text = sanitiseText(text).replace(/\s+/g, " ").trim();
    if (text !== "") decoded.push(text);
  }
  // A lone "-" left by a directive that was only context carries no quote.
  const passage = decoded.join(" ").trim();
  if (passage === "" || /^-+$/.test(passage)) return null;
  return passage.length > MAX_PASSAGE_CHARS ? passage.slice(0, MAX_PASSAGE_CHARS) : passage;
}
