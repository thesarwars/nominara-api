// STORY-097 · integrations-and-sharing.md §2 — `email_footer_html` is a sanitised HTML SUBSET, re-serialised.
//
// The stored footer is written by this module from an allow-list; the upload is never copied through. Allowed: p, br, strong, b,
// em, i, small, ul, li, and `a` carrying only an https or mailto href. Everything else loses its tag (its text is kept), except
// the elements whose CONTENT is the hazard (script, style, iframe, object, embed, template, noscript), which lose the content too.
// What was removed is reported back.

export const MAX_EMAIL_FOOTER_CHARS = 2000;

export interface FooterDropped {
  readonly construct: string;
  readonly reason: string;
}
export type EmailFooterResult =
  | { readonly ok: true; readonly html: string; readonly dropped: FooterDropped[] }
  | { readonly ok: false; readonly reason: string };

const ALLOWED_TAGS: ReadonlySet<string> = new Set(["p", "br", "strong", "b", "em", "i", "small", "ul", "li", "a"]);
const VOID_TAGS: ReadonlySet<string> = new Set(["br"]);
const CONTENT_HAZARD: ReadonlySet<string> = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript"]);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/y;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", mdash: "\u2014", ndash: "\u2013",
};
/** Numeric references and the named ones above are decoded (the output is then escaped once); an unknown named one is removed and reported. */
function decodeEntities(s: string, onUnknown?: (entity: string) => void): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, e: string) => {
    if (e.startsWith("#")) {
      const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      const ok = cp >= 0x20 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) && !(cp >= 0x7f && cp <= 0x9f);
      if (!ok) onUnknown?.(m);
      return ok ? String.fromCodePoint(cp) : "";
    }
    const named = NAMED_ENTITIES[e.toLowerCase()];
    if (named === undefined) onUnknown?.(m);
    return named ?? "";
  });
}

export function sanitiseEmailFooter(input: string): EmailFooterResult {
  if (input.length > MAX_EMAIL_FOOTER_CHARS) return { ok: false, reason: "the footer is longer than " + String(MAX_EMAIL_FOOTER_CHARS) + " characters" };
  const dropped: FooterDropped[] = [];
  const note = (construct: string, reason: string): void => {
    if (!dropped.some((d) => d.construct === construct)) dropped.push({ construct, reason });
  };
  const open: string[] = [];
  const unknownEntity = (entity: string): void => note(entity + " entity", "unknown character reference removed");
  let out = "";
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out += escapeText(decodeEntities(input.slice(i), unknownEntity));
      break;
    }
    out += escapeText(decodeEntities(input.slice(i, lt), unknownEntity));
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      note("comment", "comments are removed");
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(input);
    if (m === null) {
      out += "&lt;";
      i = lt + 1;
      continue;
    }
    i = lt + m[0].length;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (CONTENT_HAZARD.has(name)) {
      note(name + " element", "removed with its content");
      if (!closing && m[4] !== "/") {
        const end = input.toLowerCase().indexOf("</" + name, i);
        const close = end === -1 ? -1 : input.indexOf(">", end);
        i = close === -1 ? input.length : close + 1;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) {
      note(name + " element", "tag removed; its text is kept");
      continue;
    }
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at !== -1) {
        for (let k = open.length - 1; k > at; k -= 1) out += "</" + open.pop()! + ">";
        open.pop();
        out += "</" + name + ">";
      }
      continue;
    }
    let attrs = "";
    for (const a of m[3]!.matchAll(ATTR)) {
      const attr = a[1]!.toLowerCase();
      const value = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
      if (name === "a" && attr === "href") {
        const clean = value.replace(/[\p{Cc}\s]/gu, "");
        if (/^(?:https:\/\/|mailto:)[^\s"'<>]+$/i.test(clean)) attrs += ' href="' + escapeAttr(clean) + '"';
        else note(/^javascript:/i.test(clean) ? "javascript: link" : "link target", "only https and mailto links are kept");
      } else {
        note(attr + " attribute", "attribute removed");
      }
    }
    out += "<" + name + attrs + ">";
    if (!VOID_TAGS.has(name)) open.push(name);
  }
  while (open.length > 0) out += "</" + open.pop()! + ">";
  return { ok: true, html: out, dropped };
}
