// STORY-097 · integrations-and-sharing.md §2 — the agency style override.
//
// A PROPERTY ALLOW-LIST, parsed and RE-SERIALISED: what is stored is text this module wrote, never the upload. Three outcomes:
//   refused   url(), @import, generated content, position:fixed, an escape sequence, or an oversize input. The whole save is
//             rejected, naming the construct. These are not "unrecognised": they are the four things the reference forbids.
//   dropped   anything else not on the allow-list (property, selector, at-rule, value). Kept out of the stored text AND
//             reported back, so the agency learns which of its CSS does nothing instead of filing a ticket about it.
//   kept      re-serialised one rule per line.
// Colour properties are allowed here but are NOT contrast-validated (the contrast check judges the four theme colour tokens);
// that gap is recorded in the story evidence for the owner.

export const MAX_CUSTOM_CSS_CHARS = 20_000;

/**
 * The only classes a selector may name. A class is added here only when the client ships the hook on a component the portal
 * renders (the client stream); an unknown class is dropped and reported, never silently kept.
 */
export const DESIGN_SYSTEM_CLASSES: readonly string[] = ["nm-card", "nm-kpi", "nm-heading", "nm-table", "nm-button", "nm-badge", "nm-nav", "nm-chart"];

export interface CssDropped {
  readonly kind: "property" | "value" | "selector" | "at_rule" | "rule";
  /** The offending text (truncated), for the agency to find in its own input. */
  readonly construct: string;
  readonly reason: string;
}
export interface CssRefusal {
  readonly construct: "url()" | "@import" | "content" | "position: fixed" | "escape sequence" | "size";
  readonly message: string;
}
export type CustomCssResult =
  | { readonly ok: true; readonly css: string; readonly dropped: CssDropped[] }
  | { readonly ok: false; readonly refused: CssRefusal[] };

const SIDES = ["top", "right", "bottom", "left"] as const;
const ALLOWED_PROPERTIES: ReadonlySet<string> = new Set([
  "color", "background-color", "border-color", "outline-color", ...SIDES.map((s) => `border-${s}-color`),
  "margin", "padding", "gap", "row-gap", "column-gap", ...SIDES.map((s) => `margin-${s}`), ...SIDES.map((s) => `padding-${s}`),
  "border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius",
  "font-size", "font-weight", "letter-spacing",
  "border", "border-width", "border-style", ...SIDES.flatMap((s) => [`border-${s}`, `border-${s}-width`, `border-${s}-style`]),
]);

const COMPOUND = /^\.([a-z][a-z0-9-]*)(?::(?:hover|focus-visible|focus|active))?$/;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const NUMBER = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|%)?$/;
const KEYWORD = /^[a-z][a-z-]*$/;
const COLOR_FN = /^(?:rgba?|hsla?)\([0-9a-z.,%\s/]+\)$/;
const VAR_FN = /^var\(--[a-z0-9-]+\)$/;
const MAX_VALUE_TOKENS = 6;

const trunc = (s: string): string => (s.length > 80 ? s.slice(0, 80) + "..." : s);

/** Top-level whitespace split that keeps a parenthesised function together. */
function valueTokens(value: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0) return null;
    if (/\s/.test(ch) && depth === 0) {
      if (cur !== "") out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (depth !== 0) return null;
  if (cur !== "") out.push(cur);
  return out;
}

function normaliseValue(value: string): string | null {
  const lowered = value.trim().toLowerCase().replace(/\s*,\s*/g, ",").replace(/\s+/g, " ");
  const tokens = valueTokens(lowered);
  if (tokens === null || tokens.length === 0 || tokens.length > MAX_VALUE_TOKENS) return null;
  for (const t of tokens) {
    if (!(HEX.test(t) || NUMBER.test(t) || KEYWORD.test(t) || COLOR_FN.test(t) || VAR_FN.test(t))) return null;
  }
  return tokens.join(" ");
}

function normaliseSelector(selector: string): string | null {
  const parts = selector.trim().replace(/\s*>\s*/g, " > ").split(/\s+/);
  if (parts.length === 0 || parts.length > 5) return null;
  for (const [i, part] of parts.entries()) {
    if (part === ">") {
      if (i === 0 || i === parts.length - 1 || parts[i - 1] === ">") return null;
      continue;
    }
    const m = COMPOUND.exec(part);
    if (m === null || !DESIGN_SYSTEM_CLASSES.includes(m[1]!)) return null;
  }
  return parts.join(" ");
}

