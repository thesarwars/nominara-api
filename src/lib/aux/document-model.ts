import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { toRegistrableDomain } from "../net/registrable-domain.js";
import { observeValue } from "../telemetry/metrics.js";
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

export interface ParseError {
  /**
   * Only JSON-LD has a syntax to get wrong. Microdata and RDFa are read leniently: an orphan `itemprop`, a missing `vocab` and an
   * `itemref` raise no error (and `itemref` properties are not collected). A malformation check for them is a specification gap, not
   * a silent omission — see STORY-050.
   */
  readonly format: "jsonld";
  /** Which copy the broken markup was in. A parse error in the plain copy is a finding even when the rendered copy is clean. */
  readonly variant: "raw" | "rendered";
  /** Ordinal of the offending block among that format's blocks in the document. */
  readonly index: number;
  readonly reason: "invalid_json" | "empty" | "not_object_or_array";
  /** Character offset the JSON parser reported, or null when it did not report one. */
  readonly position: number | null;
  /** The first characters of the block, so the finding can quote it. */
  readonly snippet: string;
}

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
    const fail = (reason: ParseError["reason"], position: number | null): void => {
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
}

const URL_VALUE: Readonly<Record<string, string>> = { audio: "src", embed: "src", iframe: "src", img: "src", source: "src", track: "src", video: "src", a: "href", area: "href", link: "href", object: "data" };

const MICRODATA: ItemSyntax = {
  isScope: (el) => attrOf(el, "itemscope") !== undefined,
  nameOf: (el) => attrOf(el, "itemprop"),
  typeOf: (el) => attrOf(el, "itemtype"),
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

function buildItem(scope: Element, syntax: ItemSyntax): StructuredItem {
  const props = new Map<string, unknown[]>();
  const add = (name: string, value: unknown): void => {
    const list = props.get(name);
    if (list === undefined) props.set(name, [value]);
    else list.push(value);
  };
  const collect = (node: Node): void => {
    for (const child of childrenOf(node)) {
      if (!isElement(child) || INVISIBLE.has(child.tagName)) continue;
      const nameAttr = syntax.nameOf(child);
      const scoped = syntax.isScope(child);
      if (nameAttr !== undefined) {
        const value = scoped ? buildItem(child, syntax) : syntax.valueOf(child);
        for (const n of names(nameAttr)) add(sanitiseText(n), value);
        if (scoped) continue;
      } else if (scoped) {
        continue; // an item of its own, not a property of this one
      }
      collect(child);
    }
  };
  collect(scope);
  const type = syntax.typeOf(scope);
  const vocab = syntax.vocabOf?.(scope);
  return {
    ...(type === undefined ? {} : { type: sanitiseText(type.trim()) }),
    ...(vocab === undefined ? {} : { vocab }),
    properties: Object.fromEntries(props),
  };
}

function extractItems(doc: Node, syntax: ItemSyntax): StructuredItem[] {
  const items: StructuredItem[] = [];
  walk(doc, (el) => {
    if (INVISIBLE.has(el.tagName) && el.tagName !== "head") return false;
    if (syntax.isScope(el) && syntax.nameOf(el) === undefined) {
      items.push(buildItem(el, syntax));
      // Keep walking: a top-level item inside another item's markup is still a top-level item.
    }
    return undefined;
  });
  return items;
}

function extractStructured(doc: Node, variant: "raw" | "rendered"): StructuredData {
  const out: StructuredData = { jsonLd: [], microdata: [], rdfa: [], parseErrors: [] };
  extractJsonLd(doc, variant, out);
  out.microdata = extractItems(doc, MICRODATA);
  out.rdfa = extractItems(doc, RDFA);
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
