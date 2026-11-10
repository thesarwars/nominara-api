import { z } from "zod";
import type { AuxDocument } from "../document-model.js";
import { PRESENCE_THRESHOLD, asArray, byCodePoint, foldForComparison, clip, entitiesOfType, escapeRegExp, flattenHeadings, isRecord, jsonLdBlocks, jsonLdEntities, jsonLdEntitiesDeep, jsonLdDeclaredEntities, jsonLdSubjectEntities, markupTypes, normaliseText, present, rawTypesOf, text, typesOf, variantOf, type Entity } from "./helpers.js";
import { defineRule, type RuleHit } from "./types.js";

// structured_data — AUX-R-008..018 (aux-and-geo-analysis.md section 2). They read `doc.structured` (the rendered copy's data when
// there is one, the plain copy's otherwise) and, where the reference compares data to the page, the main text of the same copy.
// Every number and every list below comes from the rule's catalog row.

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const entities = (d: AuxDocument): Entity[] => jsonLdEntities(d.structured.jsonLd);
/** What the page is about (subject properties only): variants, related products and accessories are other things, not the page's claims. */
const subjectEntities = (d: AuxDocument): Entity[] => jsonLdSubjectEntities(d.structured.jsonLd);
/** What the page declares, at any depth but behind a variant, related product or offer: for "does the page declare X". */
const declaredEntities = (d: AuxDocument): Entity[] => jsonLdDeclaredEntities(d.structured.jsonLd);
/** Every typed object wherever it sits: a malformed vocabulary term is a defect on any entity. */
const everyEntity = (d: AuxDocument): Entity[] => jsonLdEntitiesDeep(d.structured.jsonLd);

// --- AUX-R-008 ----------------------------------------------------------------------------------------------------------------

