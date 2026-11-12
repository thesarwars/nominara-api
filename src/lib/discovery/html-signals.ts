import { parse, type DefaultTreeAdapterMap } from "parse5";

// STORY-043 AC10 — what the regex extractor could not read: hero copy, nav structure and logo alt text (product-spec.md §2.1).
//
// parse5 is already a dependency (STORY-050's document model), so this is NOT the "adding a parser is a dependency decision"
// that extract.ts deferred; STORY-049/050 made that decision. extract.ts keeps the <head> tags it reads with single regexes.
//
// PURE and ROOT-DOCUMENT-ONLY. Nothing here fetches. Everything is read from the one document discovery already holds, which
// is why it stays inside public-surface scope (aux-and-geo-analysis.md §1: no reconnaissance of a site nobody has verified).
// Anything not found is ABSENT, never an empty string or a guess.

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export interface ComparisonLink {
  readonly href: string;
  readonly text: string;
}

export interface HtmlSignals {
  readonly heroCopy?: { readonly headline: string; readonly lede?: string };
  /** The brand as the logo's alt text names it, with the word "logo" removed. */
  readonly logoAlt?: string;
  /** Names listed under the nav's Products / Solutions / Platform menu. */
  readonly navProducts?: string[];
  readonly comparisonLinks: ComparisonLink[];
}

const MAX_HEADLINE_CHARS = 200;
const MAX_LEDE_CHARS = 300;
const MIN_LEDE_CHARS = 20;
const MAX_NAV_PRODUCTS = 10;
const MAX_NAV_PRODUCT_WORDS = 6;
const MAX_NAV_PRODUCT_CHARS = 40;
const MAX_LOGO_CHARS = 60;
const MAX_COMPARISON_LINKS = 50;

const NAV_MENU_RE = /^(products?|solutions|platform|software)$/i;
const COMPARISON_RE = /(?:^|[\s/_-])(?:vs\.?|versus|alternatives?|compare|comparison)(?:$|[\s/_-])/i;
const LOGO_WORD_RE = /^\s*(?:logo\s+of\s+|the\s+)?(.*?)\s*[-–—:]?\s*(?:logo|logotype|home(?:page)?)\s*$/i;

const isElement = (node: Node): node is Element => "tagName" in node;
const childrenOf = (node: Node): Node[] => ("childNodes" in node ? (node.childNodes as Node[]) : []);
const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;

