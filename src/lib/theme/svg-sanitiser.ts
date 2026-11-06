// STORY-097 · integrations-and-sharing.md §2 — vector logos are sanitised and RE-SERIALISED.
//
// The stored file is the document this module WRITES from an allow-list of elements and attributes; no byte of the upload is
// copied through. That is the difference between sanitising and appearing to: a parser difference between a blacklist and the
// browser cannot matter when the browser only ever sees our own output.
//
// Two outcomes for what is not allowed:
//   refused   script, foreignObject, an external reference (a link or url() leaving the document), a DOCTYPE/entity, a malformed
//             document. The whole asset is rejected, naming the construct.
//   stripped  everything else that is merely not on the allow-list (event-handler attributes, style, metadata, foreign-namespace
//             editor data). Left out of the output and listed, so the agency knows what changed.

export interface SvgConstruct {
  readonly construct: string;
  readonly message: string;
}
export type SvgResult =
  | { readonly ok: true; readonly svg: string; readonly width: number; readonly height: number; readonly stripped: SvgConstruct[] }
  | { readonly ok: false; readonly refused: SvgConstruct[] };

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const MAX_ELEMENTS = 5000;
const MAX_DEPTH = 64;

const ELEMENTS: ReadonlySet<string> = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "lineargradient", "radialgradient", "stop",
  "clippath", "mask", "title", "desc", "text", "tspan", "symbol", "use",
]);
const CANONICAL: Readonly<Record<string, string>> = { lineargradient: "linearGradient", radialgradient: "radialGradient", clippath: "clipPath" };
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(["title", "desc", "text", "tspan"]);
const ATTRIBUTES: ReadonlySet<string> = new Set([
  "id", "class", "d", "x", "y", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2", "width", "height", "viewBox", "points", "transform",
  "fill", "fill-opacity", "fill-rule", "clip-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "offset", "stop-color", "stop-opacity", "gradientUnits",
  "gradientTransform", "clipPathUnits", "maskUnits", "preserveAspectRatio", "font-size", "font-weight", "text-anchor", "dx", "dy",
  "clip-path", "mask", "href", "xlink:href", "xmlns", "xmlns:xlink", "version",
]);
const REFERENCE_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "xlink:href"]);
const MISSING = (c: string, m: string): SvgConstruct => ({ construct: c, message: m });

interface Node {
  readonly name: string;
  readonly attrs: [string, string][];
  readonly children: (Node | string)[];
}

function decode(raw: string, refused: SvgConstruct[]): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (_m, ref: string) => {
    if (ref === "amp") return "&";
    if (ref === "lt") return "<";
    if (ref === "gt") return ">";
    if (ref === "quot") return '"';
    if (ref === "apos") return "'";
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      if (Number.isInteger(code) && code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
      refused.push(MISSING("entity reference", "a numeric character reference is out of range"));
      return "";
    }
    refused.push(MISSING("entity reference", "entity &" + ref + "; is not allowed (only the five predefined entities)"));
    return "";
  });
}
const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");

const TAG = /<\/?([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parse(text: string, refused: SvgConstruct[]): Node | null {
  const root: Node = { name: "#root", attrs: [], children: [] };
  const stack: Node[] = [root];
  let elements = 0;
  let i = 0;
  const malformed = (): null => {
    refused.push(MISSING("malformed document", "the file is not well-formed SVG"));
    return null;
  };
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt === -1) {
      top.children.push(text.slice(i));
      break;
    }
    if (lt > i) top.children.push(text.slice(i, lt));
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) return malformed();
      i = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt);
      if (end === -1) return malformed();
      top.children.push("\u0000" + text.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      refused.push(MISSING("DOCTYPE declaration", "DOCTYPE and entity declarations are not allowed"));
      return null;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt);
      if (end === -1) return malformed();
      i = end + 2;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(text);
    if (m === null) return malformed();
    const name = m[1]!;
    i = lt + m[0].length;
    if (m[0].startsWith("</")) {
      if (stack.length < 2 || stack[stack.length - 1]!.name !== name) return malformed();
      stack.pop();
      continue;
    }
    elements += 1;
    if (elements > MAX_ELEMENTS || stack.length > MAX_DEPTH) {
      refused.push(MISSING("complexity", "the file has more than " + String(MAX_ELEMENTS) + " elements or nests deeper than " + String(MAX_DEPTH)));
      return null;
    }
    const attrs: [string, string][] = [];
    for (const a of m[2]!.matchAll(ATTR)) attrs.push([a[1]!, decode(a[2] ?? a[3] ?? "", refused)]);
    const node: Node = { name, attrs, children: [] };
    top.children.push(node);
    if (m[3] !== "/") stack.push(node);
  }
  if (stack.length !== 1) return malformed();
  return root;
}

