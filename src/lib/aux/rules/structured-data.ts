import { z } from "zod";
import type { AuxDocument } from "../document-model.js";
import { asArray, clip, entitiesOfType, escapeRegExp, flattenHeadings, isRecord, jsonLdBlocks, jsonLdEntities, markupTypes, normaliseText, present, rawTypesOf, text, typesOf, variantOf, type Entity } from "./helpers.js";
import { defineRule, type RuleHit } from "./types.js";

// structured_data — AUX-R-008..018 (aux-and-geo-analysis.md section 2). They read `doc.structured` (the rendered copy's data when
// there is one, the plain copy's otherwise) and, where the reference compares data to the page, the main text of the same copy.
// Every number and every list below comes from the rule's catalog row.

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const entities = (d: AuxDocument): Entity[] => jsonLdEntities(d.structured.jsonLd);

// --- AUX-R-008 ----------------------------------------------------------------------------------------------------------------

export const jsonLdSyntaxError = defineRule({
  code: "AUX-R-008",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({ min_errors: z.number().int().positive() }),
  evaluate(doc, t) {
    const errors = doc.structured.parseErrors;
    if (errors.length < t.min_errors) return [];
    const first = errors[0]!;
    return [{ severity: "critical", measured: errors.length, threshold: t.min_errors, reason: "jsonld_parse_error", snippet: first.snippet, locator: `jsonld[${String(first.index)}]${first.position === null ? "" : `@${String(first.position)}`}` }];
  },
});

// --- AUX-R-009 ----------------------------------------------------------------------------------------------------------------

export const missingContextOrType = defineRule({
  code: "AUX-R-009",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({ min_blocks: z.number().int().positive() }),
  evaluate(doc, t) {
    const bad: { locator: string; reason: string }[] = [];
    for (const b of jsonLdBlocks(doc.structured.jsonLd)) {
      const nodes = Array.isArray(b.node["@graph"]) ? asArray(b.node["@graph"]).filter(isRecord) : [b.node];
      if (!present(b.node["@context"])) bad.push({ locator: b.locator, reason: "missing_context" });
      else if (nodes.some((n) => rawTypesOf(n).length === 0)) bad.push({ locator: b.locator, reason: "missing_type" });
    }
    if (bad.length < t.min_blocks) return [];
    return [{ severity: "high", measured: bad.length, threshold: t.min_blocks, reason: bad[0]!.reason, snippet: null, locator: bad[0]!.locator }];
  },
});

// --- AUX-R-010 ----------------------------------------------------------------------------------------------------------------

export const noPrimaryEntity = defineRule({
  code: "AUX-R-010",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({ primary_types: z.array(z.string().min(1)).min(1) }),
  evaluate(doc, t) {
    const types = [...entities(doc).flatMap((e) => typesOf(e.node)), ...markupTypes(doc.structured.microdata), ...markupTypes(doc.structured.rdfa)];
    const found = types.filter((x) => t.primary_types.includes(x)).length;
    if (found >= 1) return [];
    return [{ severity: "high", measured: found, threshold: 1, reason: "no_primary_entity", snippet: types.length === 0 ? null : types.slice(0, 5).join(", "), locator: "structured" }];
  },
});

// --- AUX-R-011 ----------------------------------------------------------------------------------------------------------------

export const organizationIncomplete = defineRule({
  code: "AUX-R-011",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({ fields: z.array(z.string().min(1)).min(1), min_missing: z.number().int().positive() }),
  evaluate(doc, t) {
    let worst: { missing: string[]; locator: string } | null = null;
    for (const e of entitiesOfType(entities(doc), ["Organization"])) {
      const missing = t.fields.filter((f) => !present(e.node[f]));
      if (missing.length >= t.min_missing && (worst === null || missing.length > worst.missing.length)) worst = { missing, locator: e.locator };
    }
    if (worst === null) return [];
    return [{ severity: "medium", measured: worst.missing.length, threshold: t.min_missing, reason: "organization_fields_missing", snippet: worst.missing.join(", "), locator: worst.locator }];
  },
});

