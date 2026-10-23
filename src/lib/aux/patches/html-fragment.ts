import { parseFragment, serialize } from "parse5";
import { sha256Of, sha256Tag } from "./precondition.js";
import { PatchRejectedError, type PatchDraft } from "./types.js";

// STORY-053 AC6 — a markup fragment is sanitised against a strict ALLOW-list, and a script, style, frame or event attribute is a
// HARD ERROR. Not a strip: a fragment with the script silently removed is a patch that does not do what the diff showed. If a
// generator produced something disallowed, the generator is wrong, and the answer is to say so.
//
// The fragment is PARSED (parse5, the HTML5 spec's own algorithm) and the tree is checked node by node, then re-serialised from the
// tree. Checking the string with a pattern would check a different thing from what a browser builds: `<scr<script>ipt>`, a tab
// inside `javascript:`, a mixed-case tag. What is offered to the customer is the serialisation of what was checked.

/** NOT FROM THE REFERENCE: the cap on one fragment. A rule patch is a few elements; 200 KB is two orders of magnitude of slack. */
export const MAX_FRAGMENT_CHARS = 200_000;

export const GLOBAL_ATTRIBUTES: ReadonlySet<string> = new Set(["id", "class", "lang", "itemscope", "itemtype", "itemprop"]);

/** Every element a patch may carry, with the attributes it may carry on top of the global ones. Anything else is refused. */
export const ALLOWED_ELEMENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    p: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], ul: [], ol: [], li: [], dl: [], dt: [], dd: [],
    a: ["href", "rel", "title", "hreflang"], strong: [], em: [], b: [], i: [], u: [], br: [], hr: [], blockquote: [], code: [], pre: [],
    span: [], div: [], section: [], article: [], header: [], footer: [], nav: [], main: [], aside: [], small: [], sub: [], sup: [],
    abbr: ["title"], time: ["datetime"], figure: [], figcaption: [], img: ["src", "alt", "width", "height", "title"],
    table: [], caption: [], thead: [], tbody: [], tfoot: [], tr: [], th: ["scope", "colspan", "rowspan"], td: ["colspan", "rowspan"],
    // The head tags the crawler-access and entity rules patch.
    meta: ["name", "content", "property", "charset"], link: ["rel", "href", "hreflang"], title: [],
  }).map(([tag, attrs]) => [tag, new Set(attrs)]),
);

const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src"]);
const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);

const prohibited = (message: string, detail: Record<string, unknown>): PatchRejectedError => new PatchRejectedError("prohibited_markup", message, detail);

interface ParsedNode {
  readonly nodeName: string;
  readonly attrs?: readonly { name: string; value: string }[];
  readonly childNodes?: readonly ParsedNode[];
}

/** A URL's scheme the way a browser reads it: control characters and spaces are ignored, so `java\tscript:` is `javascript:`. */
function schemeOf(value: string): string | null {
  // eslint-disable-next-line no-control-regex
  const squeezed = value.replace(/[\u0000- ]/g, "").toLowerCase();
  const match = /^([a-z][a-z0-9+.-]*):/.exec(squeezed);
  return match === null ? null : match[1]!;
}

function check(node: ParsedNode): void {
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === "#text") continue;
    if (child.nodeName.startsWith("#")) throw prohibited(`a ${child.nodeName.slice(1)} node is not allowed`, { node: child.nodeName.slice(1) });
    const allowed = ALLOWED_ELEMENTS.get(child.nodeName);
    if (allowed === undefined) throw prohibited(`<${child.nodeName}> is not an allowed element`, { element: child.nodeName });
    for (const attr of child.attrs ?? []) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) throw prohibited(`an ${name} event attribute is not allowed`, { attribute: name, element: child.nodeName });
      if (!GLOBAL_ATTRIBUTES.has(name) && !allowed.has(name)) throw prohibited(`${name} is not an allowed attribute of <${child.nodeName}>`, { attribute: name, element: child.nodeName });
      if (URL_ATTRIBUTES.has(name)) {
        const scheme = schemeOf(attr.value);
        if (scheme !== null && !SAFE_SCHEMES.has(scheme)) throw prohibited(`a ${scheme}: URL is not allowed`, { attribute: name, element: child.nodeName, scheme });
      }
    }
    check(child);
  }
}

/** The fragment as a browser would build it and as it may be offered. Throws PatchRejectedError rather than returning anything adjusted. */
export function sanitiseFragment(html: string): string {
  if (html.trim() === "") throw new PatchRejectedError("malformed_markup", "the fragment is empty");
  if (html.length > MAX_FRAGMENT_CHARS) throw new PatchRejectedError("malformed_markup", `the fragment is longer than ${MAX_FRAGMENT_CHARS} characters`);
  // The fragment parser DROPS some start tags without a trace (html, head, body, frame, frameset, a stray td outside a table), and a
  // dropped tag is a silent strip. Every tag the source OPENS is therefore checked against the allow-list before parsing; the tree is
  // checked afterwards for what the parser built from them.
  for (const open of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    const name = open[1]!.toLowerCase();
    if (!ALLOWED_ELEMENTS.has(name)) throw prohibited(`<${name}> is not an allowed element`, { element: name });
  }
  const tree = parseFragment(html);
  check(tree as unknown as ParsedNode);
  return serialize(tree);
}

export type FragmentInsertion = "head_append" | "body_prepend" | "body_append";
const INSERTION_TEXT: Readonly<Record<FragmentInsertion, string>> = {
  head_append: "Add it at the end of the page's <head>.",
  body_prepend: "Add it at the start of the page's <body>.",
  body_append: "Add it at the end of the page's <body>.",
};

export interface BuildHtmlFragmentInput {
  readonly ruleCode: string;
  readonly targetUrl: string;
  /** The page as fetched: its sha256 is the precondition. */
  readonly pageHtml: string;
  readonly fragment: string;
  readonly insertion: FragmentInsertion;
  readonly explanation: string;
  readonly derivation: string;
}

export function buildHtmlFragmentPatch(input: BuildHtmlFragmentInput): PatchDraft {
  const clean = sanitiseFragment(input.fragment);
  const before = sha256Of(input.pageHtml);
  return {
    ruleCode: input.ruleCode,
    kind: "html_fragment",
    targetUrl: input.targetUrl,
    contentBeforeHash: before,
    contentAfter: clean,
    unifiedDiff: null,
    jsonldBlocks: null,
    reversal: { operation: "remove_fragment", content: clean },
    preconditions: [{ kind: "page_hash", value: sha256Tag(before) }],
    explanation: `${input.explanation} ${INSERTION_TEXT[input.insertion]}`,
    derivation: input.derivation,
    requiresHumanReview: false,
    reviewReason: null,
    riskFlags: [],
  };
}
