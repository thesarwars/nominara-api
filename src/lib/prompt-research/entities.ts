// STORY-080 - what an engine's answer NAMES, with no brand list to look for (FR-TL-01: "every detected entity").
//
// DETERMINISTIC AND STRUCTURAL. Nothing here asks a model. An engine that recommends products names them in the places an answer puts a name: a bolded span, the head
// of a list item ("1. Chargebee: ..." / "- [Recurly](...) ..."). A name that appears only inside a running sentence is NOT detected - that is a stated limit of this
// reading (the result is labelled an estimate), chosen over guessing at proper nouns in prose, where every sentence-initial word would become an "entity".
//
// BUILDER'S READING, owner to confirm: the product documents neither an extraction method nor a classification pass for this tool (Competitor Finder has one; this does not).

const MAX_WORDS = 5;
const MAX_CHARS = 60;

/** Labels an answer bolds or lists that are headings, not names. Lowercased, without a trailing colon. */
const NOT_ENTITIES: ReadonlySet<string> = new Set([
  "pros", "cons", "summary", "note", "notes", "pricing", "price", "prices", "features", "feature", "key features", "best for", "overview", "conclusion", "tip", "tips",
  "verdict", "sources", "source", "references", "bottom line", "recommendation", "recommendations", "comparison", "alternatives", "example", "examples", "why", "how", "what",
  "benefits", "drawbacks", "use case", "use cases", "considerations", "final thoughts", "top picks", "quick answer", "disclaimer", "context", "limitations", "caveats", "pricing and plans",
  "key takeaways", "takeaways", "next steps", "options", "criteria", "factors", "important", "warning", "yes", "no",
]);

const BOLD = /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/gu;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+(.*)$/u;
const LEADING_LINK = /^\[([^\]\n]+)\]\([^)\n]*\)/u;
const LINK = /\[([^\]\n]+)\]\([^)\n]*\)/gu;
const HEAD_DELIMITER = /\s[-–—]\s|:\s|:$|\s\(/u;

function clean(raw: string): string | null {
  const text = raw
    .replace(LINK, "$1")
    .replace(/[*_`]/gu, "")
    .replace(/^[\s"'“‘([]+|[\s"'”’:;,.)\]]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length < 2 || text.length > MAX_CHARS) return null;
  if (text.split(" ").length > MAX_WORDS) return null;
  if (!/\p{L}/u.test(text)) return null;
  // A name starts with a capital or a digit; "cheap" in a bolded phrase, or "the notion of", is not one.
  if (!/^[\p{Lu}\d]/u.test(text)) return null;
  if (text.includes("/") || text.includes("://")) return null;
  if (NOT_ENTITIES.has(text.toLowerCase())) return null;
  return text;
}

function listHead(item: string): string | null {
  const link = LEADING_LINK.exec(item);
  if (link !== null) return link[1] ?? null;
  // An item that opens with a bold span is read by the bold pass.
  if (/^(\*\*|__)/u.test(item)) return null;
  const delimiter = HEAD_DELIMITER.exec(item);
  if (delimiter !== null) return item.slice(0, delimiter.index);
  // No delimiter: only a short run of capitalised words is a name ("Zoho CRM"); a bare phrase is a sentence fragment.
  const words = item.trim().split(/\s+/u);
  return words.length <= 3 && words.every((w) => /^[\p{Lu}\d]/u.test(w)) ? item : null;
}

/** The distinct entities one answer names, in the order they first appear. */
export function extractEntities(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (raw: string | null): void => {
    if (raw === null) return;
    const name = clean(raw);
    if (name === null) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };
  for (const line of text.split(/\r?\n/u)) {
    const item = LIST_ITEM.exec(line)?.[1];
    const bold = [...line.matchAll(BOLD)].map((m) => ({ at: m.index, name: m[1] ?? m[2] ?? "" }));
    const head = item === undefined ? null : listHead(item);
    // Document order within the line: a list head sits before any bold span that follows it.
    if (head !== null) add(head);
    for (const span of bold) add(span.name);
  }
  return names;
}