// --- AUX-R-012 / 013 ----------------------------------------------------------------------------------------------------------

const symbolClass = (symbols: string): string => `[${symbols.replace(/[\\\]^-]/gu, "\\$&")}]`;
const AMOUNT = "\\d[\\d,]*(?:\\.\\d+)?";
const toNumber = (s: string): number => Number(s.replace(/,/gu, ""));

interface Found {
  readonly value: number;
  readonly at: number;
  readonly end: number;
}

/** Every amount the page states as money: a currency symbol before a number, or a currency code after one. */
function amountMatches(body: string, symbols: string, codes: readonly string[]): Found[] {
  const out: Found[] = [];
  const push = (m: RegExpMatchArray): void => {
    const at = m.index ?? 0;
    out.push({ value: toNumber(m[1]!), at, end: at + m[0].length });
  };
  for (const m of body.matchAll(new RegExp(`${symbolClass(symbols)}\\s?(${AMOUNT})`, "gu"))) push(m);
  if (codes.length > 0) for (const m of body.matchAll(new RegExp(`(${AMOUNT})\\s?(?:${codes.map(escapeRegExp).join("|")})\\b`, "giu"))) push(m);
  return out;
}
const amountsIn = (body: string, symbols: string, codes: readonly string[]): number[] => amountMatches(body, symbols, codes).map((f) => f.value);

