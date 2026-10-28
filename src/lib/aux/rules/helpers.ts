import type { AuxDocument, AuxVariant, Heading, StructuredItem } from "../document-model.js";
import { RULE_EVIDENCE_SNIPPET_MAX } from "../../../../contracts/aux/index.js";

// Shared reading of the document model. Nothing here fetches or measures a clock.

/** At most RULE_EVIDENCE_SNIPPET_MAX UTF-16 units, never ending on the first half of a surrogate pair (jsonb rejects an unpaired \ud83d). */
export function clip(s: string): string {
  if (s.length <= RULE_EVIDENCE_SNIPPET_MAX) return s;
  let end = RULE_EVIDENCE_SNIPPET_MAX;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** The rendered copy when there is one, else the plain copy (the document model's own choice for blocks and structured data). */
export const variantOf = (d: AuxDocument): AuxVariant => d.rendered ?? d.raw;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A value that says something: not undefined, null, blank, or empty. `0` and `false` are values. */
export function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.some(present);
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}

export const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

const SCHEMA_PREFIX = /^(?:https?:\/\/(?:www\.)?schema\.org\/|schema:)/iu;

/** The `@type` values of a node, as written. */
export function rawTypesOf(node: Record<string, unknown>): string[] {
  return asArray(node["@type"]).filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim());
}

/** The `@type` values with a schema.org prefix removed (`https://schema.org/Product` -> `Product`). */
export const typesOf = (node: Record<string, unknown>): string[] => rawTypesOf(node).map((t) => t.replace(SCHEMA_PREFIX, ""));

export interface Entity {
  readonly node: Record<string, unknown>;
  /** Index of the top-level JSON-LD block it came from. */
  readonly block: number;
  readonly locator: string;
}

/** The top-level JSON-LD objects (a top-level array is flattened), with the index each has among the document's blocks. */
export function jsonLdBlocks(jsonLd: readonly unknown[]): { block: number; node: Record<string, unknown>; locator: string }[] {
  const out: { block: number; node: Record<string, unknown>; locator: string }[] = [];
  jsonLd.forEach((b, i) => {
    if (Array.isArray(b)) b.forEach((n, j) => { if (isRecord(n)) out.push({ block: i, node: n, locator: `jsonld[${String(i)}][${String(j)}]` }); });
    else if (isRecord(b)) out.push({ block: i, node: b, locator: `jsonld[${String(i)}]` });
  });
  return out;
}

/** Every entity: each top-level object that has a type, and every node of an `@graph`. A bare `{@context, @graph}` wrapper is not one. */
export function jsonLdEntities(jsonLd: readonly unknown[]): Entity[] {
  const out: Entity[] = [];
  for (const b of jsonLdBlocks(jsonLd)) {
    if (rawTypesOf(b.node).length > 0 || !Array.isArray(b.node["@graph"])) out.push({ node: b.node, block: b.block, locator: b.locator });
    asArray(b.node["@graph"]).forEach((n, j) => {
      if (isRecord(n)) out.push({ node: n, block: b.block, locator: `${b.locator}@graph[${String(j)}]` });
    });
  }
  return out;
}

/**
 * Every entity, including those nested under a property of another (`WebPage.mainEntity`, `ItemPage.mainEntity`, `about`,
 * `itemReviewed`): each object value that has a `@type`, found by walking every property (not `@context`, not `@graph`, which
 * jsonLdEntities already lists). A nested entity is located by its property path, `jsonld[0].mainEntity`. A node reached twice
 * is listed once. Use it (with no `follow` set, every property) only where any declaration is a defect wherever it sits (AUX-R-016); where a rule asks "does the page declare X" or checks the thing the page is about; the top-level view
 * stays for the rules that compare two descriptions of one entity (AUX-R-018), and for completeness checks, where a nested
 * reference (a publisher, an author) is a partial entity by design (AUX-R-011).
 */
export function jsonLdEntitiesDeep(jsonLd: readonly unknown[], follow?: ReadonlySet<string>): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown, block: number, locator: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, block, `${locator}[${String(i)}]`));
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    if (rawTypesOf(value).length > 0) out.push({ node: value, block, locator });
    for (const [key, v] of Object.entries(value)) if (key !== "@context" && key !== "@graph" && (follow === undefined || follow.has(key))) walk(v, block, `${locator}.${key}`);
  };
  for (const root of jsonLdEntities(jsonLd)) {
    seen.add(root.node);
    out.push(root);
    for (const [key, v] of Object.entries(root.node)) if (key !== "@context" && key !== "@graph" && (follow === undefined || follow.has(key))) walk(v, root.block, `${root.locator}.${key}`);
  }
  return out;
}

/** The properties through which a page names what it is about. Every other relation (hasVariant, isRelatedTo, isSimilarTo, isAccessoryOrSparePartFor, makesOffer, itemOffered) names another thing. */
const SUBJECT_PROPERTIES: ReadonlySet<string> = new Set(["mainEntity", "mainEntityOfPage", "about", "itemListElement", "item"]);

/** The entities a page is about: the top-level view plus those reached through subject properties only. A variant, a related or similar product, an accessory is not the page subject. */
export const jsonLdSubjectEntities = (jsonLd: readonly unknown[]): Entity[] => jsonLdEntitiesDeep(jsonLd, SUBJECT_PROPERTIES);

export const entitiesOfType = (entities: readonly Entity[], types: readonly string[]): Entity[] =>
  entities.filter((e) => typesOf(e.node).some((t) => types.includes(t)));

/** Types declared by Microdata (`itemtype`) and RDFa (`typeof`), prefix removed. */
export function markupTypes(items: readonly StructuredItem[]): string[] {
  return items.flatMap((i) => (i.type === undefined ? [] : i.type.split(/\s+/u).map((t) => t.replace(/^https?:\/\/(?:www\.)?schema\.org\//iu, "").replace(/^schema:/iu, ""))));
}

export function flattenHeadings(tree: readonly Heading[]): Heading[] {
  const out: Heading[] = [];
  const visit = (hs: readonly Heading[]): void => {
    for (const h of hs) {
      out.push(h);
      visit(h.children);
    }
  };
  visit(tree);
  return out;
}

/** The bar of a presence rule ("at least one"). Not a tunable number: such a rule fires on absence, so there is nothing for the catalog to move. */
export const PRESENCE_THRESHOLD = 1;

/** Code-unit order, which is code-point order for ASCII; localeCompare would depend on the host's ICU locale. */
export const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Text compared for meaning, not typography: NFKC, no trademark signs, straight quotes and dashes, "&" as "and". */
export const foldForComparison = (s: string): string =>
  normaliseText(
    s
      .replace(/[\u2122\u00AE\u00A9]/gu, "")
      .normalize("NFKC")
      .replace(/[\u2018\u2019\u201A\u02BC]/gu, "'")
      .replace(/[\u201C\u201D\u201E]/gu, '"')
      .replace(/[\u2010-\u2015\u2212]/gu, "-")
      .replace(/\s*&\s*/gu, " and "),
  );

export const normaliseText = (s: string): string => s.toLowerCase().replace(/\s+/gu, " ").trim();

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