export const jsonLdSyntaxError = defineRule({
  code: "AUX-R-008",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({ min_errors: z.number().int().positive() }),
  evaluate(doc, t) {
    // `parseErrors` holds the errors of both copies. A block that is broken in the plain copy and still broken after rendering is
    // ONE error, so the copies are folded by block index, position and quoted text; the locator names the copy it was first seen in.
    const seen = new Set<string>();
    // An empty or whitespace-only block is not invalid JSON-LD (owner decision 9); the document model still records it as "empty".
    const errors = doc.structured.parseErrors.filter((e) => {
      if (e.reason === "empty") return false;
      const key = `${String(e.index)}|${String(e.position)}|${e.snippet}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (errors.length < t.min_errors) return [];
    const first = errors[0]!;
    return [{ severity: "critical", measured: errors.length, threshold: t.min_errors, reason: "jsonld_parse_error", snippet: first.snippet, locator: `${first.variant}.jsonld[${String(first.index)}]${first.position === null ? "" : `@${String(first.position)}`}` }];
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
    const types = [...declaredEntities(doc).flatMap((e) => typesOf(e.node)), ...markupTypes(doc.structured.microdata), ...markupTypes(doc.structured.rdfa)];
    const found = types.filter((x) => t.primary_types.includes(x)).length;
    if (found >= 1) return [];
    return [{ severity: "high", measured: found, threshold: PRESENCE_THRESHOLD, reason: "no_primary_entity", snippet: types.length === 0 ? null : types.slice(0, 5).join(", "), locator: "structured" }];
  },
});

// --- AUX-R-011 ----------------------------------------------------------------------------------------------------------------

export const organizationIncomplete = defineRule({
  code: "AUX-R-011",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({ entity_types: z.array(z.string().min(1)).min(1), fields: z.array(z.string().min(1)).min(1), min_missing: z.number().int().positive() }),
  evaluate(doc, t) {
    let worst: { missing: string[]; locator: string } | null = null;
    for (const e of entitiesOfType(entities(doc), t.entity_types)) {
      const missing = t.fields.filter((f) => !present(e.node[f]));
      if (missing.length >= t.min_missing && (worst === null || missing.length > worst.missing.length)) worst = { missing, locator: e.locator };
    }
    if (worst === null) return [];
    return [{ severity: "medium", measured: worst.missing.length, threshold: t.min_missing, reason: "organization_fields_missing", snippet: worst.missing.join(", "), locator: worst.locator }];
  },
});

// --- AUX-R-012 / 013 ----------------------------------------------------------------------------------------------------------

const symbolClass = (symbols: string): string => `[${symbols.replace(/[\\\]^-]/gu, "\\$&")}]`;
// An amount as a page writes it: digits with `.` and `,` between groups. A trailing separator is sentence punctuation, not part of it.
const AMOUNT = "\\d(?:[\\d.,]*\\d)?";
// A schema.org number is written with a `.` decimal point; a stray `,` is a thousands separator.
const toNumber = (s: string): number => Number(s.replace(/,/gu, ""));

/**
 * Every value a page's number can mean. `1,299.00` and `1.299,00` have one reading (the last separator is the decimal point).
 * `29,99` and `29.99` have one (one or two digits after a lone separator are decimals). `1,299` and `1.299` are ambiguous (a
 * thousands group or three decimals), so both readings are returned, and the page agrees with the data under either.
 */
function numberReadings(raw: string): number[] {
  const hasDot = raw.includes(".");
  const hasComma = raw.includes(",");
  const asNumber = (digits: string, decimal: string | null): number => Number(decimal === null ? digits : `${digits}.${decimal}`);
  const clean = (s: string): string => s.replace(/[.,]/gu, "");
  if (!hasDot && !hasComma) return [Number(raw)];
  const readings: number[] = [];
  if (hasDot && hasComma) {
    const at = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
    readings.push(asNumber(clean(raw.slice(0, at)), raw.slice(at + 1)));
  } else {
    const sep = hasDot ? "." : ",";
    const parts = raw.split(sep);
    const last = parts[parts.length - 1]!;
    const grouped = parts.slice(1).every((g) => g.length === 3) && parts[0]!.length <= 3;
    if (parts.length > 2) readings.push(grouped ? Number(parts.join("")) : asNumber(clean(parts.slice(0, -1).join("")), last));
    else if (last.length === 3 && grouped) readings.push(Number(parts.join("")), asNumber(parts[0]!, last));
    else readings.push(asNumber(parts[0]!, last));
  }
  return readings.filter(Number.isFinite);
}

interface Found {
  readonly value: number;
  /** Every reading of the number the page wrote (see numberReadings). */
  readonly readings: readonly number[];
  readonly at: number;
  readonly end: number;
}

/** Every amount the page states as money: a currency symbol before a number, or a currency code after one. */
function amountMatches(body: string, symbols: string, codes: readonly string[]): Found[] {
  const out: Found[] = [];
  const push = (m: RegExpMatchArray): void => {
    const at = m.index ?? 0;
    const readings = numberReadings(m[1]!);
    if (readings.length > 0) out.push({ value: readings[0]!, readings, at, end: at + m[0].length });
  };
  for (const m of body.matchAll(new RegExp(`${symbolClass(symbols)}\\s?(${AMOUNT})`, "gu"))) push(m);
  if (codes.length > 0) for (const m of body.matchAll(new RegExp(`(${AMOUNT})\\s?(?:${codes.map(escapeRegExp).join("|")})\\b`, "giu"))) push(m);
  return out;
}

/** Whether any of `words` appears, as a whole word or phrase, within `window` characters before or after the match ("starts" is not "star"). */
function nearWord(body: string, f: Found, words: readonly string[], window: number): boolean {
  const around = body.slice(Math.max(0, f.at - window), f.end + window);
  return words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(w)}(?![\\p{L}\\p{N}])`, "iu").test(around));
}

/** A free word as a whole word or phrase; "$0" is not "$0.99" and "free" is not "carefree". `text` is already normalised. */
const containsFreeWord = (text: string, word: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(normaliseText(word))}(?![\\p{L}\\p{N}]|[.,]\\d)`, "u").test(text);

/** A price unit ("per user", "/mo") directly after a digit. A bare "per user" is a feature quota as often as a price ("10 GB storage per user" has its digit before the storage, not the unit). */
const unitBesideDigit = (body: string, units: readonly string[]): boolean =>
  units.length > 0 && new RegExp(`\\d\\s?(?:${units.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "iu").test(body);

const offersOf = (node: Record<string, unknown>): unknown[] => asArray(node["offers"]);
// An AggregateOffer states its price as a range (lowPrice / highPrice); its lowPrice is the price a visitor starts from.
// A subscription price is usually marked up as Offer.priceSpecification (a UnitPriceSpecification with its own price + priceCurrency).
const hasPrice = (o: unknown): boolean =>
  isRecord(o) &&
  (((present(o["price"]) || (typesOf(o).includes("AggregateOffer") && present(o["lowPrice"]))) && present(o["priceCurrency"])) ||
    asArray(o["priceSpecification"]).some((s) => isRecord(s) && present(s["price"]) && present(s["priceCurrency"])));

export const offerDataAbsent = defineRule({
  code: "AUX-R-012",
  category: "structured_data",
  autoFixable: true,
  thresholds: strict({
    entity_types: z.array(z.string().min(1)).min(1),
    currency_symbols: z.string().min(1),
    currency_codes: z.array(z.string().min(1)),
    price_units: z.array(z.string().min(1)),
    price_context_words: z.array(z.string().min(1)).min(1),
    context_window_chars: z.number().int().positive(),
  }),
  evaluate(doc, t) {
    const body = variantOf(doc).mainText;
    // Only an amount beside a pricing word is a pricing token ("$2B processed", "Save $500" are not).
    const talksPricing =
      amountMatches(body, t.currency_symbols, t.currency_codes).some((f) => nearWord(body, f, t.price_context_words, t.context_window_chars)) ||
      unitBesideDigit(body, t.price_units);
    if (!talksPricing) return [];
    const bad = entitiesOfType(subjectEntities(doc), t.entity_types).filter((e) => {
      const offers = offersOf(e.node);
      return offers.length === 0 || offers.some((o) => !hasPrice(o));
    });
    if (bad.length === 0) return [];
    return [{ severity: "high", measured: bad.length, threshold: PRESENCE_THRESHOLD, reason: "offers_incomplete", snippet: text(bad[0]!.node["name"]) ?? null, locator: `${bad[0]!.locator}.offers` }];
  },
});

/** The schema name is on the page, ignoring typography; a variant or pack suffix after a comma ("Acme Widget Pro, 12-pack") need not be shown. */
function nameShown(flat: string, name: string): boolean {
  const full = foldForComparison(name);
  if (flat.includes(full)) return true;
  const lead = foldForComparison(name.split(",")[0]!);
  return name.includes(",") && lead.length >= 3 && flat.includes(lead);
}

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
    free_words: z.array(z.string().min(1)).min(1),
    article_types: z.array(z.string().min(1)).min(1),
  }),
  evaluate(doc, t) {
    const body = variantOf(doc).mainText;
    const flat = foldForComparison(`${body}\n${doc.meta.title ?? ""}`);
    // The thing the page is about is often nested (WebPage > mainEntity > Product), so this reads the subject view, as AUX-R-012 does.
    const all = subjectEntities(doc);
    const hits: { reason: string; snippet: string; locator: string }[] = [];

    // Only an amount that sits beside a pricing word is a price the page shows ("$2B processed", "Save $500" are not).
    const prices = amountMatches(body, t.currency_symbols, t.currency_codes)
      .filter((f) => nearWord(body, f, t.price_context_words, t.context_window_chars))
      .map((f) => f.readings);
    // STORY-187: price and rating are judged only for the page's own subject. A product reached through mainEntity / mainEntityOfPage /
    // about is that; otherwise, on a page that is not an article, the top-level entities are; on an article (a site-wide product block
    // on a blog post) nothing is, because that block is not what the post is about. A listing's items are never the subject.
    const pageIsArticle = jsonLdEntities(doc.structured.jsonLd).some((e) => typesOf(e.node).some((x) => t.article_types.includes(x)));
    // "Reached" means reached from the page's own WebPage / Article node (a root whose type is an article type or ends in "Page"):
    // a FAQPage's Questions or a WebPage.about Thing are not the page's product, so only a reached entity that carries offers, variants
    // or a rating displaces the top-level rule. Otherwise price and rating are judged on the one top-level subject-typed entity.
    const rootNodes = new Map(jsonLdEntities(doc.structured.jsonLd).map((r) => [r.locator, r.node]));
    const reachedFromPage = (e: Entity): boolean => {
      const m = /^([^.]+)\.(?:mainEntity|mainEntityOfPage|about)(?![\p{L}\p{N}])/u.exec(e.locator);
      const root = m === null ? undefined : rootNodes.get(m[1]!);
      return root !== undefined && typesOf(root).some((x) => t.article_types.includes(x) || /Page$/u.test(x));
    };
    const carriesCommerce = (e: Entity): boolean => present(e.node["offers"]) || present(e.node["hasVariant"]) || present(e.node["aggregateRating"]);
    const notListed = all.filter((e) => !e.locator.includes(".itemListElement"));
    const qualifying = notListed.filter((e) => reachedFromPage(e) && carriesCommerce(e));
    // A ProductGroup is the subject of its variants' prices though it is not a name-checked type.
    const topSubjects = notListed.filter((e) => !e.locator.includes(".") && (entitiesOfType([e], t.name_entity_types).length > 0 || present(e.node["hasVariant"])));
    const subjects = qualifying.length > 0 ? qualifying : pageIsArticle || topSubjects.length !== 1 ? [] : topSubjects;
    for (const e of subjects) {
      // An offer set (tiers, per-variant offers) agrees with the page when ANY member is shown; only a set of which none is shown is
      // one disagreement. A free tier is usually written as a word ("Free forever"), not as an amount: a declared 0 agrees with that.
      const members = asArray(e.node["offers"])
        .flatMap((o, i) => (isRecord(o) && present(o["price"]) ? [{ declared: toNumber(String(o["price"])), raw: String(o["price"]), i }] : []))
        .filter((m) => Number.isFinite(m.declared));
      if (members.length === 0 || prices.length === 0) continue;
      const agrees = members.some((m) => (m.declared === 0 && t.free_words.some((w) => containsFreeWord(flat, w))) || prices.some((rs) => rs.some((p) => Math.abs(p - m.declared) < t.price_tolerance)));
      if (!agrees) {
        const first = members[0]!;
        hits.push({ reason: "price", snippet: `schema price ${members.map((m) => m.raw).slice(0, 5).join(", ")}; page prices ${[...new Set(prices.map((rs) => rs[0]!))].slice(0, 5).join(", ")}`, locator: `${e.locator}.offers${Array.isArray(e.node["offers"]) ? `[${String(first.i)}]` : ""}.price` });
      }
    }
    // A ProductGroup carries no offers of its own: its variants do. The variant set agrees with the page when any variant's price is shown;
    // only a set of which none is shown is one disagreement (variant names are not compared).
    for (const e of subjects) {
      const variantPrices = asArray(e.node["hasVariant"]).flatMap((v) => (isRecord(v) ? asArray(v["offers"]) : [])).flatMap((o) => (isRecord(o) && present(o["price"]) ? [toNumber(String(o["price"]))] : [])).filter((n) => Number.isFinite(n));
      if (variantPrices.length === 0 || prices.length === 0 || e.locator.includes(".itemListElement")) continue;
      if (!variantPrices.some((v) => prices.some((rs) => rs.some((p) => Math.abs(p - v) < t.price_tolerance)))) {
        hits.push({ reason: "price", snippet: `schema variant prices ${variantPrices.slice(0, 5).join(", ")}; page prices ${[...new Set(prices.map((rs) => rs[0]!))].slice(0, 5).join(", ")}`, locator: `${e.locator}.hasVariant` });
      }
    }
    // A name disagrees only for the thing the page is about. A product reached through mainEntity / about is that; failing that, the
    // page's one top-level product is, unless the page is an article (a site-wide SoftwareApplication block on a blog post is not its
    // subject). Anything else, and a listing's items, is a name the page need not show: absence is not disagreement.
    const named = entitiesOfType(all, t.name_entity_types).filter((e) => !e.locator.includes(".itemListElement"));
    const reached = named.filter(reachedFromPage);
    const topLevel = named.filter((e) => !e.locator.includes("."));
    const aboutPage = reached.length > 0 ? reached : topLevel.length === 1 && !pageIsArticle ? topLevel : [];
    for (const e of aboutPage) {
      const name = text(e.node["name"]);
      if (name !== undefined && !nameShown(flat, name)) hits.push({ reason: "name", snippet: `schema name ${name}`, locator: `${e.locator}.name` });
    }
    for (const e of subjects) {
      const rating = e.node["aggregateRating"];
      if (!isRecord(rating) || e.locator.includes(".itemListElement")) continue;
      // A field the data leaves out has not contradicted the page: Number("") is 0, so an absent or blank one is skipped, not compared.
      const declaredValue = present(rating["ratingValue"]) ? toNumber(String(rating["ratingValue"])) : Number.NaN;
      // "N/5" or "N out of 10", not a date ("3/5/2026": a further "/digits" follows, or a "/" precedes), and with a rating word beside it.
      const scales = t.rating_scales.map(String).join("|");
      const ratingRe = new RegExp(`(?<![\\d./])(\\d+(?:\\.\\d+)?)\\s*(?:\\/|out of)\\s*(?:${scales})\\b(?!\\s*\\/\\s*\\d)`, "giu");
      const shown = [...body.matchAll(ratingRe)]
        .filter((m) => nearWord(body, { value: 0, readings: [0], at: m.index ?? 0, end: (m.index ?? 0) + m[0].length }, t.rating_context_words, t.context_window_chars))
        .map((m) => Number(m[1]));
      if (Number.isFinite(declaredValue) && shown.length > 0 && !shown.some((v) => Math.abs(v - declaredValue) < t.rating_tolerance)) {
        hits.push({ reason: "rating_value", snippet: `schema rating ${String(rating["ratingValue"])}; page ratings ${shown.slice(0, 3).join(", ")}`, locator: `${e.locator}.aggregateRating.ratingValue` });
      }
      const declaredCount = present(rating["reviewCount"]) ? toNumber(String(rating["reviewCount"])) : Number.NaN;
      // A count the page rounds or leaves open ("2,000+", "over 2,000", "2k", "about 2,000") is not a different count from the data's.
      const counts = [...body.matchAll(/(?<approx>\b(?:over|more than|above|under|fewer than|less than|nearly|almost|about|around|approximately|approx\.?)\s+|~\s*)?(?<n>\d(?:[\d.,]*\d)?)(?<open>\s?(?:\+|[kKmM](?![\p{L}\p{N}])))?\s+(?:reviews?|ratings?)\b/giu)]
        .filter((m) => m.groups?.["approx"] === undefined && m.groups?.["open"] === undefined)
        .map((m) => numberReadings(m.groups!["n"]!).flatMap((r) => (Number.isInteger(r) ? [r] : [])));
      if (Number.isFinite(declaredCount) && counts.length > 0 && !counts.some((rs) => rs.includes(declaredCount))) {
        hits.push({ reason: "review_count", snippet: `schema reviewCount ${String(rating["reviewCount"])}; page counts ${counts.slice(0, 3).map((rs) => rs.join("/")).join(", ")}`, locator: `${e.locator}.aggregateRating.reviewCount` });
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
    // An item covers a heading when one holds the other as whole words: "ai" is not in "detailed reports".
    const holds = (long: string, short: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(short)}(?![\\p{L}\\p{N}])`, "u").test(long);
    const covers = (i: string, h: string): boolean => i === h || holds(i, h) || holds(h, i);
    const capability = flattenHeadings(variantOf(doc).headingTree)
      .filter((h) => t.heading_levels.includes(h.level) && !skip.has(normaliseText(h.text)))
      .map((h) => normaliseText(h.text));
    let worst: RuleHit | null = null;
    for (const e of entitiesOfType(subjectEntities(doc), t.entity_types)) {
      const items = asArray(e.node["featureList"]).flatMap((v) => (typeof v === "string" ? [normaliseText(v)] : [])).filter((s) => s !== "");
      let hit: RuleHit | null = null;
      if (items.length === 0) {
        hit = { severity: "high", measured: 0, threshold: t.min_coverage, reason: "feature_list_absent", snippet: text(e.node["name"]) ?? null, locator: `${e.locator}.featureList` };
      } else if (capability.length > 0) {
        const covered = capability.filter((h) => items.some((i) => covers(i, h))).length;
        const coverage = covered / capability.length;
        if (coverage < t.min_coverage) {
          hit = { severity: "high", measured: coverage, threshold: t.min_coverage, reason: "feature_list_thin", snippet: capability.filter((h) => !items.some((i) => covers(i, h))).slice(0, 3).join("; "), locator: `${e.locator}.featureList` };
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
    const bad = subjectEntities(doc).filter((e) => {
      const rating = e.node["aggregateRating"];
      if (!isRecord(rating)) return false;
      // A count of 0 is a count that proves nothing; a source only has to be present.
      return !t.provenance_keys.some((k) => (COUNT_KEYS.has(k) ? Number(rating[k]) > 0 : present(rating[k])));
    });
    if (bad.length === 0) return [];
    return [{ severity: "medium", measured: bad.length, threshold: PRESENCE_THRESHOLD, reason: "rating_without_provenance", snippet: `ratingValue ${String((bad[0]!.node["aggregateRating"] as Record<string, unknown>)["ratingValue"] ?? "")}`, locator: `${bad[0]!.locator}.aggregateRating` }];
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
    // Nested entities (mainEntity, offers, author) are checked too; the @context check above is per block.
    for (const e of everyEntity(doc)) {
      for (const raw of rawTypesOf(e.node)) {
        const name = raw.replace(/^(?:https?:\/\/(?:www\.)?schema\.org\/|schema:)/iu, "");
        if (!CLASS_NAME.test(name)) hits.push({ reason: "invalid_type", snippet: raw, locator: `${e.locator}.@type` });
      }
      for (const key of Object.keys(e.node)) if (t.deprecated_properties.includes(key)) hits.push({ reason: "deprecated_property", snippet: key, locator: `${e.locator}.${key}` });
    }
    if (hits.length === 0) return [];
    return [{ severity: "medium", measured: hits.length, threshold: PRESENCE_THRESHOLD, reason: hits[0]!.reason, snippet: hits[0]!.snippet, locator: hits[0]!.locator }];
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
    const declared = [...declaredEntities(doc).flatMap((e) => typesOf(e.node)), ...markupTypes(doc.structured.microdata), ...markupTypes(doc.structured.rdfa)];
    if (declared.some((x) => x === "FAQPage" || x === "QAPage")) return [];
    return [{ severity: "medium", measured: questions.length, threshold: t.min_headings, reason: "question_headings_without_markup", snippet: questions[0]!.text, locator: "headings" }];
  },
});

// --- AUX-R-018 ----------------------------------------------------------------------------------------------------------------

// Only a type a page describes ONCE can be described twice (catalog `singleton_types`). Two entities that both carry an @id and differ
// in it are two entities, not one described two ways. Two descriptions disagree when both state a field and the values differ. A description that leaves a field out has not
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
  thresholds: strict({ min_conflicts: z.number().int().positive(), singleton_types: z.array(z.string().min(1)).min(1) }),
  evaluate(doc, t) {
    const byType = new Map<string, { block: number; id: string | undefined; name: string | undefined; url: string | undefined; label: string; locator: string }[]>();
    for (const e of entities(doc)) {
      const name = text(e.node["name"]);
      const url = text(e.node["url"]);
      if (name === undefined && url === undefined) continue;
      const id = text(e.node["@id"]);
      for (const type of typesOf(e.node).filter((x) => t.singleton_types.includes(x))) {
        const list = byType.get(type) ?? [];
        list.push({ block: e.block, id, name: nameKey(name), url: urlKey(url), label: name ?? url ?? "", locator: e.locator });
        byType.set(type, list);
      }
    }
    const conflicts: { type: string; a: string; b: string; locator: string }[] = [];
    for (const [type, list] of [...byType.entries()].sort(([x], [y]) => byCodePoint(x, y))) {
      for (const x of list) {
        const y = list.find((o) => o.block !== x.block && !differs(o.id, x.id) && (differs(o.name, x.name) || differs(o.url, x.url)));
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