/** Whether any of `words` appears, as a whole word or phrase, within `window` characters before or after the match ("starts" is not "star"). */
function nearWord(body: string, f: Found, words: readonly string[], window: number): boolean {
  const around = body.slice(Math.max(0, f.at - window), f.end + window);
  return words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(w)}(?![\\p{L}\\p{N}])`, "iu").test(around));
}

const offersOf = (node: Record<string, unknown>): unknown[] => asArray(node["offers"]);
// An AggregateOffer states its price as a range (lowPrice / highPrice); its lowPrice is the price a visitor starts from.
const hasPrice = (o: unknown): boolean =>
  isRecord(o) &&
  (present(o["price"]) || (typesOf(o).includes("AggregateOffer") && present(o["lowPrice"]))) &&
  present(o["priceCurrency"]);

export const offerDataAbsent = defineRule({
  code: "AUX-R-012",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({
    entity_types: z.array(z.string().min(1)).min(1),
    currency_symbols: z.string().min(1),
    currency_codes: z.array(z.string().min(1)),
    price_units: z.array(z.string().min(1)),
  }),
  evaluate(doc, t) {
    const body = variantOf(doc).mainText;
    const lower = body.toLowerCase();
    const talksPricing =
      amountsIn(body, t.currency_symbols, t.currency_codes).length > 0 || t.price_units.some((u) => lower.includes(u.toLowerCase()));
    if (!talksPricing) return [];
    const bad = entitiesOfType(entities(doc), t.entity_types).filter((e) => {
      const offers = offersOf(e.node);
      return offers.length === 0 || offers.some((o) => !hasPrice(o));
    });
    if (bad.length === 0) return [];
    return [{ severity: "high", measured: bad.length, threshold: 1, reason: "offers_incomplete", snippet: text(bad[0]!.node["name"]) ?? null, locator: `${bad[0]!.locator}.offers` }];
  },
});

export const schemaTextContradiction = defineRule({
  code: "AUX-R-013",
  category: "structured_data",
  autoFixable: false,
  thresholds: strict({
    name_entity_types: z.array(z.string().min(1)).min(1),
    currency_symbols: z.string().min(1),
    currency_codes: z.array(z.string().min(1)),
    min_disagreements: z.number().int().positive(),
    price_tolerance: z.number().nonnegative(),
    rating_tolerance: z.number().nonnegative(),
    price_context_words: z.array(z.string().min(1)).min(1),
    rating_scales: z.array(z.number().int().positive()).min(1),
    rating_context_words: z.array(z.string().min(1)).min(1),
    context_window_chars: z.number().int().positive(),
  }),
  evaluate(doc, t) {
    const body = variantOf(doc).mainText;
    const flat = normaliseText(`${body}\n${doc.meta.title ?? ""}`);
    const all = entities(doc);
    const hits: { reason: string; snippet: string; locator: string }[] = [];

    // Only an amount that sits beside a pricing word is a price the page shows ("$2B processed", "Save $500" are not).
    const prices = amountMatches(body, t.currency_symbols, t.currency_codes)
      .filter((f) => nearWord(body, f, t.price_context_words, t.context_window_chars))
      .map((f) => f.value);
    for (const e of all) {
      asArray(e.node["offers"]).forEach((o, i) => {
        if (!isRecord(o) || !present(o["price"])) return;
        const declared = toNumber(String(o["price"]));
        if (Number.isFinite(declared) && prices.length > 0 && !prices.some((p) => Math.abs(p - declared) < t.price_tolerance)) {
          hits.push({ reason: "price", snippet: `schema price ${String(o["price"])}; page prices ${[...new Set(prices)].slice(0, 5).join(", ")}`, locator: `${e.locator}.offers${Array.isArray(e.node["offers"]) ? `[${String(i)}]` : ""}.price` });
        }
      });
    }
    for (const e of entitiesOfType(all, t.name_entity_types)) {
      const name = text(e.node["name"]);
      if (name !== undefined && !flat.includes(normaliseText(name))) hits.push({ reason: "name", snippet: `schema name ${name}`, locator: `${e.locator}.name` });
    }
    for (const e of all) {
      const rating = e.node["aggregateRating"];
      if (!isRecord(rating)) continue;
      const declaredValue = toNumber(String(rating["ratingValue"] ?? ""));
      // "N/5" or "N out of 10", not a date ("3/5/2026": a further "/digits" follows, or a "/" precedes), and with a rating word beside it.
      const scales = t.rating_scales.map(String).join("|");
      const ratingRe = new RegExp(`(?<![\\d./])(\\d+(?:\\.\\d+)?)\\s*(?:\\/|out of)\\s*(?:${scales})\\b(?!\\s*\\/\\s*\\d)`, "giu");
      const shown = [...body.matchAll(ratingRe)]
        .filter((m) => nearWord(body, { value: 0, at: m.index ?? 0, end: (m.index ?? 0) + m[0].length }, t.rating_context_words, t.context_window_chars))
        .map((m) => Number(m[1]));
      if (Number.isFinite(declaredValue) && shown.length > 0 && !shown.some((v) => Math.abs(v - declaredValue) < t.rating_tolerance)) {
        hits.push({ reason: "rating_value", snippet: `schema rating ${String(rating["ratingValue"])}; page ratings ${shown.slice(0, 3).join(", ")}`, locator: `${e.locator}.aggregateRating.ratingValue` });
      }
      const declaredCount = toNumber(String(rating["reviewCount"] ?? ""));
      const counts = [...body.matchAll(/(\d[\d,]*)\s+(?:reviews?|ratings?)\b/giu)].map((m) => toNumber(m[1]!));
      if (Number.isFinite(declaredCount) && counts.length > 0 && !counts.includes(declaredCount)) {
        hits.push({ reason: "review_count", snippet: `schema reviewCount ${String(rating["reviewCount"])}; page counts ${counts.slice(0, 3).join(", ")}`, locator: `${e.locator}.aggregateRating.reviewCount` });
      }
    }
    if (hits.length < t.min_disagreements) return [];
    return [{ severity: "critical", measured: hits.length, threshold: t.min_disagreements, reason: hits[0]!.reason, snippet: hits[0]!.snippet, locator: hits[0]!.locator }];
  },
});

// --- AUX-R-014 ----------------------------------------------------------------------------------------------------------------

export const featureListThin = defineRule({
  code: "AUX-R-014",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({
    entity_types: z.array(z.string().min(1)).min(1),
    min_coverage: z.number().min(0).max(1),
    heading_levels: z.array(z.number().int().min(1).max(6)).min(1),
    non_capability_headings: z.array(z.string()),
  }),
  evaluate(doc, t) {
    const skip = new Set(t.non_capability_headings.map(normaliseText));
    const capability = flattenHeadings(variantOf(doc).headingTree)
      .filter((h) => t.heading_levels.includes(h.level) && !skip.has(normaliseText(h.text)))
      .map((h) => normaliseText(h.text));
    let worst: RuleHit | null = null;
    for (const e of entitiesOfType(entities(doc), t.entity_types)) {
      const items = asArray(e.node["featureList"]).flatMap((v) => (typeof v === "string" ? [normaliseText(v)] : [])).filter((s) => s !== "");
      let hit: RuleHit | null = null;
      if (items.length === 0) {
        hit = { severity: "high", measured: 0, threshold: t.min_coverage, reason: "feature_list_absent", snippet: text(e.node["name"]) ?? null, locator: `${e.locator}.featureList` };
      } else if (capability.length > 0) {
        const covered = capability.filter((h) => items.some((i) => i === h || i.includes(h) || h.includes(i))).length;
        const coverage = covered / capability.length;
        if (coverage < t.min_coverage) {
          hit = { severity: "high", measured: coverage, threshold: t.min_coverage, reason: "feature_list_thin", snippet: capability.filter((h) => !items.some((i) => i === h || i.includes(h) || h.includes(i))).slice(0, 3).join("; "), locator: `${e.locator}.featureList` };
        }
      }
      if (hit !== null && (worst === null || (hit.measured ?? 0) < (worst.measured ?? 0))) worst = hit;
    }
    return worst === null ? [] : [worst];
  },
});

// --- AUX-R-015 ----------------------------------------------------------------------------------------------------------------

const COUNT_KEYS = new Set(["reviewCount", "ratingCount"]);

export const ratingWithoutProvenance = defineRule({
  code: "AUX-R-015",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({ provenance_keys: z.array(z.string().min(1)).min(1) }),
  evaluate(doc, t) {
    const bad = entities(doc).filter((e) => {
      const rating = e.node["aggregateRating"];
      if (!isRecord(rating)) return false;
      // A count of 0 is a count that proves nothing; a source only has to be present.
      return !t.provenance_keys.some((k) => (COUNT_KEYS.has(k) ? Number(rating[k]) > 0 : present(rating[k])));
    });
    if (bad.length === 0) return [];
    return [{ severity: "medium", measured: bad.length, threshold: 1, reason: "rating_without_provenance", snippet: `ratingValue ${String((bad[0]!.node["aggregateRating"] as Record<string, unknown>)["ratingValue"] ?? "")}`, locator: `${bad[0]!.locator}.aggregateRating` }];
  },
});

// --- AUX-R-016 ----------------------------------------------------------------------------------------------------------------

const hostOf = (s: string): string | null => {
  try {
    return new URL(s).hostname.replace(/^www\./u, "");
  } catch {
    return null;
  }
};
const CLASS_NAME = /^[A-Z][A-Za-z0-9]*$/u;

// Partial: no schema.org class/property list is held, so "@type invalid for the property set" is not checked (spec gap: a vocabulary data set).
export const invalidVocabulary = defineRule({
  code: "AUX-R-016",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({ schema_hosts: z.array(z.string().min(1)).min(1), deprecated_properties: z.array(z.string()) }),
  evaluate(doc, t) {
    const hits: { reason: string; snippet: string; locator: string }[] = [];
    for (const b of jsonLdBlocks(doc.structured.jsonLd)) {
      for (const c of asArray(b.node["@context"])) {
        const s = typeof c === "string" ? c : isRecord(c) && typeof c["@vocab"] === "string" ? c["@vocab"] : undefined;
        const host = s === undefined ? null : hostOf(s);
        if (s !== undefined && (host === null || !t.schema_hosts.includes(host))) hits.push({ reason: "non_schema_context", snippet: s, locator: `${b.locator}.@context` });
      }
    }
    for (const e of entities(doc)) {
      for (const raw of rawTypesOf(e.node)) {
        const name = raw.replace(/^(?:https?:\/\/(?:www\.)?schema\.org\/|schema:)/iu, "");
        if (!CLASS_NAME.test(name)) hits.push({ reason: "invalid_type", snippet: raw, locator: `${e.locator}.@type` });
      }
      for (const key of Object.keys(e.node)) if (t.deprecated_properties.includes(key)) hits.push({ reason: "deprecated_property", snippet: key, locator: `${e.locator}.${key}` });
    }
    if (hits.length === 0) return [];
    return [{ severity: "medium", measured: hits.length, threshold: 1, reason: hits[0]!.reason, snippet: hits[0]!.snippet, locator: hits[0]!.locator }];
  },
});

// --- AUX-R-017 ----------------------------------------------------------------------------------------------------------------

// Partial: question headings are those ending in "?"; interrogatives without one and the "Q&A block" arm need a document-model field (spec gap).
export const faqMarkupAbsent = defineRule({
  code: "AUX-R-017",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({ min_headings: z.number().int().positive(), heading_levels: z.array(z.number().int().min(1).max(6)).min(1) }),
  evaluate(doc, t) {
    const questions = flattenHeadings(variantOf(doc).headingTree).filter((h) => t.heading_levels.includes(h.level) && h.text.trim().endsWith("?"));
    if (questions.length < t.min_headings) return [];
    const declared = [...entities(doc).flatMap((e) => typesOf(e.node)), ...markupTypes(doc.structured.microdata), ...markupTypes(doc.structured.rdfa)];
    if (declared.some((x) => x === "FAQPage" || x === "QAPage")) return [];
    return [{ severity: "medium", measured: questions.length, threshold: t.min_headings, reason: "question_headings_without_markup", snippet: questions[0]!.text, locator: "headings" }];
  },
});

// --- AUX-R-018 ----------------------------------------------------------------------------------------------------------------

// Two descriptions disagree when both state a field and the values differ. A description that leaves a field out has not
// contradicted the one that states it, and `https://acme.com/` is `https://acme.com`.
const nameKey = (n: string | undefined): string | undefined => (n === undefined ? undefined : normaliseText(n));
function urlKey(u: string | undefined): string | undefined {
  if (u === undefined) return undefined;
  try {
    const url = new URL(u);
    return `${url.hostname.replace(/^www\./u, "")}${url.port}${url.pathname.replace(/\/+$/u, "")}${url.search}`.toLowerCase();
  } catch {
    return u.trim().toLowerCase().replace(/\/+$/u, "");
  }
}
const differs = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a !== b;

