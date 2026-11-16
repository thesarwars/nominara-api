import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { toRegistrableDomain } from "../net/registrable-domain.js";
import { incrementCounter, observeValue } from "../telemetry/metrics.js";
import { sanitiseText } from "./sanitise.js";
import type { Tokenizer, TokenizerIdentity } from "./tokenizer.js";

// STORY-050 — the document model (aux-and-geo-analysis.md, "The document model"): the one object every AUX rule receives.
//
// PURE. A stored snapshot goes in and the model comes out: no fetch, no clock, no randomness, no network facility is imported, so
// the same snapshot builds the same model and an audit can be re-run from storage. A rule that needs data this model lacks is a
// specification gap, never a reason to fetch.
//
// BOTH VARIANTS, ONE CODE PATH. `raw` and `rendered` are produced by the same function and have the same keys, so a render-mode
// rule is a ratio between two like objects. When there is no rendered copy (the renderer was unavailable) `rendered` is null, not
// an empty copy: a missing capture must never read as a page with no content.
//
// TOKENS come from the injected Tokenizer, which must be the embedding model's own (tokenizer.ts).

type Node = DefaultTreeAdapterMap["node"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
type Element = DefaultTreeAdapterMap["element"];

const logger = new Logger("aux-document-model");
const tracer = trace.getTracer("nominara-api");

export interface Heading {
  readonly level: number;
  readonly text: string;
  readonly children: Heading[];
}

export interface StructuredItem {
  /** `itemtype` (microdata) or `typeof` (RDFa), as written. Absent when the item declares none. */
  readonly type?: string;
  /** RDFa only: the in-scope `vocab`. */
  readonly vocab?: string;
  /** Every value of every property of this item, in document order. A nested item is an object here. */
  readonly properties: Record<string, unknown[]>;
}

/**
 * A malformation in one of the three structured-data formats, captured instead of discarded (STORY-050 AC5: "a parse error is itself a finding").
 * Each format has its own closed set of reasons, defined and documented beside its checker below (JSON-LD: `extractJsonLd`; microdata:
 * MICRODATA_ERRORS; RDFa: RDFA_ERRORS). The error cases are the ones the formats' own specifications define as invalid. Anything a lenient reader
 * would still make sense of but a validator would only warn about is NOT an error here.
 */
export interface ParseError {
  readonly format: "jsonld" | "microdata" | "rdfa";
  /** Which copy the broken markup was in. A parse error in the plain copy is a finding even when the rendered copy is clean. */
  readonly variant: "raw" | "rendered";
  /**
   * Ordinal of the offending block (JSON-LD: among the document's ld+json scripts) or element (microdata: among elements carrying an item* attribute;
   * RDFa: among elements carrying typeof, property, prefix or vocab), in document order.
   */
  readonly index: number;
  readonly reason: JsonLdErrorReason | MicrodataErrorReason | RdfaErrorReason;
  /** Character offset the JSON parser reported, or null when it did not report one (always null for microdata and RDFa: they have no parse offset). */
  readonly position: number | null;
  /** JSON-LD: the first characters of the block. Microdata and RDFa: the offending attribute as written. Bounded and sanitised, never the page's text. */
  readonly snippet: string;
}

export type JsonLdErrorReason = "invalid_json" | "empty" | "not_object_or_array";

export interface StructuredData {
  jsonLd: unknown[];
  microdata: StructuredItem[];
  rdfa: StructuredItem[];
  parseErrors: ParseError[];
}

export interface AuxVariant {
  readonly html: string;
  /** The page's main content as text: block elements on their own lines. */
  readonly mainText: string;
  /** Tokens in ALL visible text of the page (what AUX-R-019 and AUX-R-020 divide by). */
  readonly tokenCount: number;
  /** Tokens in `mainText` (the numerator of AUX-R-020 and AUX-R-026). */
  readonly mainTokenCount: number;
  /** Every heading on the page, nested by level. */
  readonly headingTree: Heading[];
  readonly structured: StructuredData;
}

export interface ContentBlock {
  /** null = the content before the first heading. */
  readonly heading: string | null;
  /** 1-6; 0 for the content before the first heading. */
  readonly level: number;
  readonly tokens: number;
  /**
   * Tokens in the longest run of text with no intervening list or table (the section itself ends at its next heading). The text inside a list or
   * table is not part of any run. 0 for a section with no text of its own: a measured 0, never null (AUX-R-021).
   */
  readonly longestUnstructuredTokens: number;
  readonly sentences: { readonly count: number; /** null = no sentences, which is not a mean of 0. */ readonly meanWords: number | null; readonly maxWords: number };
  readonly longestParagraphChars: number;
  readonly tables: number;
  readonly lists: { readonly ordered: number; readonly unordered: number; readonly definition: number };
  readonly codeSpans: number;
}

export interface AuxDocument {
  readonly url: string;
  readonly finalUrl: string;
  readonly httpStatus: number;
  /** The URLs that answered with a redirect, in order. Empty = no redirect; `finalUrl` is where the chain ended. */
  readonly redirectChain: string[];
  readonly headers: Record<string, string>;
  readonly raw: AuxVariant;
  /** null = no rendered capture exists. */
  readonly rendered: AuxVariant | null;
  /**
   * The structured DATA of the rendered copy when there is one, else the raw copy; the PARSE ERRORS of both copies (raw first, each
   * tagged with its `variant`), because a JSON-LD error that only the raw copy has is what a non-executing crawler sees. Each
   * variant also carries its own.
   */
  readonly structured: StructuredData;
  readonly meta: {
    title?: string;
    description?: string;
    canonical?: string;
    robots?: string;
    googlebotNoSnippet: boolean;
    maxSnippet?: number;
    dateModified?: string;
    datePublished?: string;
    hreflang: string[];
    /** Bare indexing/snippet directives that apply to Googlebot or to everyone (meta robots, meta googlebot, X-Robots-Tag), lowercased, sorted. */
    directives: string[];
  };
  /** One per heading section of the rendered copy when there is one, else the raw copy. */
  readonly blocks: ContentBlock[];
  readonly links: { internal: number; external: number; nofollow: number };
  readonly media: { images: number; imagesWithAlt: number };
  readonly timing: { ttfbMs: number | null; loadMs: number | null; bytes: number };
  readonly tokenizer: TokenizerIdentity;
}

export interface DocumentSnapshot {
  readonly url: string;
  readonly finalUrl: string;
  readonly httpStatus: number;
  readonly redirectChain: readonly string[];
  /** Response headers of the plain fetch; multiple values joined with ", ". */
  readonly headers: Readonly<Record<string, string>>;
  readonly rawHtml: string;
  /** null = no rendered capture. */
  readonly renderedHtml: string | null;
  /** null = not measured. A measured 0 stays 0. */
  readonly timing: { readonly ttfbMs: number | null; readonly loadMs: number | null };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Tree helpers

const isElement = (n: Node): n is Element => "tagName" in n;
const isText = (n: Node): n is DefaultTreeAdapterMap["textNode"] => n.nodeName === "#text";
const childrenOf = (n: Node): readonly Node[] => ("childNodes" in n ? (n as ParentNode).childNodes : []);
const attrOf = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;

/** Never part of the text a reader (or a retrieval system) sees. */
const INVISIBLE = new Set(["script", "style", "noscript", "template", "head"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "br", "caption",
]);
/** Page furniture, dropped only when there is no <main>, [role=main] or <article> to speak for the content. */
const CHROME = new Set(["header", "nav", "aside", "footer"]);

function walk(node: Node, visit: (el: Element) => boolean | void): void {
  for (const child of childrenOf(node)) {
    if (!isElement(child)) continue;
    if (visit(child) === false) continue;
    walk(child, visit);
  }
}

function findFirst(root: Node, test: (el: Element) => boolean): Element | undefined {
  let found: Element | undefined;
  walk(root, (el) => {
    if (found !== undefined) return false;
    if (test(el)) {
      found = el;
      return false;
    }
    return undefined;
  });
  return found;
}

function collectText(node: Node, skip: (el: Element) => boolean, out: string[]): void {
  for (const child of childrenOf(node)) {
    if (isText(child)) out.push(child.value);
    else if (isElement(child)) {
      if (INVISIBLE.has(child.tagName) || skip(child)) continue;
      const block = BLOCK.has(child.tagName);
      if (block) out.push("\n");
      collectText(child, skip, out);
      if (block) out.push("\n");
    }
  }
}

/** Whitespace collapsed within a line, empty lines dropped, lines joined with \n. Deterministic and idempotent. */
function normalise(parts: readonly string[]): string {
  return sanitiseText(
    parts
      .join("")
      .split("\n")
      .map((l) => l.replace(/[\s ]+/gu, " ").trim())
      .filter((l) => l !== "")
      .join("\n"),
  );
}

const textOf = (node: Node, skip: (el: Element) => boolean = () => false): string => {
  const parts: string[] = [];
  collectText(node, skip, parts);
  return normalise(parts);
};

const inline = (node: Node): string => textOf(node).replace(/\n/gu, " ");

// ---------------------------------------------------------------------------------------------------------------------------
// Main content, headings, blocks

/**
 * A SUBSTITUTE for the reference's "readability main-content extraction" (no new dependency was allowed): <main>, [role=main],
 * <article>, else the body minus header/nav/aside/footer. Furniture in a plain <div> (a sidebar, a cookie banner) is counted as
 * content on a div-only template, which biases AUX-R-020 toward under-firing. Pinned by a test; recorded in STORY-050.
 */
function mainRoot(body: Element): { root: Element; skip: (el: Element) => boolean } {
  const none = (): boolean => false;
  const main = findFirst(body, (el) => el.tagName === "main") ?? findFirst(body, (el) => attrOf(el, "role") === "main") ?? findFirst(body, (el) => el.tagName === "article");
  if (main !== undefined) return { root: main, skip: none };
  return { root: body, skip: (el) => CHROME.has(el.tagName) };
}

function headingTree(body: Element): Heading[] {
  const roots: Heading[] = [];
  const stack: Heading[] = [];
  walk(body, (el) => {
    if (INVISIBLE.has(el.tagName)) return false;
    const m = /^h([1-6])$/u.exec(el.tagName);
    if (m === null) return undefined;
    const heading: Heading = { level: Number(m[1]), text: inline(el), children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(heading);
    else parent.children.push(heading);
    stack.push(heading);
    return false;
  });
  return roots;
}

interface BlockDraft {
  heading: string | null;
  level: number;
  parts: string[];
  /** The text of the run in progress (outside any list or table), and the longest run closed so far, in tokens. */
  run: string[];
  longestRunTokens: number;
  longestParagraphChars: number;
  tables: number;
  ordered: number;
  unordered: number;
  definition: number;
  codeSpans: number;
}

const newDraft = (heading: string | null, level: number): BlockDraft => ({ heading, level, parts: [], run: [], longestRunTokens: 0, longestParagraphChars: 0, tables: 0, ordered: 0, unordered: 0, definition: 0, codeSpans: 0 });

const SENTENCE_BREAK = /(?<=[.!?])["')\]]*\s+(?=\S)/u;

function sentenceStats(text: string): ContentBlock["sentences"] {
  let count = 0;
  let words = 0;
  let max = 0;
  for (const line of text.split("\n")) {
    for (const sentence of line.split(SENTENCE_BREAK)) {
      const n = (sentence.match(/\S+/gu) ?? []).length;
      if (n === 0) continue;
      count += 1;
      words += n;
      if (n > max) max = n;
    }
  }
  return { count, meanWords: count === 0 ? null : Math.round((words / count) * 100) / 100, maxWords: max };
}

function contentBlocks(body: Element, tokenizer: Tokenizer): ContentBlock[] {
  const { root, skip } = mainRoot(body);
  const drafts: BlockDraft[] = [];
  let current = newDraft(null, 0);

  const closeRun = (): void => {
    current.longestRunTokens = Math.max(current.longestRunTokens, tokenizer.count(normalise(current.run)));
    current.run = [];
  };
  // `inBreak`: inside a list or table, whose text is part of the section but of no run.
  const emit = (text: string, inBreak: boolean): void => {
    current.parts.push(text);
    if (!inBreak) current.run.push(text);
  };

  const visit = (node: Node, inPre: boolean, inBreak: boolean): void => {
    for (const child of childrenOf(node)) {
      if (isText(child)) {
        emit(child.value, inBreak);
        continue;
      }
      if (!isElement(child) || INVISIBLE.has(child.tagName) || skip(child)) continue;
      const tag = child.tagName;
      const h = /^h([1-6])$/u.exec(tag);
      if (h !== null) {
        closeRun();
        drafts.push(current);
        current = newDraft(inline(child), Number(h[1]));
        continue;
      }
      const breaks = tag === "table" || tag === "ul" || tag === "ol" || tag === "dl";
      if (breaks && !inBreak) closeRun();
      if (tag === "table") current.tables += 1;
      else if (tag === "ul") current.unordered += 1;
      else if (tag === "ol") current.ordered += 1;
      else if (tag === "dl") current.definition += 1;
      else if (tag === "pre") current.codeSpans += 1;
      else if (tag === "code" && !inPre) current.codeSpans += 1;
      else if (tag === "p") current.longestParagraphChars = Math.max(current.longestParagraphChars, [...inline(child)].length);
      const block = BLOCK.has(tag);
      if (block) emit("\n", inBreak);
      visit(child, inPre || tag === "pre", inBreak || breaks);
      if (block) emit("\n", inBreak);
    }
  };
  visit(root, false, false);
  closeRun();
  drafts.push(current);

  const blocks: ContentBlock[] = [];
  for (const d of drafts) {
    const text = normalise(d.parts);
    // The preamble is a block only when something precedes the first heading.
    if (d.heading === null && text === "" && d.tables + d.ordered + d.unordered + d.definition + d.codeSpans === 0) continue;
    blocks.push({
      heading: d.heading,
      level: d.level,
      tokens: tokenizer.count(text),
      longestUnstructuredTokens: d.longestRunTokens,
      sentences: sentenceStats(text),
      longestParagraphChars: d.longestParagraphChars,
      tables: d.tables,
      lists: { ordered: d.ordered, unordered: d.unordered, definition: d.definition },
      codeSpans: d.codeSpans,
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Structured data

const SNIPPET_CHARS = 160;

function extractJsonLd(doc: Node, variant: "raw" | "rendered", out: StructuredData): void {
  let index = 0;
  walk(doc, (el) => {
    if (el.tagName !== "script" || (attrOf(el, "type") ?? "").trim().toLowerCase() !== "application/ld+json") return undefined;
    const text = childrenOf(el).filter(isText).map((t) => t.value).join("");
    const at = index;
    index += 1;
    const fail = (reason: JsonLdErrorReason, position: number | null): void => {
      out.parseErrors.push({ format: "jsonld", variant, index: at, reason, position, snippet: sanitiseText(text.trim(), SNIPPET_CHARS) });
    };
    if (text.trim() === "") return fail("empty", null);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      // The engine's message quotes the source; only the offset is kept, the block's own snippet is stored separately and bounded.
      const m = error instanceof Error ? /position (\d+)/u.exec(error.message) : null;
      return fail("invalid_json", m === null ? null : Number(m[1]));
    }
    if (Array.isArray(value)) out.jsonLd.push(...value);
    else if (typeof value === "object" && value !== null) out.jsonLd.push(value);
    else fail("not_object_or_array", null);
    return undefined;
  });
}

interface ItemSyntax {
  isScope(el: Element): boolean;
  nameOf(el: Element): string | undefined;
  typeOf(el: Element): string | undefined;
  valueOf(el: Element): string;
  vocabOf?(el: Element): string | undefined;
  /** Microdata only: the ids an item also takes its properties from (`itemref`). */
  refsOf?(el: Element): string[];
}

const URL_VALUE: Readonly<Record<string, string>> = { audio: "src", embed: "src", iframe: "src", img: "src", source: "src", track: "src", video: "src", a: "href", area: "href", link: "href", object: "data" };

const MICRODATA: ItemSyntax = {
  isScope: (el) => attrOf(el, "itemscope") !== undefined,
  nameOf: (el) => attrOf(el, "itemprop"),
  typeOf: (el) => attrOf(el, "itemtype"),
  // WHATWG HTML 5.4.1: itemref is read on an element with itemscope only; elsewhere it is an error (itemref_without_itemscope) and contributes nothing.
  refsOf: (el) => (attrOf(el, "itemscope") === undefined ? [] : names(attrOf(el, "itemref") ?? "")),
  valueOf: (el) => {
    if (el.tagName === "meta") return sanitiseText(attrOf(el, "content") ?? "");
    const attr = URL_VALUE[el.tagName];
    if (attr !== undefined) return sanitiseText(attrOf(el, attr) ?? "");
    if (el.tagName === "data" || el.tagName === "meter") return sanitiseText(attrOf(el, "value") ?? inline(el));
    if (el.tagName === "time") return sanitiseText(attrOf(el, "datetime") ?? inline(el));
    return inline(el);
  },
};

const RDFA: ItemSyntax = {
  isScope: (el) => attrOf(el, "typeof") !== undefined,
  nameOf: (el) => attrOf(el, "property"),
  typeOf: (el) => attrOf(el, "typeof"),
  valueOf: (el) => {
    const content = attrOf(el, "content");
    if (content !== undefined) return sanitiseText(content);
    const resource = attrOf(el, "resource") ?? attrOf(el, URL_VALUE[el.tagName] ?? "href");
    if (resource !== undefined) return sanitiseText(resource);
    if (el.tagName === "time") return sanitiseText(attrOf(el, "datetime") ?? inline(el));
    return inline(el);
  },
  vocabOf: (el) => {
    for (let n: ParentNode | undefined = el; n !== undefined && isElement(n); n = n.parentNode ?? undefined) {
      const v = attrOf(n, "vocab");
      if (v !== undefined) return sanitiseText(v);
    }
    return undefined;
  },
};

const names = (value: string): string[] => value.split(/\s+/u).filter((n) => n !== "");

/** What a microdata build shares across the items of one document: ids, document order, and what the builds reached. Absent for RDFa. */
interface MicrodataContext {
  /** `getElementById`: the FIRST element in tree order wins when an id repeats. */
  readonly byId: ReadonlyMap<string, Element>;
  /** Tree-order index of every element: property values are listed in tree order, however they were reached (WHATWG HTML 5.4.1 step "sort results in tree order"). */
  readonly order: ReadonlyMap<Element, number>;
  /** Every element carrying an itemprop that some item reached, by descent or by itemref. What is left over is an orphan. */
  readonly claimed: Set<Element>;
  /** Items being built right now (the stack): reaching one again through an itemref is a cycle. */
  readonly building: Set<Element>;
  /** The itemprop-and-itemscope elements an itemref led back into. */
  readonly cyclic: Set<Element>;
}

function buildItem(scope: Element, syntax: ItemSyntax, ctx?: MicrodataContext): StructuredItem {
  const entries: { order: number; name: string; value: unknown }[] = [];
  const seen = new Set<Element>();
  ctx?.building.add(scope);

  const visit = (child: Element): void => {
    if (INVISIBLE.has(child.tagName) || seen.has(child)) return;
    seen.add(child);
    const nameAttr = syntax.nameOf(child);
    const scoped = syntax.isScope(child);
    if (nameAttr !== undefined) {
      ctx?.claimed.add(child);
      if (scoped && ctx?.building.has(child) === true) {
        // An itemref led back into an item that is still being built: cut here, or it would never end. Reported as itemref_cycle.
        ctx.cyclic.add(child);
        return;
      }
      const value = scoped ? buildItem(child, syntax, ctx) : syntax.valueOf(child);
      const at = ctx?.order.get(child) ?? 0;
      for (const n of names(nameAttr)) entries.push({ order: at, name: sanitiseText(n), value });
      if (scoped) return;
    } else if (scoped) {
      return; // an item of its own, not a property of this one
    }
    collect(child);
  };
  const collect = (node: Node): void => {
    for (const child of childrenOf(node)) if (isElement(child)) visit(child);
  };

  collect(scope);
  // itemref (microdata): the elements it names are walked as if they were children of the item. An id that names nothing is skipped here and reported
  // by the checker (itemref_missing_id).
  if (ctx !== undefined) {
    for (const id of syntax.refsOf?.(scope) ?? []) {
      const target = ctx.byId.get(id);
      if (target !== undefined) visit(target);
    }
  }
  ctx?.building.delete(scope);

  // Tree order, stable: an itemref target ahead of the scope comes first, as it does in the document.
  const props = new Map<string, unknown[]>();
  for (const e of ctx === undefined ? entries : [...entries].sort((x, y) => x.order - y.order)) {
    const list = props.get(e.name);
    if (list === undefined) props.set(e.name, [e.value]);
    else list.push(e.value);
  }
  const type = syntax.typeOf(scope);
  const vocab = syntax.vocabOf?.(scope);
  return {
    ...(type === undefined ? {} : { type: sanitiseText(type.trim()) }),
    ...(vocab === undefined ? {} : { vocab }),
    properties: Object.fromEntries(props),
  };
}

function extractItems(doc: Node, syntax: ItemSyntax, ctx?: MicrodataContext): StructuredItem[] {
  const items: StructuredItem[] = [];
  walk(doc, (el) => {
    if (INVISIBLE.has(el.tagName) && el.tagName !== "head") return false;
    if (syntax.isScope(el) && syntax.nameOf(el) === undefined) {
      items.push(buildItem(el, syntax, ctx));
      // Keep walking: a top-level item inside another item's markup is still a top-level item.
    }
    return undefined;
  });
  return items;
}

function microdataContext(doc: Node): MicrodataContext {
  const byId = new Map<string, Element>();
  const order = new Map<Element, number>();
  walk(doc, (el) => {
    order.set(el, order.size);
    const id = attrOf(el, "id");
    if (id !== undefined && id !== "" && !byId.has(id)) byId.set(id, el);
  });
  return { byId, order, claimed: new Set(), building: new Set(), cyclic: new Set() };
}

/** The elements a structured-data check looks at: the document's, minus what a reader never sees (script, style, noscript, template), `head` included. */
function walkVisible(doc: Node, visit: (el: Element) => void): void {
  walk(doc, (el) => {
    if (INVISIBLE.has(el.tagName) && el.tagName !== "head") return false;
    visit(el);
    return undefined;
  });
}

/** `name="value"` as written, bounded and sanitised: what a finding quotes. Never the element's text. */
const attrSnippet = (name: string, value: string): string => sanitiseText(`${name}="${value}"`, SNIPPET_CHARS);

// --- Microdata -------------------------------------------------------------------------------------------------------------
//
// MICRODATA_ERRORS - the cases WHATWG HTML 5.4 (Microdata) defines as invalid, and nothing more:
//   itemprop_outside_scope        an element with itemprop that no item reaches: it has no itemscope ancestor and no itemref names it (or an ancestor of it)
//   empty_itemprop                an itemprop whose value has no name tokens (a property named by nothing)
//   itemref_missing_id            an itemref token naming an id that is not in the document (one error per missing id)
//   itemref_without_itemscope     itemref on an element that has no itemscope (the spec reads itemref only on an item)
//   itemtype_without_itemscope    itemtype on an element that has no itemscope (the spec reads itemtype only on an item)
//   itemref_cycle                 an itemref that leads back into an item still being built; the walk is cut there so it terminates
// NOT errors (a lenient reader copes, and the spec allows them): an item with no itemtype, an item with no properties, an itemprop whose value is empty,
// the same property name twice, an unknown itemtype vocabulary (whether a type is a real schema.org type is AUX-R-016's business, not a parse error).
export type MicrodataErrorReason =
  | "itemprop_outside_scope"
  | "empty_itemprop"
  | "itemref_missing_id"
  | "itemref_without_itemscope"
  | "itemtype_without_itemscope"
  | "itemref_cycle";

function checkMicrodata(doc: Node, variant: "raw" | "rendered", ctx: MicrodataContext, out: StructuredData): void {
  const marked: Element[] = [];
  walkVisible(doc, (el) => {
    if (["itemscope", "itemprop", "itemref", "itemtype"].some((a) => attrOf(el, a) !== undefined)) marked.push(el);
  });

  // An itemprop that is an item but belongs to nothing is built once, only so the properties inside it are not each reported as orphans too:
  // one orphan, reported once, however much markup hangs off it.
  for (const el of marked) {
    if (attrOf(el, "itemprop") !== undefined && names(attrOf(el, "itemprop")!).length > 0 && !ctx.claimed.has(el) && MICRODATA.isScope(el)) {
      buildItem(el, MICRODATA, ctx);
    }
  }

  marked.forEach((el, index) => {
    const add = (reason: MicrodataErrorReason, snippet: string): void => {
      out.parseErrors.push({ format: "microdata", variant, index, reason, position: null, snippet });
    };
    const itemprop = attrOf(el, "itemprop");
    const itemref = attrOf(el, "itemref");
    const itemtype = attrOf(el, "itemtype");
    const scoped = MICRODATA.isScope(el);

    if (itemprop !== undefined) {
      if (names(itemprop).length === 0) add("empty_itemprop", attrSnippet("itemprop", itemprop));
      else if (!ctx.claimed.has(el)) add("itemprop_outside_scope", attrSnippet("itemprop", itemprop));
    }
    if (itemref !== undefined) {
      if (!scoped) add("itemref_without_itemscope", attrSnippet("itemref", itemref));
      else for (const id of names(itemref)) if (!ctx.byId.has(id)) add("itemref_missing_id", attrSnippet("itemref", id));
    }
    if (itemtype !== undefined && !scoped) add("itemtype_without_itemscope", attrSnippet("itemtype", itemtype));
    if (ctx.cyclic.has(el)) add("itemref_cycle", attrSnippet("itemref", itemref ?? ""));
  });
}

// --- RDFa ------------------------------------------------------------------------------------------------------------------
//
// RDFA_ERRORS - the cases RDFa 1.1 Core defines as unresolvable, i.e. where a conforming processor would DROP the triple:
//   rdfa_missing_vocab                  a bare term (no colon) in typeof or property with no `vocab` in scope and not an initial-context term: it resolves to
//                                       nothing. Once per element.
//   rdfa_undeclared_prefix              a CURIE (`prefix:reference`) whose prefix is not declared by a `prefix` attribute or `xmlns:` on the element or an
//                                       ancestor, and is not in the RDFa initial context
//   rdfa_malformed_prefix_declaration   a `prefix` attribute that is not whitespace-separated `name: absolute-IRI` pairs
//   rdfa_malformed_curie                a token with a colon whose prefix is not a valid name, or whose reference is empty (`schema:`)
// NOT errors: a property with no typeof (it describes the document itself, valid RDFa Lite), an absolute IRI or blank node (`http://...`, `_:b`), the default
// prefix (`:name`, which resolves to the XHTML vocabulary), an unknown vocabulary or type name, `vocab=""` (it deliberately clears the vocab).
export type RdfaErrorReason = "rdfa_missing_vocab" | "rdfa_undeclared_prefix" | "rdfa_malformed_prefix_declaration" | "rdfa_malformed_curie";

/** RDFa 1.1 Initial Context prefixes (https://www.w3.org/2011/rdfa-context/rdfa-1.1): declared on every page without any markup. Compared case-insensitively. */
const RDFA_INITIAL_PREFIXES: ReadonlySet<string> = new Set([
  "as", "cc", "cnt", "csvw", "ctag", "dc", "dc11", "dcat", "dcterms", "dqv", "duv", "foaf", "gr", "grddl", "ical", "ldp", "ma", "oa", "odrl", "og", "org",
  "owl", "prov", "qb", "rdf", "rdfa", "rdfs", "rif", "rr", "schema", "sd", "sioc", "skos", "skosxl", "v", "vcard", "void", "wdr", "wdrs", "xhv", "xml", "xsd",
]);
/** RDFa 1.1 Initial Context terms (the XHTML vocabulary's reserved words): a bare term that needs no `vocab`. */
const RDFA_INITIAL_TERMS: ReadonlySet<string> = new Set([
  "alternate", "appendix", "bookmark", "cite", "chapter", "contents", "copyright", "first", "glossary", "help", "icon", "index", "last", "license", "meta",
  "next", "prev", "previous", "role", "section", "stylesheet", "subsection", "start", "top", "up", "describedby",
]);

const PREFIX_NAME = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/u;

/** `name: iri name: iri`, or null when it is not that. */
function parsePrefixDeclaration(value: string): string[] | null {
  const tokens = names(value);
  if (tokens.length === 0 || tokens.length % 2 !== 0) return null;
  const declared: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const name = tokens[i]!;
    if (!name.endsWith(":") || !PREFIX_NAME.test(name.slice(0, -1)) || !ABSOLUTE_IRI.test(tokens[i + 1]!)) return null;
    declared.push(name.slice(0, -1).toLowerCase());
  }
  return declared;
}

function checkRdfa(doc: Node, variant: "raw" | "rendered", out: StructuredData): void {
  let index = -1;
  walkVisible(doc, (el) => {
    if (!["typeof", "property", "prefix", "vocab"].some((a) => attrOf(el, a) !== undefined)) return;
    index += 1;
    const at = index;
    const add = (reason: RdfaErrorReason, snippet: string): void => {
      out.parseErrors.push({ format: "rdfa", variant, index: at, reason, position: null, snippet });
    };

    // What is in scope: the nearest `vocab` (an empty one clears it), and every prefix declared on this element or above it.
    let vocab: string | undefined;
    let vocabFound = false;
    const declared = new Set<string>();
    for (let n: ParentNode | undefined = el; n !== undefined && isElement(n); n = n.parentNode ?? undefined) {
      if (!vocabFound) {
        const v = attrOf(n, "vocab");
        if (v !== undefined) {
          vocab = v.trim() === "" ? undefined : v;
          vocabFound = true;
        }
      }
      for (const a of n.attrs) if (a.name.startsWith("xmlns:") && a.name.length > 6) declared.add(a.name.slice(6).toLowerCase());
      const px = attrOf(n, "prefix");
      if (px !== undefined) for (const d of parsePrefixDeclaration(px) ?? []) declared.add(d);
    }

    const prefixAttr = attrOf(el, "prefix");
    if (prefixAttr !== undefined && parsePrefixDeclaration(prefixAttr) === null) add("rdfa_malformed_prefix_declaration", attrSnippet("prefix", prefixAttr));

    let missingVocabReported = false;
    for (const attr of ["typeof", "property"] as const) {
      const value = attrOf(el, attr);
      if (value === undefined) continue;
      for (const token of names(value)) {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(token) || token.startsWith("_:")) continue; // an absolute IRI or a blank node
        const colon = token.indexOf(":");
        if (colon === -1) {
          if (vocab === undefined && !RDFA_INITIAL_TERMS.has(token.toLowerCase()) && !missingVocabReported) {
            missingVocabReported = true;
            add("rdfa_missing_vocab", attrSnippet(attr, value));
          }
          continue;
        }
        const prefix = token.slice(0, colon);
        const reference = token.slice(colon + 1);
        if (reference === "" || (prefix !== "" && !PREFIX_NAME.test(prefix))) add("rdfa_malformed_curie", attrSnippet(attr, value));
        else if (prefix !== "" && !declared.has(prefix.toLowerCase()) && !RDFA_INITIAL_PREFIXES.has(prefix.toLowerCase())) add("rdfa_undeclared_prefix", attrSnippet(attr, value));
      }
    }
  });
}

function extractStructured(doc: Node, variant: "raw" | "rendered"): StructuredData {
  const out: StructuredData = { jsonLd: [], microdata: [], rdfa: [], parseErrors: [] };
  extractJsonLd(doc, variant, out);
  const ctx = microdataContext(doc);
  out.microdata = extractItems(doc, MICRODATA, ctx);
  out.rdfa = extractItems(doc, RDFA);
  checkMicrodata(doc, variant, ctx, out);
  checkRdfa(doc, variant, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Meta, links, media

const VALUE_DIRECTIVES = new Set(["max-snippet", "max-image-preview", "max-video-preview", "unavailable_after"]);

interface ScopedDirectives {
  readonly bare: Set<string>;
  readonly maxSnippets: number[];
}

/**
 * Directives from a robots meta content or an X-Robots-Tag value. A segment `agent: directive` opens a scope for that user agent
 * and later bare segments belong to it; the scope applies here only when it is everyone's (`*` or none) or Googlebot's.
 */
function readDirectives(value: string, into: ScopedDirectives): void {
  let applies = true;
  for (const segment of value.split(",")) {
    let token = segment.trim().toLowerCase();
    const m = /^([a-z0-9_*-]+)\s*:\s*(.*)$/u.exec(token);
    if (m !== null && !VALUE_DIRECTIVES.has(m[1]!)) {
      applies = m[1] === "*" || m[1] === "googlebot";
      token = m[2]!.trim();
    }
    if (!applies || token === "") continue;
    const snippet = /^max-snippet\s*:\s*(-?\d+)$/u.exec(token);
    if (snippet !== null) into.maxSnippets.push(Number(snippet[1]));
    else if (!token.includes(":")) into.bare.add(token);
  }
}

const metaContent = (doc: Node, test: (el: Element) => boolean): string | undefined => {
  const el = findFirst(doc, (e) => e.tagName === "meta" && test(e));
  const v = el === undefined ? undefined : attrOf(el, "content");
  return v === undefined || v.trim() === "" ? undefined : sanitiseText(v.trim());
};

const nameIs = (n: string) => (e: Element): boolean => (attrOf(e, "name") ?? "").toLowerCase() === n;
const propertyIs = (n: string) => (e: Element): boolean => ((attrOf(e, "property") ?? attrOf(e, "name") ?? "").toLowerCase() === n);

function jsonLdDate(jsonLd: readonly unknown[], key: "dateModified" | "datePublished"): string | undefined {
  const stack: unknown[] = [...jsonLd];
  while (stack.length > 0) {
    const v = stack.shift();
    if (typeof v !== "object" || v === null) continue;
    const rec = v as Record<string, unknown>;
    const d = rec[key];
    if (typeof d === "string" && d.trim() !== "") return sanitiseText(d.trim());
    if (Array.isArray(rec["@graph"])) stack.push(...(rec["@graph"] as unknown[]));
  }
  return undefined;
}

function buildMeta(doc: Node, headers: Readonly<Record<string, string>>, structured: StructuredData): AuxDocument["meta"] {
  const directives: ScopedDirectives = { bare: new Set(), maxSnippets: [] };
  const robots = metaContent(doc, nameIs("robots"));
  for (const v of [robots, metaContent(doc, nameIs("googlebot"))]) if (v !== undefined) readDirectives(v, directives);
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === "x-robots-tag") readDirectives(v, directives);

  const titleEl = findFirst(doc, (e) => e.tagName === "title" && e.namespaceURI === "http://www.w3.org/1999/xhtml");
  const title = titleEl === undefined ? "" : inline(titleEl);
  const canonicalEl = findFirst(doc, (e) => e.tagName === "link" && names((attrOf(e, "rel") ?? "").toLowerCase()).includes("canonical") && (attrOf(e, "href") ?? "").trim() !== "");
  const hreflang: string[] = [];
  walk(doc, (e) => {
    if (e.tagName === "link" && names((attrOf(e, "rel") ?? "").toLowerCase()).includes("alternate")) {
      const lang = (attrOf(e, "hreflang") ?? "").trim();
      if (lang !== "" && !hreflang.includes(lang)) hreflang.push(sanitiseText(lang));
    }
    return undefined;
  });
  const description = metaContent(doc, nameIs("description"));
  const nonNegative = directives.maxSnippets.filter((n) => n >= 0);
  const maxSnippet = nonNegative.length > 0 ? Math.min(...nonNegative) : directives.maxSnippets.length > 0 ? -1 : undefined;
  const dateModified = metaContent(doc, propertyIs("article:modified_time")) ?? metaContent(doc, propertyIs("og:updated_time")) ?? jsonLdDate(structured.jsonLd, "dateModified");
  const datePublished = metaContent(doc, propertyIs("article:published_time")) ?? jsonLdDate(structured.jsonLd, "datePublished");
  const canonical = canonicalEl === undefined ? undefined : sanitiseText((attrOf(canonicalEl, "href") ?? "").trim());

  return {
    ...(title === "" ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(canonical === undefined ? {} : { canonical }),
    ...(robots === undefined ? {} : { robots }),
    googlebotNoSnippet: directives.bare.has("nosnippet"),
    ...(maxSnippet === undefined ? {} : { maxSnippet }),
    ...(dateModified === undefined ? {} : { dateModified }),
    ...(datePublished === undefined ? {} : { datePublished }),
    hreflang,
    directives: [...directives.bare].sort(),
  };
}

function siteOf(url: string): string | null {
  try {
    return toRegistrableDomain(url);
  } catch {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}

function countLinks(body: Element, finalUrl: string): AuxDocument["links"] {
  const home = siteOf(finalUrl);
  const links = { internal: 0, external: 0, nofollow: 0 };
  walk(body, (el) => {
    if (INVISIBLE.has(el.tagName)) return false;
    if (el.tagName !== "a") return undefined;
    const href = (attrOf(el, "href") ?? "").trim();
    if (href === "" || href.startsWith("#")) return undefined;
    let target: URL;
    try {
      target = new URL(href, finalUrl);
    } catch {
      return undefined;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
    if (siteOf(target.href) === home) links.internal += 1;
    else links.external += 1;
    if (names((attrOf(el, "rel") ?? "").toLowerCase()).includes("nofollow")) links.nofollow += 1;
    return undefined;
  });
  return links;
}

function countMedia(body: Element): AuxDocument["media"] {
  const media = { images: 0, imagesWithAlt: 0 };
  walk(body, (el) => {
    if (INVISIBLE.has(el.tagName)) return false;
    if (el.tagName === "img") {
      media.images += 1;
      // An empty alt marks a decorative image, which tells a reader nothing: coverage counts images that DESCRIBE themselves.
      if ((attrOf(el, "alt") ?? "").trim() !== "") media.imagesWithAlt += 1;
    }
    return undefined;
  });
  return media;
}

// ---------------------------------------------------------------------------------------------------------------------------

interface Parsed {
  readonly doc: ParentNode;
  readonly body: Element;
  readonly variant: AuxVariant;
}

function parseVariant(html: string, which: "raw" | "rendered", tokenizer: Tokenizer): Parsed {
  const doc = parse(html);
  const html5 = childrenOf(doc).find(isElement);
  const body = (html5 === undefined ? undefined : childrenOf(html5).find((n): n is Element => isElement(n) && n.tagName === "body"))!;
  const { root, skip } = mainRoot(body);
  const mainText = textOf(root, skip);
  return {
    doc,
    body,
    variant: {
      html,
      mainText,
      tokenCount: tokenizer.count(textOf(body)),
      mainTokenCount: tokenizer.count(mainText),
      headingTree: headingTree(body),
      structured: extractStructured(doc, which),
    },
  };
}

export function buildAuxDocument(snapshot: DocumentSnapshot, tokenizer: Tokenizer): AuxDocument {
  const started = performance.now();
  return tracer.startActiveSpan("aux.document.build", (span) => {
    try {
      const raw = parseVariant(snapshot.rawHtml, "raw", tokenizer);
      const rendered = snapshot.renderedHtml === null ? null : parseVariant(snapshot.renderedHtml, "rendered", tokenizer);
      const primary = rendered ?? raw;
      const structured: StructuredData = {
        ...primary.variant.structured,
        parseErrors: [...raw.variant.structured.parseErrors, ...(rendered?.variant.structured.parseErrors ?? [])],
      };
      const document: AuxDocument = {
        url: snapshot.url,
        finalUrl: snapshot.finalUrl,
        httpStatus: snapshot.httpStatus,
        redirectChain: [...snapshot.redirectChain],
        headers: { ...snapshot.headers },
        raw: raw.variant,
        rendered: rendered === null ? null : rendered.variant,
        structured,
        meta: buildMeta(primary.doc, snapshot.headers, primary.variant.structured),
        blocks: contentBlocks(primary.body, tokenizer),
        links: countLinks(primary.body, snapshot.finalUrl),
        media: countMedia(primary.body),
        timing: { ttfbMs: snapshot.timing.ttfbMs, loadMs: snapshot.timing.loadMs, bytes: Buffer.byteLength(snapshot.rawHtml) },
        tokenizer: tokenizer.identity,
      };
      span.setAttribute("nominara.aux.parse_errors", raw.variant.structured.parseErrors.length + (rendered?.variant.structured.parseErrors.length ?? 0));
      span.setAttribute("nominara.aux.blocks", document.blocks.length);
      // STORY-050 AC5 - by format and reason, so a surge in one malformation is visible. Labels are closed sets: never a URL, an id or page text.
      for (const e of [...raw.variant.structured.parseErrors, ...(rendered?.variant.structured.parseErrors ?? [])]) {
        incrementCounter("nominara_aux_structured_parse_errors_total", { format: e.format, reason: e.reason });
      }
      // Counts only: no URL, no page text.
      logger.debug({ event: "aux_document_built", blocks: document.blocks.length, parse_errors: structured.parseErrors.length, rendered: rendered !== null });
      return document;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      observeValue("nominara_aux_document_build_duration_ms", performance.now() - started, {});
      span.end();
    }
  });
}