const EXTERNAL_URL = /url\(\s*(['"]?)\s*(?!#)/i;
const SCRIPTY = /^\s*(?:javascript|data|vbscript):/i;

function serialise(node: Node, stripped: SvgConstruct[], refused: SvgConstruct[], isRoot: boolean): string {
  const lower = node.name.toLowerCase();
  if (lower === "script") {
    refused.push(MISSING("script element", "a script element is not allowed in a logo"));
    return "";
  }
  if (lower === "foreignobject") {
    refused.push(MISSING("foreignObject element", "a foreignObject element is not allowed in a logo"));
    return "";
  }
  if (node.name.includes(":") || !ELEMENTS.has(lower) || node.name !== node.name.trim()) {
    stripped.push(MISSING(node.name + " element", "element is not on the allow-list; it and its content were removed"));
    // Removed, but still inspected: a link or a script hidden under an element we drop is still a construct the agency must hear about.
    for (const [attr, value] of node.attrs) {
      if (REFERENCE_ATTRIBUTES.has(attr) && !value.startsWith("#")) refused.push(MISSING("external reference", attr + " points outside the document"));
    }
    for (const c of node.children) if (typeof c !== "string") serialise(c, [], refused, false);
    return "";
  }
  const name = CANONICAL[lower] ?? lower;
  const attrs: string[] = [];
  for (const [attr, value] of node.attrs) {
    if (/^on/i.test(attr)) {
      stripped.push(MISSING(attr + " attribute", "event-handler attributes are removed"));
      continue;
    }
    if (REFERENCE_ATTRIBUTES.has(attr)) {
      if (!value.startsWith("#")) {
        refused.push(MISSING("external reference", attr + " points outside the document"));
        continue;
      }
    } else if (SCRIPTY.test(value)) {
      refused.push(MISSING("external reference", attr + " holds a script or data URL"));
      continue;
    }
    if (EXTERNAL_URL.test(value)) {
      refused.push(MISSING("external reference", attr + " holds a url() that leaves the document"));
      continue;
    }
    if (attr === "xmlns" || attr === "xmlns:xlink") {
      if (value !== (attr === "xmlns" ? SVG_NS : XLINK_NS)) stripped.push(MISSING(attr + " attribute", "unexpected namespace value"));
      continue; // re-emitted by the serialiser, never copied
    }
    if (!ATTRIBUTES.has(attr)) {
      stripped.push(MISSING(attr + " attribute", "attribute is not on the allow-list"));
      continue;
    }
    attrs.push(attr + '="' + escapeAttr(value) + '"');
  }
  const open = isRoot ? ["xmlns=\"" + SVG_NS + '"', ...(node.attrs.some(([a]) => a === "xmlns:xlink") || node.attrs.some(([a]) => a === "xlink:href") ? ['xmlns:xlink="' + XLINK_NS + '"'] : [])] : [];
  const head = "<" + name + [...open, ...attrs].map((a) => " " + a).join("");
  const inner = node.children
    .map((c) => {
      if (typeof c === "string") {
        if (!TEXT_ELEMENTS.has(name)) return "";
        return c.startsWith("\u0000") ? escapeText(c.slice(1)) : escapeText(decode(c, refused));
      }
      return serialise(c, stripped, refused, false);
    })
    .join("");
  return inner === "" ? head + "/>" : head + ">" + inner + "</" + name + ">";
}

function dimension(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(v);
  return m === null ? null : Number(m[1]);
}

export function sanitiseSvg(bytes: Uint8Array): SvgResult {
  const refused: SvgConstruct[] = [];
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, refused: [MISSING("malformed document", "the file is not valid UTF-8")] };
  }
  const root = parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, refused);
  if (root === null) return { ok: false, refused: dedupe(refused) };
  const elements = root.children.filter((c): c is Node => typeof c !== "string");
  const svg = elements[0];
  if (elements.length !== 1 || svg === undefined || root.children.some((c) => typeof c === "string" && c.trim() !== "")) {
    return { ok: false, refused: [MISSING("malformed document", "the file must hold exactly one svg element")] };
  }
  if (svg.name.toLowerCase() !== "svg") return { ok: false, refused: [MISSING("root element is not svg", "the root element must be svg")] };
  if (svg.attrs.find(([a]) => a === "xmlns")?.[1] !== SVG_NS) return { ok: false, refused: [MISSING("missing svg namespace", "the svg element must declare " + SVG_NS)] };

  const attr = (n: string): string | undefined => svg.attrs.find(([a]) => a === n)?.[1];
  let width = dimension(attr("width"));
  let height = dimension(attr("height"));
  if (width === null || height === null) {
    const vb = /^\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*$/.exec(attr("viewBox") ?? "");
    if (vb !== null) {
      width = width ?? Number(vb[1]);
      height = height ?? Number(vb[2]);
    }
  }
  if (width === null || height === null || width <= 0 || height <= 0) return { ok: false, refused: [MISSING("no dimensions", "the svg needs a viewBox or a width and height")] };

  const stripped: SvgConstruct[] = [];
  const out = serialise(svg, stripped, refused, true);
  if (refused.length > 0) return { ok: false, refused: dedupe(refused) };
  return { ok: true, svg: out, width: Math.round(width), height: Math.round(height), stripped: dedupe(stripped) };
}

function dedupe(list: SvgConstruct[]): SvgConstruct[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.construct) ? false : (seen.add(c.construct), true)));
}