export const duplicateConflictingEntities = defineRule({
  code: "AUX-R-018",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({ min_conflicts: z.number().int().positive() }),
  evaluate(doc, t) {
    const byType = new Map<string, { block: number; name: string | undefined; url: string | undefined; label: string; locator: string }[]>();
    for (const e of entities(doc)) {
      const name = text(e.node["name"]);
      const url = text(e.node["url"]);
      if (name === undefined && url === undefined) continue;
      for (const type of typesOf(e.node)) {
        const list = byType.get(type) ?? [];
        list.push({ block: e.block, name: nameKey(name), url: urlKey(url), label: name ?? url ?? "", locator: e.locator });
        byType.set(type, list);
      }
    }
    const conflicts: { type: string; a: string; b: string; locator: string }[] = [];
    for (const [type, list] of [...byType.entries()].sort(([x], [y]) => x.localeCompare(y))) {
      for (const x of list) {
        const y = list.find((o) => o.block !== x.block && (differs(o.name, x.name) || differs(o.url, x.url)));
        if (y !== undefined) {
          conflicts.push({ type, a: x.label, b: y.label, locator: y.locator });
          break;
        }
      }
    }
    if (conflicts.length < t.min_conflicts) return [];
    return [{ severity: "medium", measured: conflicts.length, threshold: t.min_conflicts, reason: "conflicting_entities", snippet: clip(`${conflicts[0]!.type}: ${conflicts[0]!.a} / ${conflicts[0]!.b}`), locator: conflicts[0]!.locator }];
  },
});