function textOf(node: Node): string {
  if ("value" in node && node.nodeName === "#text") return String((node as { value: string }).value);
  // <script>/<style> text is not prose.
  if (isElement(node) && (node.tagName === "script" || node.tagName === "style")) return "";
  return childrenOf(node).map(textOf).join(" ");
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Document-order walk. `inside` is the set of ancestor tag names, so a caller can ignore nav/footer content. */
function walk(node: Node, visit: (el: Element, ancestors: readonly string[]) => void, ancestors: readonly string[] = []): void {
  for (const child of childrenOf(node)) {
    if (!isElement(child)) continue;
    visit(child, ancestors);
    walk(child, visit, [...ancestors, child.tagName]);
  }
}

function descendants(node: Node, tag: string): Element[] {
  const out: Element[] = [];
  walk(node, (el) => {
    if (el.tagName === tag) out.push(el);
  });
  return out;
}

function heroCopy(root: Node): HtmlSignals["heroCopy"] {
  let headline: string | undefined;
  let lede: string | undefined;
  let afterHeadline = false;
  let closed = false;

  walk(root, (el, ancestors) => {
    if (closed) return;
    const chrome = ancestors.includes("nav") || ancestors.includes("footer");
    if (headline === undefined) {
      if (el.tagName === "h1" && !chrome) {
        const text = collapse(textOf(el));
        if (text !== "") {
          headline = text.slice(0, MAX_HEADLINE_CHARS);
          afterHeadline = true;
        }
      }
      return;
    }
    if (!afterHeadline) return;
    // The lede is the first real paragraph BEFORE the next heading; past one it belongs to another section.
    if (/^h[1-6]$/.test(el.tagName)) {
      closed = true;
      return;
    }
    if (el.tagName === "p" && !chrome) {
      const text = collapse(textOf(el));
      if (text.length >= MIN_LEDE_CHARS) {
        lede = text.slice(0, MAX_LEDE_CHARS);
        closed = true;
      }
    }
  });

  if (headline === undefined) return undefined;
  return lede === undefined ? { headline } : { headline, lede };
}

function logoAlt(root: Node): string | undefined {
  for (const img of descendants(root, "img")) {
    const alt = collapse(attr(img, "alt") ?? "");
    if (alt === "") continue;
    const looksLikeLogo = /logo/i.test(`${attr(img, "class") ?? ""} ${attr(img, "id") ?? ""} ${attr(img, "src") ?? ""} ${alt}`);
    if (!looksLikeLogo) continue;
    const brand = collapse(LOGO_WORD_RE.exec(alt)?.[1] ?? alt);
    // `alt="Logo"` strips to nothing: that names no brand.
    if (brand !== "" && !/^logo$/i.test(brand) && brand.length <= MAX_LOGO_CHARS) return brand;
  }
  return undefined;
}

function navProducts(root: Node): string[] | undefined {
  for (const nav of descendants(root, "nav")) {
    for (const item of descendants(nav, "li")) {
      const direct = childrenOf(item).filter(isElement);
      const label = direct.find((el) => el.tagName === "a" || el.tagName === "button" || el.tagName === "span");
      const submenu = direct.find((el) => el.tagName === "ul");
      if (label === undefined || submenu === undefined) continue;
      if (!NAV_MENU_RE.test(collapse(textOf(label)))) continue;

      const names: string[] = [];
      for (const anchor of descendants(submenu, "a")) {
        const name = collapse(textOf(anchor));
        const words = name.split(" ").length;
        if (name === "" || name.length > MAX_NAV_PRODUCT_CHARS || words > MAX_NAV_PRODUCT_WORDS) continue;
        if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
        if (names.length === MAX_NAV_PRODUCTS) break;
      }
      if (names.length > 0) return names;
    }
  }
  return undefined;
}

function comparisonLinks(root: Node): ComparisonLink[] {
  const out: ComparisonLink[] = [];
  for (const anchor of descendants(root, "a")) {
    const href = attr(anchor, "href")?.trim();
    if (href === undefined || href === "" || href.startsWith("#") || /^(?:mailto|tel|javascript):/i.test(href)) continue;
    const text = collapse(textOf(anchor));
    if (!COMPARISON_RE.test(href) && !COMPARISON_RE.test(text)) continue;
    out.push({ href, text });
    if (out.length === MAX_COMPARISON_LINKS) break;
  }
  return out;
}

export function extractHtmlSignals(html: string): HtmlSignals {
  const root = parse(html) as unknown as Node;
  const hero = heroCopy(root);
  const logo = logoAlt(root);
  const products = navProducts(root);
  return {
    ...(hero === undefined ? {} : { heroCopy: hero }),
    ...(logo === undefined ? {} : { logoAlt: logo }),
    ...(products === undefined ? {} : { navProducts: products }),
    comparisonLinks: comparisonLinks(root),
  };
}

/** What a comparison page says about itself, read from its structure only (STORY-190 AC3): never from the URL or the running prose. */
export interface ComparisonPageSignals {
  /** The `<title>` and every h1-h3, as text: where an "X vs Y" pairing is stated. */
  readonly headings: string[];
  /** One entry per table: the text of its header cells (`<th>`), in order. */
  readonly tableHeaders: string[][];
}

const MAX_PAGE_HEADINGS = 60;
const MAX_PAGE_TABLES = 10;
const MAX_TABLE_HEADERS = 12;

export function extractComparisonPageSignals(html: string): ComparisonPageSignals {
  const root = parse(html) as unknown as Node;
  const headings: string[] = [];
  walk(root, (el) => {
    if (headings.length >= MAX_PAGE_HEADINGS) return;
    if (el.tagName === "title" || el.tagName === "h1" || el.tagName === "h2" || el.tagName === "h3") {
      const text = collapse(textOf(el));
      if (text !== "") headings.push(text);
    }
  });
  const tableHeaders: string[][] = [];
  for (const table of descendants(root, "table").slice(0, MAX_PAGE_TABLES)) {
    const cells = descendants(table, "th")
      .slice(0, MAX_TABLE_HEADERS)
      .map((th) => collapse(textOf(th)))
      .filter((t) => t !== "");
    if (cells.length > 0) tableHeaders.push(cells);
  }
  return { headings, tableHeaders };
}
