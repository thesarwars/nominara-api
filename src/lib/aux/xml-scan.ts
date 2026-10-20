// STORY-049 — linear-time element scanning for attacker-shaped XML (sitemaps).
//
// WHY NOT A REGEX. `/<url\b[^>]*>([\s\S]*?)<\/url>/g` over a file of UNCLOSED `<url>` tags makes every start position
// scan to the end of the input: quadratic, about 11 minutes for a 5 MB file, on a synchronous call that no timer, budget
// or BullMQ lock renewal can interrupt. Scanning with `indexOf` and STOPPING as soon as a closer cannot be found makes
// the whole pass linear: a missing closer for one start means there is no closer for any later start either.

const isNameChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/**
 * The inner text of each `<name ...>...</name>` element, in document order (first start to first closer, lazily, as the
 * regex it replaces did). Stops at the first start that has no `>` or no closer after it.
 */
export function* elementsOf(xml: string, name: string): Generator<string> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let from = 0;
  for (;;) {
    const start = xml.indexOf(open, from);
    if (start < 0) return;
    const afterName = start + open.length;
    // `\b` in the regex: `<urlx>` is not a `<url>`.
    if (isNameChar(xml[afterName])) {
      from = afterName;
      continue;
    }
    const gt = xml.indexOf(">", afterName);
    if (gt < 0) return;
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) return;
    yield xml.slice(gt + 1, end);
    from = end + close.length;
  }
}

/** The inner text of the first `<name>` element, or null. */
export function firstElement(xml: string, name: string): string | null {
  for (const inner of elementsOf(xml, name)) return inner;
  return null;
}