function refusalsIn(text: string): CssRefusal[] {
  const out: CssRefusal[] = [];
  if (/\burl\s*\(/.test(text)) out.push({ construct: "url()", message: "url() is not allowed: no external or inline resource may be referenced" });
  if (/@import\b/.test(text)) out.push({ construct: "@import", message: "@import is not allowed" });
  if (/(?:^|[{;\s])content\s*:/.test(text)) out.push({ construct: "content", message: "generated content (the content property) is not allowed" });
  if (/(?:^|[{;\s])position\s*:\s*fixed\b/.test(text)) out.push({ construct: "position: fixed", message: "position: fixed is not allowed" });
  if (text.includes("\\")) out.push({ construct: "escape sequence", message: "CSS escape sequences are not allowed" });
  return out;
}

/** Index of the `}` closing the block opened at `open`, quotes respected; -1 when it never closes. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function declarations(selectors: string, body: string, dropped: CssDropped[]): string {
  const kept: string[] = [];
  for (const raw of body.split(";")) {
    const decl = raw.trim();
    if (decl === "") continue;
    const colon = decl.indexOf(":");
    if (colon <= 0) {
      dropped.push({ kind: "property", construct: trunc(decl), reason: "not a property: value declaration" });
      continue;
    }
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1);
    if (prop.startsWith("--")) {
      dropped.push({ kind: "property", construct: prop, reason: "custom properties are not allowed in the override" });
    } else if (!ALLOWED_PROPERTIES.has(prop)) {
      dropped.push({ kind: "property", construct: prop, reason: "property is not on the allow-list (colours, spacing, radius, font-size, font-weight, letter-spacing, border)" });
    } else if (/!\s*important/i.test(value)) {
      dropped.push({ kind: "value", construct: prop, reason: "!important is not allowed" });
    } else {
      const v = normaliseValue(value);
      if (v === null) dropped.push({ kind: "value", construct: prop, reason: "value is not recognised for " + prop });
      else kept.push(prop + ":" + v);
    }
  }
  return kept.length === 0 ? "" : selectors + "{" + kept.join(";") + "}";
}

export function sanitiseCustomCss(input: string): CustomCssResult {
  if (input.length > MAX_CUSTOM_CSS_CHARS) {
    return { ok: false, refused: [{ construct: "size", message: "the override is longer than " + String(MAX_CUSTOM_CSS_CHARS) + " characters" }] };
  }
  const text = input.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
  const refused = refusalsIn(text.toLowerCase());
  if (refused.length > 0) return { ok: false, refused };

  const dropped: CssDropped[] = [];
  const rules: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (i >= text.length) break;
    let j = i;
    while (j < text.length && text[j] !== "{" && text[j] !== ";" && text[j] !== "}") j += 1;
    const prelude = text.slice(i, j).trim();
    const stop = text[j];
    if (stop === undefined) {
      if (prelude !== "") dropped.push({ kind: "rule", construct: trunc(prelude), reason: "incomplete rule" });
      break;
    }
    if (stop === ";" || stop === "}") {
      if (prelude !== "") dropped.push(prelude.startsWith("@") ? { kind: "at_rule", construct: trunc(prelude.split(/\s/)[0]!), reason: "at-rules are not allowed" } : { kind: "rule", construct: trunc(prelude), reason: "not a rule" });
      i = j + 1;
      continue;
    }
    const close = closeOf(text, j);
    if (close === -1) {
      dropped.push({ kind: "rule", construct: trunc(prelude), reason: "unterminated block" });
      break;
    }
    const body = text.slice(j + 1, close);
    i = close + 1;
    if (prelude.startsWith("@")) {
      dropped.push({ kind: "at_rule", construct: trunc(prelude.split(/\s|\(/)[0]!), reason: "at-rules are not allowed" });
      continue;
    }
    if (body.includes("{")) {
      dropped.push({ kind: "rule", construct: trunc(prelude), reason: "nested rules are not allowed" });
      continue;
    }
    const keptSelectors: string[] = [];
    for (const sel of prelude.split(",")) {
      const norm = normaliseSelector(sel);
      if (norm === null) dropped.push({ kind: "selector", construct: trunc(sel.trim()), reason: "selector is not a design-system class" });
      else keptSelectors.push(norm);
    }
    if (keptSelectors.length === 0) continue;
    const rule = declarations(keptSelectors.join(", "), body, dropped);
    if (rule !== "") rules.push(rule);
  }
  return { ok: true, css: rules.join("\n"), dropped };
}
