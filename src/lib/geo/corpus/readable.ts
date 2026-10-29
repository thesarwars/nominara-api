import { parse } from "parse5";
import { sanitiseText } from "../../aux/sanitise.js";

// STORY-058 AC4 - readable extraction of a fetched page into the text the chunker splits.
//
// The HTML is PARSED (parse5, the HTML5 algorithm) and walked; no regex touches markup. The output is plain text in which a heading is
// a `#`-prefixed line and every block is separated by a blank line - the boundaries the chunker splits on first. Script, style and
// the page furniture (nav, header, footer, aside, forms, controls) are dropped, and when the page has a <main> or <article> only
// that subtree is read: a page's boilerplate is often longer than its substance (the story's Technical notes). This is the first of
// two boilerplate defences; the lexical filter is the second.

interface Node {
  readonly nodeName: string;
  readonly childNodes?: Node[];
  readonly value?: string;
  readonly content?: { readonly childNodes: Node[] };
}

const SKIP = new Set(["script", "style", "noscript", "template", "nav", "header", "footer", "aside", "form", "svg", "iframe", "button", "select", "option", "head", "dialog"]);
const BLOCK = new Set(["p", "li", "div", "section", "article", "main", "blockquote", "pre", "td", "th", "tr", "table", "tbody", "thead", "ul", "ol", "dl", "dd", "dt", "figure", "figcaption", "details", "summary", "address", "body", "html", "br", "hr"]);
const HEADING = /^h([1-6])$/;

function findFirst(node: Node, name: string): Node | undefined {
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === name) return child;
    const found = findFirst(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function extractReadable(html: string): string {
  if (html.trim() === "") return "";
  const document = parse(html) as unknown as Node;
  const root = findFirst(document, "main") ?? findFirst(document, "article") ?? findFirst(document, "body") ?? document;

  const blocks: string[] = [];
  let buffer = "";
  const flush = (prefix = ""): void => {
    const text = buffer.replace(/\s+/g, " ").trim();
    buffer = "";
    if (text !== "") blocks.push(`${prefix}${text}`);
  };

  const walk = (node: Node): void => {
    if (node.nodeName === "#text") {
      buffer += node.value ?? "";
      return;
    }
    if (node.nodeName.startsWith("#") && node.nodeName !== "#document") return;
    if (SKIP.has(node.nodeName)) return;
    const heading = HEADING.exec(node.nodeName);
    if (heading !== null) {
      flush();
      for (const child of node.childNodes ?? []) walk(child);
      flush(`${"#".repeat(Number(heading[1]))} `);
      return;
    }
    const block = BLOCK.has(node.nodeName);
    if (block) flush();
    for (const child of node.childNodes ?? []) walk(child);
    if (block) flush();
  };
  walk(root);
  flush();
  return sanitiseText(blocks.join("\n\n"));
}
