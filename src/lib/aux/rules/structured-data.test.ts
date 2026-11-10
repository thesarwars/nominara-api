import { describe, expect, it } from "vitest";
import { CLEAN_JSON_LD, CLEAN_TEXT, makeDoc, variant } from "../../../../test/support/aux-document.js";
import { evaluatorFindings as findings, withThresholds } from "../../../../test/support/aux-rules.js";

// STORY-051 — the structured_data rules, AUX-R-008..018, and AUX-R-006 (crawler directive). Each rule is a threshold, so each is
// tested at, below and above it (AC4), and from the hazard the rule exists for.

const org = CLEAN_JSON_LD[0] as Record<string, unknown>;
const app = CLEAN_JSON_LD[1] as Record<string, unknown>;
const withLd = (jsonLd: unknown[], over: Partial<ReturnType<typeof variant>> = {}) => makeDoc({ raw: variant({ structured: { jsonLd, microdata: [], rdfa: [], parseErrors: [] }, ...over }) });
const withApp = (patch: Record<string, unknown>, over: Partial<ReturnType<typeof variant>> = {}) => withLd([org, { ...app, ...patch }], over);
const withoutKey = (o: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
/** The page's own subject: a WebPage whose mainEntity is the app. */
const reachedApp = (patch: Record<string, unknown>) => ({ "@context": "https://schema.org", "@type": "WebPage", mainEntity: { ...withoutKey(app, "@context"), ...patch } });
const textWith = (extra: string) => ({ mainText: `${CLEAN_TEXT}\n${extra}` });

describe("STORY-051 AUX-R-006 · noai / noimageai / noarchive", () => {
  it("STORY-051 AUX-R-006 · no directive: no finding (below)", async () => {
    expect(await findings(makeDoc(), "AUX-R-006")).toEqual([]);
  });
  it("STORY-051 AUX-R-006 · one matching directive fires high at the threshold (1)", async () => {
    const doc = makeDoc({ meta: { ...makeDoc().meta, directives: ["noindex", "noai"], robots: "noai" } });
    const [f] = await findings(doc, "AUX-R-006");
    expect(f).toMatchObject({ severity: "high", measured_value: 1, threshold_value: 1, rule_version: "2026.10.2", auto_fixable: true, guidance: null });
    expect(f!.evidence).toMatchObject({ reason: "directive", snippet: "noai", locator: "meta.robots" });
  });
  it("STORY-051 AUX-R-006 · two directives measure 2; a directive that is not on the list does not count", async () => {
    const two = makeDoc({ meta: { ...makeDoc().meta, directives: ["noarchive", "noimageai"] } });
    expect((await findings(two, "AUX-R-006"))[0]!.measured_value).toBe(2);
    expect(await findings(makeDoc({ meta: { ...makeDoc().meta, directives: ["nofollow", "noindex", "nosnippet"] } }), "AUX-R-006")).toEqual([]);
  });
  it("STORY-051 AUX-R-006 · a directive that arrived in X-Robots-Tag is located in the header", async () => {
    const doc = makeDoc({ headers: { "x-robots-tag": "noarchive" }, meta: { ...makeDoc().meta, directives: ["noarchive"] } });
    expect((await findings(doc, "AUX-R-006"))[0]!.evidence.locator).toBe("headers.x-robots-tag");
  });
});

describe("STORY-051 AUX-R-008 · JSON-LD syntax error", () => {
  const err = (index: number, variantName: "raw" | "rendered" = "raw") => ({ format: "jsonld" as const, variant: variantName, index, reason: "invalid_json" as const, position: 12, snippet: '{"@type": "Org' });
  it("STORY-051 AUX-R-008 · no parse error: no finding", async () => {
    expect(await findings(makeDoc(), "AUX-R-008")).toEqual([]);
  });
  it("STORY-051 AUX-R-008 · one error fires critical at the threshold (1), quoting the block", async () => {
    const doc = makeDoc({ raw: variant({ structured: { jsonLd: [], microdata: [], rdfa: [], parseErrors: [err(0)] } }) });
    const [f] = await findings(doc, "AUX-R-008");
    expect(f).toMatchObject({ severity: "critical", measured_value: 1, threshold_value: 1 });
    expect(f!.evidence).toMatchObject({ snippet: '{"@type": "Org', locator: "raw.jsonld[0]@12" });
  });
  it("STORY-051 AUX-R-008 · two errors measure 2; the error in the plain copy only is still a finding", async () => {
    const raw = variant({ structured: { jsonLd: [], microdata: [], rdfa: [], parseErrors: [err(0), err(1, "rendered")] } });
    expect((await findings(makeDoc({ raw }), "AUX-R-008"))[0]!.measured_value).toBe(2);
    const rawOnly = makeDoc({ raw: variant({ structured: { jsonLd: [], microdata: [], rdfa: [], parseErrors: [] } }), rendered: variant() });
    const withError = { ...rawOnly, structured: { ...rawOnly.structured, parseErrors: [err(0)] } };
    expect(await findings(withError, "AUX-R-008")).toHaveLength(1);
  });
});

describe("STORY-051 AUX-R-008 · an empty block is not a syntax error (owner decision 9)", () => {
  const base = { format: "jsonld" as const, variant: "raw" as const, position: null };
  const empty = (index: number) => ({ ...base, index, reason: "empty" as const, snippet: "" });
  const docWith = (parseErrors: ReturnType<typeof empty>[]) => makeDoc({ raw: variant({ structured: { jsonLd: [], microdata: [], rdfa: [], parseErrors } }) });
  it("STORY-051 AUX-R-008 · an empty or whitespace-only ld+json script raises no finding", async () => {
    expect(await findings(docWith([empty(0)]), "AUX-R-008")).toEqual([]);
  });
  it("STORY-051 AUX-R-008 · an empty block beside a non-empty unparsable one still fires critical, counting only the unparsable one", async () => {
    const bad = { ...base, index: 1, reason: "invalid_json" as const, position: 3, snippet: "{oops" };
    const [f] = await findings(docWith([empty(0), bad as never]), "AUX-R-008");
    expect(f).toMatchObject({ severity: "critical", measured_value: 1 });
    expect(f!.evidence.locator).toBe("raw.jsonld[1]@3");
  });
});

describe("STORY-051 AUX-R-008 · one broken block seen in both copies", () => {
  const err = (variantName: "raw" | "rendered", index = 0) => ({ format: "jsonld" as const, variant: variantName, index, reason: "invalid_json" as const, position: 12, snippet: '{"@type": "Org' });
  it("STORY-051 AUX-R-008 · the same broken block in the plain and the rendered copy is ONE error, not two", async () => {
    const doc = makeDoc({ raw: variant({ structured: { jsonLd: [], microdata: [], rdfa: [], parseErrors: [err("raw"), err("rendered")] } }) });
    const [f] = await findings(doc, "AUX-R-008");
    expect(f!.measured_value).toBe(1);
  });
  it("STORY-051 AUX-R-008 · the locator names the copy the error was found in", async () => {
    const rendered = makeDoc({ raw: variant({ structured: { jsonLd: [], microdata: [], rdfa: [], parseErrors: [err("rendered")] } }) });
    expect((await findings(rendered, "AUX-R-008"))[0]!.evidence.locator).toBe("rendered.jsonld[0]@12");
  });
  it("STORY-051 AUX-R-008 · two different blocks at the same index in the two copies stay two errors", async () => {
    const other = { ...err("rendered"), snippet: '{"@type": "Person' };
    const doc = makeDoc({ raw: variant({ structured: { jsonLd: [], microdata: [], rdfa: [], parseErrors: [err("raw"), other] } }) });
    expect((await findings(doc, "AUX-R-008"))[0]!.measured_value).toBe(2);
  });
});

describe("STORY-051 AUX-R-009 · missing @context / @type", () => {
  it("STORY-051 AUX-R-009 · complete blocks, and no JSON-LD at all, do not fire", async () => {
    expect(await findings(makeDoc(), "AUX-R-009")).toEqual([]);
    expect(await findings(withLd([]), "AUX-R-009")).toEqual([]);
  });
  it("STORY-051 AUX-R-009 · a block with no @context fires high (1 block at threshold 1)", async () => {
    const [f] = await findings(withLd([withoutKey(org, "@context")]), "AUX-R-009");
    expect(f).toMatchObject({ severity: "high", measured_value: 1, threshold_value: 1 });
    expect(f!.evidence.reason).toBe("missing_context");
  });
  it("STORY-051 AUX-R-009 · a block with no @type fires, and two bad blocks measure 2", async () => {
    expect((await findings(withLd([withoutKey(org, "@type")]), "AUX-R-009"))[0]!.evidence.reason).toBe("missing_type");
    expect((await findings(withLd([withoutKey(org, "@type"), withoutKey(app, "@context")]), "AUX-R-009"))[0]!.measured_value).toBe(2);
  });
  it("STORY-051 AUX-R-009 · an @graph wrapper needs @context but not @type; each graph node needs @type", async () => {
    const wrapper = { "@context": "https://schema.org", "@graph": [withoutKey(org, "@context"), withoutKey(app, "@context")] };
    expect(await findings(withLd([wrapper]), "AUX-R-009")).toEqual([]);
    expect(await findings(withLd([{ ...wrapper, "@graph": [withoutKey(org, "@context", "@type")] }]), "AUX-R-009")).toHaveLength(1);
  });
});

describe("STORY-051 AUX-R-010 · no primary entity schema", () => {
  it("STORY-051 AUX-R-010 · each primary type satisfies it (at the threshold)", async () => {
    for (const t of ["Organization", "Product", "SoftwareApplication", "Service", "Article"]) {
      expect(await findings(withLd([{ "@context": "https://schema.org", "@type": t, name: "x" }]), "AUX-R-010"), t).toEqual([]);
    }
  });
  it("STORY-051 AUX-R-010 · no JSON-LD, or only a non-primary type, fires high with measured 0", async () => {
    for (const ld of [[], [{ "@context": "https://schema.org", "@type": "WebSite", name: "x" }]]) {
      const [f] = await findings(withLd(ld), "AUX-R-010");
      expect(f).toMatchObject({ severity: "high", measured_value: 0, threshold_value: 1 });
    }
  });
  it("STORY-051 AUX-R-010 · a type inside an @graph, a schema.org URL type, or Microdata counts", async () => {
    expect(await findings(withLd([{ "@context": "https://schema.org", "@graph": [{ "@type": "Product", name: "x" }] }]), "AUX-R-010")).toEqual([]);
    expect(await findings(withLd([{ "@context": "https://schema.org", "@type": "https://schema.org/Service" }]), "AUX-R-010")).toEqual([]);
    const md = withLd([]);
    const doc = { ...md, raw: { ...md.raw, structured: { ...md.raw.structured, microdata: [{ type: "https://schema.org/Product", properties: {} }] } }, rendered: null } as typeof md;
    expect(await findings({ ...doc, structured: doc.raw.structured }, "AUX-R-010")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-011 · Organization incomplete", () => {
  const orgMissing = (...keys: string[]) => withLd([withoutKey(org, ...keys)]);
  it("STORY-051 AUX-R-011 · missing one field is below the threshold (2)", async () => {
    expect(await findings(orgMissing("logo"), "AUX-R-011")).toEqual([]);
  });
  it("STORY-051 AUX-R-011 · missing two fires medium at the threshold; three measures 3", async () => {
    const [f] = await findings(orgMissing("logo", "sameAs"), "AUX-R-011");
    expect(f).toMatchObject({ severity: "medium", measured_value: 2, threshold_value: 2 });
    expect((await findings(orgMissing("logo", "sameAs", "url"), "AUX-R-011"))[0]!.measured_value).toBe(3);
  });
  it("STORY-051 AUX-R-011 · an empty string or empty array is missing, not present", async () => {
    expect(await findings(withLd([{ ...org, logo: "", sameAs: [] }]), "AUX-R-011")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-011 · a page with no Organization is not this rule's finding", async () => {
    expect(await findings(withLd([app]), "AUX-R-011")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-012 · offer data absent", () => {
  it("STORY-051 AUX-R-012 · complete offers: no finding", async () => {
    expect(await findings(makeDoc(), "AUX-R-012")).toEqual([]);
  });
  it("STORY-051 AUX-R-012 · no offers on a page that talks about pricing fires high", async () => {
    const [f] = await findings(withApp({ offers: undefined }), "AUX-R-012");
    expect(f).toMatchObject({ severity: "high", measured_value: 1, threshold_value: 1 });
  });
  it("STORY-051 AUX-R-012 · offers with a price but no currency, or a currency but no price, fire", async () => {
    expect(await findings(withApp({ offers: { "@type": "Offer", price: "47" } }), "AUX-R-012")).toHaveLength(1);
    expect(await findings(withApp({ offers: { "@type": "Offer", priceCurrency: "USD" } }), "AUX-R-012")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-012 · an AggregateOffer with lowPrice and priceCurrency has a price; without lowPrice it does not", async () => {
    const agg = { "@type": "AggregateOffer", lowPrice: "9", highPrice: "99", priceCurrency: "USD" };
    expect(await findings(withApp({ offers: agg }), "AUX-R-012")).toEqual([]);
    expect(await findings(withApp({ offers: { ...agg, lowPrice: undefined } }), "AUX-R-012")).toHaveLength(1);
    expect(await findings(withApp({ offers: { "@type": "Offer", lowPrice: "9", priceCurrency: "USD" } }), "AUX-R-012")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-012 · a price of 0 is a price (free), not an absent one", async () => {
    expect(await findings(withApp({ offers: { "@type": "Offer", price: 0, priceCurrency: "USD" } }), "AUX-R-012")).toEqual([]);
  });
  it("STORY-051 AUX-R-012 · with no pricing tokens in the text the rule does not fire", async () => {
    expect(await findings(withApp({ offers: undefined }, { mainText: "Acme Widgets\nA product page with no figures." }), "AUX-R-012")).toEqual([]);
  });
  it("STORY-051 AUX-R-012 · pricing is recognised by symbol+digit, digit+code, and unit phrases", async () => {
    for (const t of ["Plans from €29", "Price: 29 USD", "Billed 12 per user", "Pay 5/mo"]) {
      expect(await findings(withApp({ offers: undefined }, { mainText: t }), "AUX-R-012"), t).toHaveLength(1);
    }
  });
  it("STORY-051 AUX-R-012 · a unit phrase with no amount beside it (a feature quota) is not pricing", async () => {
    for (const t of ["Includes 10 GB storage per user", "Unlimited API calls /month", "Billed per user"]) {
      expect(await findings(withApp({ offers: undefined }, { mainText: t }), "AUX-R-012"), t).toEqual([]);
    }
  });
  it("STORY-051 AUX-R-012 · an offers list with one bad entry counts that entity once", async () => {
    const offers = [{ price: "5", priceCurrency: "USD" }, { price: "9" }];
    expect((await findings(withApp({ offers }), "AUX-R-012"))[0]!.measured_value).toBe(1);
  });
});

describe("STORY-051 AUX-R-013 · schema versus visible text contradiction", () => {
  it("STORY-051 #7 · a structured price that disagrees with the visible price fires critical", async () => {
    const [f] = await findings(withApp({}, { mainText: CLEAN_TEXT.replace("$47", "$57") }), "AUX-R-013");
    expect(f).toMatchObject({ severity: "critical", measured_value: 1, threshold_value: 1, auto_fixable: false });
    expect(f!.evidence).toMatchObject({ reason: "price", locator: "jsonld[1].offers.price" });
    expect(f!.evidence.snippet).toContain("47");
    expect(f!.guidance).not.toBeNull();
  });
  it("STORY-051 AUX-R-013 · a matching price does not fire, including a thousands separator and a decimal form", async () => {
    expect(await findings(makeDoc(), "AUX-R-013")).toEqual([]);
    expect(await findings(withApp({ offers: { price: "1299.00", priceCurrency: "USD" } }, { mainText: CLEAN_TEXT.replace("$47", "$1,299") }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a text with no price at all is not a contradiction", async () => {
    expect(await findings(withApp({}, { mainText: "Acme Widgets\nNo figures here." }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · any of several visible prices that matches is agreement", async () => {
    expect(await findings(withApp({}, textWith("Team plan $99 per month")), "AUX-R-013")).toEqual([]);
  });
  // Owner decision 97: only the page's own (reached) subject can contradict by name; a top-level product the page never names is unchecked.
  it("STORY-051 AUX-R-013 · a product name absent from the visible text fires (on the page's own mainEntity)", async () => {
    const [f] = await findings(withLd([org, reachedApp({ name: "Zed Gadget" })]), "AUX-R-013");
    expect(f!.evidence).toMatchObject({ reason: "name", locator: "jsonld[1].mainEntity.name" });
  });
  it("STORY-187 decision 97 · a lone top-level product the page never names is unchecked, not a name contradiction", async () => {
    expect(await findings(withApp({ name: "Zed Gadget" }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a name that differs only in a trademark sign, a curly apostrophe, & versus and, or a pack suffix is not a contradiction", async () => {
    const cases: [string, string][] = [
      ["Acme Widget\u2122", "Acme Widget"],
      ["Joe\u2019s Widget", "Joe's Widget"],
      ["Acme & Sons Widget", "Acme and Sons Widget"],
      ["Acme Widget Pro, 12-pack", "Acme Widget Pro"],
    ];
    for (const [schemaName, pageName] of cases) {
      const doc = withApp({ name: schemaName }, { mainText: `${CLEAN_TEXT}\n${pageName}` });
      expect(await findings(doc, "AUX-R-013"), schemaName).toEqual([]);
    }
  });
  it("STORY-051 AUX-R-013 · a rating or review count that disagrees fires; one that agrees, or is not shown, does not", async () => {
    expect((await findings(withApp({}, { mainText: CLEAN_TEXT.replace("4.6/5", "3.9/5") }), "AUX-R-013"))[0]!.evidence.reason).toBe("rating_value");
    expect((await findings(withApp({}, { mainText: CLEAN_TEXT.replace("120 reviews", "87 reviews") }), "AUX-R-013"))[0]!.evidence.reason).toBe("review_count");
    expect(await findings(withApp({}, { mainText: CLEAN_TEXT.replace("Rated 4.6/5 from 120 reviews.", "") }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a date shaped like a rating (3/5/2026, 10/10/2026) is not a rating", async () => {
    for (const d of ["Updated 3/5/2026", "Rated on 10/10/2026 by our team"]) {
      expect(await findings(withApp({}, { mainText: CLEAN_TEXT.replace("Rated 4.6/5", d) }), "AUX-R-013"), d).toEqual([]);
    }
  });
  it("STORY-051 AUX-R-013 · a fraction with no rating word near it is not a rating", async () => {
    const far = `Step 3/5 of onboarding.${" filler".repeat(30)}`;
    expect(await findings(withApp({}, { mainText: CLEAN_TEXT.replace("Rated 4.6/5 from 120 reviews.", far) }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a dollar amount that is not a price ($2B processed, Save $500) does not contradict the schema price", async () => {
    const body = "Acme Widgets\nWe have processed $2B for customers. Save $500 on setup with our partner.\nRated 4.6/5 from 120 reviews.\nLast updated: 2026-10-01";
    expect(await findings(withApp({}, { mainText: body }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · the tolerance, the scales and the context words are read from the catalog", async () => {
    const close = { mainText: CLEAN_TEXT.replace("$47", "$47.50") };
    expect(await findings(withApp({}, close), "AUX-R-013")).toHaveLength(1);
    expect(await findings(withApp({}, close), "AUX-R-013", withThresholds("AUX-R-013", { price_tolerance: 1 }))).toEqual([]);
    const ten = { mainText: CLEAN_TEXT.replace("4.6/5", "3.9/100") };
    expect(await findings(withApp({}, ten), "AUX-R-013")).toEqual([]);
    expect(await findings(withApp({}, ten), "AUX-R-013", withThresholds("AUX-R-013", { rating_scales: [5, 100] }))).toHaveLength(1);
    expect(await findings(withApp({}, { mainText: CLEAN_TEXT.replace("$47", "$57") }), "AUX-R-013", withThresholds("AUX-R-013", { price_context_words: ["zzz"] }))).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · several disagreements measure their count", async () => {
    const doc = withLd([org, reachedApp({ name: "Zed Gadget" })], { mainText: CLEAN_TEXT.replace("$47", "$57") });
    expect((await findings(doc, "AUX-R-013"))[0]!.measured_value).toBe(2);
  });
});

describe("STORY-051 AUX-R-013 · number formats and rounded counts are not contradictions", () => {
  const priced = (price: string, currency: string, text: string) =>
    withApp({ offers: { "@type": "Offer", price, priceCurrency: currency } }, { mainText: CLEAN_TEXT.replace("starts at $47 per month", text) });
  it("STORY-051 AUX-R-013 · a comma decimal (EUR 29,99) agrees with a schema price of 29.99", async () => {
    expect(await findings(priced("29.99", "EUR", "price \u20ac29,99 per month"), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a European thousands dot and comma decimal (1.299,00 EUR) agrees with 1299", async () => {
    expect(await findings(priced("1299", "EUR", "price 1.299,00 EUR per year"), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a US thousands comma still agrees (1,299.00), and a lone 1,299 agrees with 1299", async () => {
    expect(await findings(priced("1299.00", "USD", "price $1,299.00 per year"), "AUX-R-013")).toEqual([]);
    expect(await findings(priced("1299", "USD", "price $1,299 per year"), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a comma-decimal price that really differs from the schema still fires", async () => {
    const [f] = await findings(priced("39.99", "EUR", "price \u20ac29,99 per month"), "AUX-R-013");
    expect(f!.evidence.reason).toBe("price");
  });
  it("STORY-051 AUX-R-013 · a sentence-ending full stop after a price is not part of the number", async () => {
    expect(await findings(priced("47", "USD", "price $47. Per month"), "AUX-R-013")).toEqual([]);
  });
  const counted = (phrase: string, declared = "2134") =>
    withApp({ aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: declared } }, { mainText: CLEAN_TEXT.replace("120 reviews", phrase) });
  it("STORY-051 AUX-R-013 · a rounded or open-ended count (2,000+, over 2,000, 2k, about 2,000) is not a different count", async () => {
    for (const phrase of ["2,000+ reviews", "over 2,000 reviews", "more than 2,000 reviews", "2k reviews", "about 2,000 reviews"]) {
      expect(await findings(counted(phrase), "AUX-R-013"), phrase).toEqual([]);
    }
  });
  it("STORY-051 AUX-R-013 · an exact count that differs fires; the exact count in either number format agrees", async () => {
    expect((await findings(counted("87 reviews"), "AUX-R-013"))[0]!.evidence.reason).toBe("review_count");
    expect(await findings(counted("2,134 reviews"), "AUX-R-013")).toEqual([]);
    expect(await findings(counted("2.134 reviews"), "AUX-R-013")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-014 · featureList absent or thin", () => {
  const heads = (...texts: string[]) => ({ headingTree: [{ level: 1, text: "Acme", children: texts.map((t) => ({ level: 2, text: t, children: [] })) }] });
  it("STORY-051 AUX-R-014 · full coverage: no finding", async () => {
    expect(await findings(makeDoc(), "AUX-R-014")).toEqual([]);
  });
  it("STORY-051 AUX-R-014 · no featureList fires high with measured 0", async () => {
    const [f] = await findings(withApp({ featureList: undefined }), "AUX-R-014");
    expect(f).toMatchObject({ severity: "high", measured_value: 0, threshold_value: 0.5 });
  });
  it("STORY-051 AUX-R-014 · coverage exactly 0.5 does not fire; below it does; above it does not", async () => {
    const list = { featureList: ["Alpha"] };
    expect(await findings(withApp(list, heads("Alpha", "Beta")), "AUX-R-014")).toEqual([]);
    const [f] = await findings(withApp(list, heads("Alpha", "Beta", "Gamma")), "AUX-R-014");
    expect(f!.measured_value).toBeCloseTo(1 / 3, 6);
    expect(await findings(withApp({ featureList: ["Alpha", "Beta"] }, heads("Alpha", "Beta", "Gamma")), "AUX-R-014")).toEqual([]);
  });
  it("STORY-051 AUX-R-014 · no capability headings means coverage is unmeasurable, not zero", async () => {
    expect(await findings(withApp({ featureList: ["Alpha"] }, heads()), "AUX-R-014")).toEqual([]);
  });
  it("STORY-051 AUX-R-014 · headings that are not capabilities (Pricing, FAQ) are not counted", async () => {
    expect(await findings(withApp({ featureList: ["Alpha"] }, heads("Alpha", "Pricing", "FAQ")), "AUX-R-014")).toEqual([]);
  });
  it("STORY-051 AUX-R-014 · a page with no software/product entity is not this rule's finding", async () => {
    expect(await findings(withLd([org]), "AUX-R-014")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-015 · aggregateRating without provenance", () => {
  const rating = (r: Record<string, unknown>) => withApp({ aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", ...r } }, { mainText: "Acme Widgets\nAcme Widgets starts at $47 per month." });
  it("STORY-051 AUX-R-015 · a review count is provenance", async () => {
    expect(await findings(rating({ reviewCount: 1 }), "AUX-R-015")).toEqual([]);
  });
  it("STORY-051 AUX-R-015 · a rating with neither a count nor a source fires medium", async () => {
    const [f] = await findings(rating({}), "AUX-R-015");
    expect(f).toMatchObject({ severity: "medium", measured_value: 1, threshold_value: 1 });
  });
  it("STORY-051 AUX-R-015 · a review count of 0 is not provenance", async () => {
    expect(await findings(rating({ reviewCount: 0 }), "AUX-R-015")).toHaveLength(1);
    expect(await findings(rating({ reviewCount: "0" }), "AUX-R-015")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-015 · a source (url, author) counts when there is no count", async () => {
    expect(await findings(rating({ url: "https://reviews.example.org/acme" }), "AUX-R-015")).toEqual([]);
    expect(await findings(rating({ author: { "@type": "Organization", name: "R" } }), "AUX-R-015")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-016 · deprecated or invalid vocabulary", () => {
  it("STORY-051 AUX-R-016 · schema.org over http or https, with real classes: no finding", async () => {
    expect(await findings(makeDoc(), "AUX-R-016")).toEqual([]);
    expect(await findings(withLd([{ ...org, "@context": "http://schema.org" }]), "AUX-R-016")).toEqual([]);
  });
  it("STORY-051 AUX-R-016 · a non-schema.org vocabulary fires medium", async () => {
    const [f] = await findings(withLd([{ ...org, "@context": "https://example.org/vocab" }]), "AUX-R-016");
    expect(f).toMatchObject({ severity: "medium", measured_value: 1, threshold_value: 1 });
    expect(f!.evidence.reason).toBe("non_schema_context");
  });
  it("STORY-051 AUX-R-016 · a type that is not a schema.org class name fires", async () => {
    for (const t of ["organization", "ex:Thing", "https://example.org/Thing", "Not A Class"]) {
      expect(await findings(withLd([{ ...org, "@type": t }]), "AUX-R-016"), t).toHaveLength(1);
    }
    expect(await findings(withLd([{ ...org, "@type": "schema:Organization" }]), "AUX-R-016")).toEqual([]);
  });
  it("STORY-051 AUX-R-016 · a deprecated property (from the catalog list) fires", async () => {
    const [f] = await findings(withLd([{ ...org, "@type": "Event", subEvents: [] }]), "AUX-R-016");
    expect(f!.evidence.reason).toBe("deprecated_property");
  });
});

describe("STORY-051 AUX-R-017 · FAQPage absent where warranted", () => {
  const qs = (n: number, level = 2) => ({ headingTree: [{ level: 1, text: "Acme", children: Array.from({ length: n }, (_, i) => ({ level, text: `Question ${String(i)}?`, children: [] })) }] });
  it("STORY-051 AUX-R-017 · two question headings is below the threshold (3)", async () => {
    expect(await findings(withLd([org], qs(2)), "AUX-R-017")).toEqual([]);
  });
  it("STORY-051 AUX-R-017 · three question headings with no FAQ markup fires medium at the threshold", async () => {
    const [f] = await findings(withLd([org], qs(3)), "AUX-R-017");
    expect(f).toMatchObject({ severity: "medium", measured_value: 3, threshold_value: 3 });
    expect((await findings(withLd([org], qs(4, 3)), "AUX-R-017"))[0]!.measured_value).toBe(4);
  });
  it("STORY-051 AUX-R-017 · FAQPage or QAPage markup silences it; H4 questions and statements do not count", async () => {
    expect(await findings(withLd([org, { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [] }], qs(5)), "AUX-R-017")).toEqual([]);
    expect(await findings(withLd([org, { "@context": "https://schema.org", "@type": "QAPage" }], qs(5)), "AUX-R-017")).toEqual([]);
    expect(await findings(withLd([org], qs(5, 4)), "AUX-R-017")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-018 · duplicate conflicting entities", () => {
  const prod = (name: string, extra: Record<string, unknown> = {}) => ({ "@context": "https://schema.org", "@type": "SoftwareApplication", name, ...extra });
  it("STORY-051 AUX-R-018 · same type, same name and url in two blocks: no conflict", async () => {
    expect(await findings(withLd([prod("A"), prod("A")]), "AUX-R-018")).toEqual([]);
  });
  it("STORY-051 AUX-R-018 · same type with a different name in a second block fires medium", async () => {
    const [f] = await findings(withLd([prod("A"), prod("B")]), "AUX-R-018");
    expect(f).toMatchObject({ severity: "medium", measured_value: 1, threshold_value: 1 });
  });
  it("STORY-051 AUX-R-018 · which conflict is reported first follows code-point order, not the host locale", async () => {
    const thing = (type: string, name: string) => ({ "@context": "https://schema.org", "@type": type, name });
    const doc = withLd([thing("Product", "A"), thing("Product", "B"), thing("organization", "C"), thing("organization", "D")]);
    const catalog = withThresholds("AUX-R-018", { singleton_types: ["organization", "Product"] });
    const [f] = await findings(doc, "AUX-R-018", catalog);
    expect(f!.measured_value).toBe(2);
    expect(f!.evidence.snippet).toMatch(/^Product:/u);
  });
  it("STORY-051 AUX-R-018 · a different url alone conflicts; different types never do", async () => {
    expect(await findings(withLd([prod("A", { url: "https://a.example" }), prod("A", { url: "https://b.example" })]), "AUX-R-018")).toHaveLength(1);
    expect(await findings(withLd([prod("A"), { ...org, name: "B" }]), "AUX-R-018")).toEqual([]);
  });
  it("STORY-051 AUX-R-018 · a second block that restates only the name (no url) is not a disagreement", async () => {
    const full = { ...org, name: "Acme", url: "https://acme.com" };
    expect(await findings(withLd([full, { "@context": "https://schema.org", "@type": "Organization", name: "Acme" }]), "AUX-R-018")).toEqual([]);
    expect(await findings(withLd([full, { "@context": "https://schema.org", "@type": "Organization", url: "https://acme.com" }]), "AUX-R-018")).toEqual([]);
  });
  it("STORY-051 AUX-R-018 · a url that differs only by trailing slash, www., scheme or host case, or a name only by case and spacing, is the same", async () => {
    const o = (extra: Record<string, unknown>) => ({ "@context": "https://schema.org", "@type": "Organization", ...extra });
    for (const other of ["https://acme.com/", "https://www.acme.com", "http://ACME.com/", "https://acme.com//"]) {
      expect(await findings(withLd([o({ name: "Acme", url: "https://acme.com" }), o({ name: "Acme", url: other })]), "AUX-R-018"), other).toEqual([]);
    }
    expect(await findings(withLd([o({ name: "Acme  Inc" }), o({ name: " acme inc " })]), "AUX-R-018")).toEqual([]);
  });
  it("STORY-051 AUX-R-018 · a url on a different path, or a different name beside an equal url, still conflicts", async () => {
    const o = (extra: Record<string, unknown>) => ({ "@context": "https://schema.org", "@type": "Organization", ...extra });
    expect(await findings(withLd([o({ url: "https://acme.com/a" }), o({ url: "https://acme.com/b" })]), "AUX-R-018")).toHaveLength(1);
    expect(await findings(withLd([o({ name: "Acme", url: "https://acme.com" }), o({ name: "Acme Corp", url: "https://acme.com/" })]), "AUX-R-018")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-018 · two entities inside ONE block are not two JSON-LD blocks", async () => {
    expect(await findings(withLd([{ "@context": "https://schema.org", "@graph": [prod("A"), prod("B")] }]), "AUX-R-018")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-018 · distinct entities are not duplicates (round 3)", () => {
  const typed = (type: string, name: string, extra: Record<string, unknown> = {}) => ({ "@context": "https://schema.org", "@type": type, name, ...extra });
  it("STORY-051 AUX-R-018 · an author and a reviewer (two Person blocks) are two people, not one described twice", async () => {
    expect(await findings(withLd([typed("Person", "Jane"), typed("Person", "Bob")]), "AUX-R-018")).toEqual([]);
  });
  it("STORY-051 AUX-R-018 · per-card Product blocks and ImageObjects on a listing page do not fire", async () => {
    expect(await findings(withLd([typed("Product", "A"), typed("Product", "B"), typed("ImageObject", "x"), typed("ImageObject", "y")]), "AUX-R-018")).toEqual([]);
  });
  it("STORY-051 AUX-R-018 · two Organization blocks with different @id values are two organizations", async () => {
    expect(await findings(withLd([typed("Organization", "Acme", { "@id": "https://a.example/#o" }), typed("Organization", "Acme Labs", { "@id": "https://b.example/#o" })]), "AUX-R-018")).toEqual([]);
  });
  it("STORY-051 AUX-R-018 · two Organization blocks that give no @id, or the same @id, and differ still fire", async () => {
    expect(await findings(withLd([typed("Organization", "Acme"), typed("Organization", "Acme Labs")]), "AUX-R-018")).toHaveLength(1);
    expect(await findings(withLd([typed("Organization", "Acme", { "@id": "https://a.example/#o" }), typed("Organization", "Acme Labs", { "@id": "https://a.example/#o" })]), "AUX-R-018")).toHaveLength(1);
    expect(await findings(withLd([typed("Organization", "Acme", { "@id": "https://a.example/#o" }), typed("Organization", "Acme Labs")]), "AUX-R-018")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-018 · the singleton types come from the catalog row", async () => {
    const { withThresholds } = await import("../../../../test/support/aux-rules.js");
    const cat = withThresholds("AUX-R-018", { singleton_types: ["Person"] });
    expect(await findings(withLd([typed("Person", "Jane"), typed("Person", "Bob")]), "AUX-R-018", cat)).toHaveLength(1);
  });
});

describe("STORY-051 AUX-R-010 / 011 / 012 / 013 / 014 · schema.org subtypes (round 3)", () => {
  const typed = (type: string, extra: Record<string, unknown> = {}) => ({ "@context": "https://schema.org", "@type": type, name: "Acme", ...extra });
  it("STORY-051 AUX-R-010 · a BlogPosting, NewsArticle, TechArticle, LocalBusiness, Corporation or WebApplication IS a primary entity", async () => {
    for (const t of ["BlogPosting", "NewsArticle", "TechArticle", "LocalBusiness", "Corporation", "WebApplication"]) {
      expect(await findings(withLd([typed(t)]), "AUX-R-010"), t).toEqual([]);
    }
  });
  it("STORY-051 AUX-R-010 · an unrelated type still fires", async () => {
    expect(await findings(withLd([typed("Person")]), "AUX-R-010")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-011 · a Corporation or LocalBusiness missing two fields fires; one missing field does not", async () => {
    expect(await findings(withLd([typed("Corporation", { url: "https://acme.com", logo: "l" })]), "AUX-R-011")).toHaveLength(1);
    expect(await findings(withLd([typed("LocalBusiness", { url: "https://acme.com", logo: "l" })]), "AUX-R-011")).toHaveLength(1);
    expect(await findings(withLd([typed("Corporation", { url: "https://acme.com", logo: "l", sameAs: ["https://x.example"] })]), "AUX-R-011")).toEqual([]);
  });
  it("STORY-051 AUX-R-012 · a WebApplication with no offers on a page that talks pricing fires", async () => {
    expect(await findings(withLd([typed("WebApplication")]), "AUX-R-012")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-014 · a WebApplication with no featureList fires", async () => {
    expect(await findings(withLd([typed("WebApplication")]), "AUX-R-014")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-013 · a WebApplication whose name is not on the page fires", async () => {
    const [f] = await findings(withLd([org, reachedApp({ "@type": "WebApplication", name: "Zed Gadget" })]), "AUX-R-013");
    expect(f!.evidence.reason).toBe("name");
  });
});

describe("STORY-051 AUX-R-012 · only an amount beside a pricing word is a pricing token (round 3)", () => {
  const noOffers = (mainText: string) => withApp({ offers: undefined }, { mainText });
  it("STORY-051 AUX-R-012 · '$2B processed' and 'Save $500' on a page with no offers do not fire", async () => {
    expect(await findings(noOffers("Acme\nWe have processed $2B in payments."), "AUX-R-012")).toEqual([]);
    expect(await findings(noOffers("Acme\nSave $500 on your first order of hardware."), "AUX-R-012")).toEqual([]);
  });
  it("STORY-051 AUX-R-012 · an amount beside a pricing word still fires", async () => {
    expect(await findings(noOffers("Acme\nPlans: price $29 for one seat."), "AUX-R-012")).toHaveLength(1);
    expect(await findings(noOffers("Acme\nStarts at $29."), "AUX-R-012")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-012 · the context words come from the catalog row", async () => {
    const { withThresholds } = await import("../../../../test/support/aux-rules.js");
    const cat = withThresholds("AUX-R-012", { price_context_words: ["processed"] });
    expect(await findings(noOffers("Acme\nWe have processed $2B in payments."), "AUX-R-012", cat)).toHaveLength(1);
  });
});

describe("STORY-051 AUX-R-013 · a free tier written as a word agrees with a declared price of 0 (round 3)", () => {
  const offer = (price: string) => ({ "@type": "Offer", price, priceCurrency: "USD" });
  const tiers = (mainText: string, prices = ["0", "47"]) => withApp({ offers: prices.map(offer) }, { mainText });
  it("STORY-051 AUX-R-013 · Offer 0 beside Offer 47 on a page saying 'Free forever ... Pro starts at $47 per month' does not fire", async () => {
    expect(await findings(tiers("Acme Widgets\nFree forever. Pro starts at $47 per month."), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · 'Free' as a tier name agrees too", async () => {
    expect(await findings(tiers("Acme Widgets\nFree\nPro starts at $47 per month."), "AUX-R-013")).toEqual([]);
  });
  // STORY-187: a set agrees when any member is shown, so [0, 47] beside "$47" agrees; the free-word cases below use a lone 0.
  it("STORY-051 AUX-R-013 · Offer 0 with NO free word on a page that prices everything does fire", async () => {
    const [f] = await findings(tiers("Acme Widgets\nEvery plan starts at $47 per month.", ["0"]), "AUX-R-013");
    expect(f).toMatchObject({ severity: "critical" });
    expect(f!.evidence).toMatchObject({ reason: "price" });
    expect(f!.evidence.snippet).toContain("schema price 0");
  });
  it("STORY-051 AUX-R-013 · Offer 0 beside '$0/month' does not fire", async () => {
    expect(await findings(tiers("Acme Widgets\nStarter $0/month. Pro starts at $47 per month."), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a free word does not excuse a different non-zero price", async () => {
    expect(await findings(tiers("Acme Widgets\nFree trial. Pro starts at $57 per month.", ["47"]), "AUX-R-013")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-013 · 'free' inside another word (carefree) is not a free word", async () => {
    expect(await findings(tiers("Acme Widgets\nA carefree plan. Every plan starts at $47 per month.", ["0"]), "AUX-R-013")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-013 · the free words come from the catalog row", async () => {
    const { withThresholds } = await import("../../../../test/support/aux-rules.js");
    const cat = withThresholds("AUX-R-013", { free_words: ["gratis"] });
    expect(await findings(tiers("Acme Widgets\nFree forever. Pro starts at $47 per month.", ["0"]), "AUX-R-013", cat)).toHaveLength(1);
    expect(await findings(tiers("Acme Widgets\nGratis. Pro starts at $47 per month.", ["0"]), "AUX-R-013", cat)).toEqual([]);
  });
});

describe("STORY-051 AC1 · an entity nested under a property is an entity (round 2)", () => {
  const webPage = (main: Record<string, unknown>, prop = "mainEntity") => ({ "@context": "https://schema.org", "@type": "WebPage", name: "Acme", [prop]: main });
  const bareProduct = { "@type": "Product", name: "Acme Widget" };
  it("STORY-051 AUX-R-010 · WebPage > mainEntity > Product, and ItemPage > mainEntity > Product, satisfy it", async () => {
    expect(await findings(withLd([webPage(bareProduct)]), "AUX-R-010")).toEqual([]);
    expect(await findings(withLd([{ ...webPage(bareProduct), "@type": "ItemPage" }]), "AUX-R-010")).toEqual([]);
    expect(await findings(withLd([webPage(bareProduct, "about")]), "AUX-R-010")).toEqual([]);
  });
  it("STORY-051 AUX-R-010 · a nested entity that is not a primary type still leaves the page without one", async () => {
    expect(await findings(withLd([webPage({ "@type": "Person", name: "Ann" })]), "AUX-R-010")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-012 · a nested Product with no offers on a pricing page fires, located by property path", async () => {
    const [f] = await findings(withLd([org, webPage(bareProduct)]), "AUX-R-012");
    expect(f).toMatchObject({ severity: "high", measured_value: 1 });
    expect(f!.evidence.locator).toBe("jsonld[1].mainEntity.offers");
  });
  it("STORY-051 AUX-R-012 · a nested Product with complete offers does not fire", async () => {
    const priced = { ...bareProduct, offers: { "@type": "Offer", price: "47", priceCurrency: "USD" } };
    expect(await findings(withLd([org, webPage(priced)]), "AUX-R-012")).toEqual([]);
  });
  it("STORY-051 AUX-R-015 · a nested rating with no provenance fires", async () => {
    const rated = { ...bareProduct, aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8" } };
    expect(await findings(withLd([org, webPage(rated)]), "AUX-R-015")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-017 · FAQPage nested under a WebPage satisfies the FAQ markup arm", async () => {
    const heads = { headingTree: [{ level: 1, text: "Acme", children: [1, 2, 3, 4, 5].map((n) => ({ level: 2, text: `Question ${String(n)}?`, children: [] })) }] };
    const bare = await findings(withLd([org, { "@context": "https://schema.org", "@type": "WebPage", name: "x" }], heads), "AUX-R-017");
    expect(bare).toHaveLength(1);
    expect(await findings(withLd([org, webPage({ "@type": "FAQPage" })], heads), "AUX-R-017")).toEqual([]);
  });
  it("STORY-051 AUX-R-014 · a short featureList item does not cover a heading it is only a fragment of (word boundary)", async () => {
    const heads = { headingTree: [{ level: 1, text: "Acme", children: ["Detailed reports", "Beta", "Gamma", "Delta"].map((t) => ({ level: 2, text: t, children: [] })) }] };
    const [f] = await findings(withApp({ featureList: ["ai", "Beta"] }, heads), "AUX-R-014");
    expect(f).toMatchObject({ severity: "high", measured_value: 0.25 });
    expect(await findings(withApp({ featureList: ["Detailed reports for teams", "Beta"] }, heads), "AUX-R-014")).toEqual([]);
  });
  it("STORY-051 AUX-R-012 · 'from' alone is not a pricing word ('$20M from investors')", async () => {
    expect(await findings(withApp({ offers: undefined }, { mainText: "Acme Widgets\nWe raised $20M from investors." }), "AUX-R-012")).toEqual([]);
    expect(await findings(withApp({ offers: undefined }, { mainText: "Acme Widgets\nPlans starting at $20 a seat." }), "AUX-R-012")).toHaveLength(1);
  });
});

describe("STORY-051 AUX-R-013 · a contradiction on a nested entity (round 3)", () => {
  const nested = (product: Record<string, unknown>) => ({ "@context": "https://schema.org", "@type": "WebPage", mainEntity: { "@type": "Product", name: "Acme", ...product } });
  const priced = (price: string) => ({ offers: { "@type": "Offer", price, priceCurrency: "USD" } });
  const page = (extra: string) => ({ mainText: `Acme\n${extra}` });
  it("STORY-051 #7 · WebPage > mainEntity > Product whose price disagrees with the page fires critical, located by property path", async () => {
    const [f] = await findings(withLd([org, nested(priced("73"))], page("Pricing: $88 per month")), "AUX-R-013");
    expect(f).toMatchObject({ severity: "critical" });
    expect(f!.evidence).toMatchObject({ reason: "price", locator: "jsonld[1].mainEntity.offers.price" });
  });
  it("STORY-051 AUX-R-013 · a nested price that agrees with the page does not fire", async () => {
    expect(await findings(withLd([org, nested(priced("88"))], page("Pricing: $88 per month")), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a nested product name the page does not show fires", async () => {
    const [f] = await findings(withLd([org, { ...nested({}), mainEntity: { "@type": "Product", name: "Zed Gadget" } }], page("Acme widgets")), "AUX-R-013");
    expect(f!.evidence).toMatchObject({ reason: "name", locator: "jsonld[1].mainEntity.name" });
  });
  it("STORY-051 AUX-R-013 · a nested rating the page contradicts fires", async () => {
    const rated = nested({ aggregateRating: { "@type": "AggregateRating", ratingValue: "4.9", reviewCount: "10" } });
    const [f] = await findings(withLd([org, rated], page("Rated 3.1/5 by customers")), "AUX-R-013");
    expect(f!.evidence).toMatchObject({ reason: "rating_value", locator: "jsonld[1].mainEntity.aggregateRating.ratingValue" });
  });
  it("STORY-051 AUX-R-013 · a listing (ItemList of Products) whose names and prices are all shown does not start firing", async () => {
    const list = { "@context": "https://schema.org", "@type": "ItemList", itemListElement: [
      { "@type": "ListItem", position: 1, item: { "@type": "Product", name: "Alpha Widget", ...priced("10") } },
      { "@type": "ListItem", position: 2, item: { "@type": "Product", name: "Beta Widget", ...priced("20") } },
    ] };
    expect(await findings(withLd([org, list], page("Alpha Widget $10 price. Beta Widget $20 price.")), "AUX-R-013")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-016 · vocabulary on a nested entity (round 3)", () => {
  it("STORY-051 AUX-R-016 · a malformed @type or a deprecated property on a nested entity fires, located by property path", async () => {
    const page = (main: Record<string, unknown>) => ({ "@context": "https://schema.org", "@type": "WebPage", name: "Acme", mainEntity: main });
    const [bad] = await findings(withLd([org, page({ "@type": "Pro duct", name: "Acme" })]), "AUX-R-016");
    expect(bad!.evidence).toMatchObject({ reason: "invalid_type", locator: "jsonld[1].mainEntity.@type" });
    const [dep] = await findings(withLd([org, page({ "@type": "Event", subEvents: [] })]), "AUX-R-016");
    expect(dep!.evidence).toMatchObject({ reason: "deprecated_property", locator: "jsonld[1].mainEntity.subEvents" });
    expect(await findings(withLd([org, page({ "@type": "Product", name: "Acme" })]), "AUX-R-016")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-010 / 012 / 013 / 015 / 016 · a related or variant entity is not the page subject (round 5)", () => {
  const priced = (price: string) => ({ offers: { "@type": "Offer", price, priceCurrency: "USD" } });
  const shown = { mainText: "Wool coat\nPrice: $39.99" };
  const group = {
    "@context": "https://schema.org", "@type": "ProductGroup", name: "Wool coat",
    hasVariant: [
      { "@type": "Product", name: "Small green coat", ...priced("39.99") },
      { "@type": "Product", name: "Large green coat", ...priced("44.99") },
    ],
  };
  it("STORY-051 AUX-R-013 · a ProductGroup whose variants have other prices and names is not a contradiction", async () => {
    expect(await findings(withLd([org, group], shown), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a Product with isRelatedTo / isSimilarTo / isAccessoryOrSparePartFor / makesOffer entities that are not shown does not fire", async () => {
    const other = { "@type": "Product", name: "Unshown thing", ...priced("999"), aggregateRating: { "@type": "AggregateRating", ratingValue: "1", reviewCount: "3" } };
    const product = { "@context": "https://schema.org", "@type": "Product", name: "Wool coat", ...priced("39.99"), isRelatedTo: other, isSimilarTo: [other], isAccessoryOrSparePartFor: other, makesOffer: { "@type": "Offer", itemOffered: other } };
    expect(await findings(withLd([org, product], { mainText: "Wool coat\nPrice: $39.99\nRated 5/5 by customers" }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-012 · a related product with no offers does not make the page's offer data absent", async () => {
    const product = { "@context": "https://schema.org", "@type": "Product", name: "Wool coat", ...priced("39.99"), isRelatedTo: { "@type": "Product", name: "Scarf" } };
    expect(await findings(withLd([org, product], shown), "AUX-R-012")).toEqual([]);
  });
  it("STORY-051 AUX-R-010 · a related product is not the page's primary entity", async () => {
    const page = { "@context": "https://schema.org", "@type": "WebPage", name: "Acme", isRelatedTo: { "@type": "Product", name: "Scarf" } };
    expect((await findings(withLd([page]), "AUX-R-010")).length).toBe(1);
  });
  it("STORY-051 AUX-R-015 · a related product's rating without provenance is not this page's rating", async () => {
    const product = { "@context": "https://schema.org", "@type": "Product", name: "Wool coat", isRelatedTo: { "@type": "Product", name: "Scarf", aggregateRating: { "@type": "AggregateRating", ratingValue: "4" } } };
    expect(await findings(withLd([org, product]), "AUX-R-015")).toEqual([]);
  });
  it("STORY-051 AUX-R-016 · an invalid type on a related entity is still a vocabulary defect", async () => {
    const product = { "@context": "https://schema.org", "@type": "Product", name: "Wool coat", isRelatedTo: { "@type": "not a class", name: "x" } };
    expect((await findings(withLd([org, product]), "AUX-R-016")).length).toBe(1);
  });
});

describe("STORY-051 AUX-R-010 / 013 / 017 / 030 · a declared entity under any relation but a variant or offer counts (round 6)", () => {
  const ctx = "https://schema.org";
  const qs3 = { headingTree: [{ level: 1, text: "Acme", children: [1, 2, 3].map((n) => ({ level: 2, text: `Question ${String(n)}?`, children: [] })) }] };
  it("STORY-051 AUX-R-010 · a JobPosting with hiringOrganization Organization has an entity", async () => {
    expect(await findings(withLd([{ "@context": ctx, "@type": "JobPosting", title: "Engineer", hiringOrganization: { "@type": "Organization", name: "Acme" } }]), "AUX-R-010")).toEqual([]);
  });
  it("STORY-051 AUX-R-010 · an Event with organizer Organization has an entity", async () => {
    expect(await findings(withLd([{ "@context": ctx, "@type": "Event", name: "Webinar", organizer: { "@type": "Organization", name: "Acme" } }]), "AUX-R-010")).toEqual([]);
  });
  it("STORY-051 AUX-R-010 · a Review with itemReviewed SoftwareApplication has an entity", async () => {
    expect(await findings(withLd([{ "@context": ctx, "@type": "Review", itemReviewed: { "@type": "SoftwareApplication", name: "Acme" } }]), "AUX-R-010")).toEqual([]);
  });
  it("STORY-051 AUX-R-017 · a FAQPage nested under hasPart satisfies the question headings", async () => {
    expect(await findings(withLd([org, { "@context": ctx, "@type": "WebPage", hasPart: { "@type": "FAQPage", mainEntity: [] } }], qs3), "AUX-R-017")).toEqual([]);
  });
  it("STORY-051 AUX-R-030 · a dateModified on an entity under hasPart satisfies it", async () => {
    const { dateModified: _m, ...noMeta } = makeDoc().meta;
    const doc = makeDoc({ meta: noMeta, raw: variant({ mainText: "Acme Widgets\nNo dates here.", structured: { jsonLd: [{ "@context": ctx, "@type": "WebPage", hasPart: { "@type": "Article", dateModified: "2026-10-01" } }], microdata: [], rdfa: [], parseErrors: [] } }) });
    expect(await findings(doc, "AUX-R-030")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-013 · an absent count or value is not a contradiction; variants and listings (round 6)", () => {
  const rated = (rating: Record<string, unknown>, text: string) => withApp({ aggregateRating: { "@type": "AggregateRating", ...rating } }, { mainText: CLEAN_TEXT.replace("Rated 4.6/5 from 120 reviews.", text) });
  it("STORY-051 AUX-R-013 · ratingCount alone with '120 ratings' on the page gives no finding", async () => {
    expect(await findings(rated({ ratingValue: "4.6", ratingCount: "120" }, "Rated 4.6/5 from 120 ratings."), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · ratingCount alone with '120 reviews' on the page gives no finding", async () => {
    expect(await findings(rated({ ratingValue: "4.6", ratingCount: "120" }, "Rated 4.6/5 from 120 reviews."), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · no ratingValue with '4.6/5 stars' on the page gives no finding", async () => {
    expect(await findings(rated({ reviewCount: "120" }, "Rated 4.6/5 stars from 120 reviews."), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a blank reviewCount is not stated either", async () => {
    expect(await findings(rated({ ratingValue: "4.6", reviewCount: " " }, "Rated 4.6/5 from 87 reviews."), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a present reviewCount that differs still fires critical", async () => {
    const [f] = await findings(rated({ ratingValue: "4.6", reviewCount: "120" }, "Rated 4.6/5 from 87 reviews."), "AUX-R-013");
    expect(f).toMatchObject({ severity: "critical" });
    expect(f!.evidence.reason).toBe("review_count");
  });
  const priced = (price: string) => ({ offers: { "@type": "Offer", price, priceCurrency: "USD" } });
  const group = (a: string, b: string) => ({ "@context": "https://schema.org", "@type": "ProductGroup", name: "Wool coat", hasVariant: [{ "@type": "Product", name: "Small", ...priced(a) }, { "@type": "Product", name: "Large", ...priced(b) }] });
  it("STORY-051 AUX-R-013 · variants at 39.99 and 44.99 while the page shows 59.99 fires once, as a price", async () => {
    const hits = await findings(withLd([org, group("39.99", "44.99")], { mainText: "Wool coat\nPrice: $59.99" }), "AUX-R-013");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.evidence.reason).toBe("price");
    expect(hits[0]!.measured_value).toBe(1);
  });
  it("STORY-051 AUX-R-013 · variants where one matches a shown price do not fire", async () => {
    expect(await findings(withLd([org, group("39.99", "44.99")], { mainText: "Wool coat\nPrice: $44.99" }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · an itemListElement price is not compared with a price filter on a listing page", async () => {
    const list = { "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{ "@type": "ListItem", position: 1, item: { "@type": "Product", name: "Alpha", ...priced("61") } }] };
    expect(await findings(withLd([org, list], { mainText: "Alpha\nPrice $0 - $500" }), "AUX-R-013")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-013 · a name the page does not show, round 6", () => {
  const blog = { "@context": "https://schema.org", "@type": "BlogPosting", headline: "Five ways to clean a sales pipeline" };
  const crm = { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Acme CRM" };
  const blogText = { mainText: "Five ways to clean a sales pipeline\nAcme helps teams. Pick one stage and tidy it." };
  it("STORY-051 AUX-R-013 · a site-wide product block on a blog page, whose name the post never uses, is not a contradiction", async () => {
    const doc = withLd([org, crm, blog], blogText);
    const hits = await findings({ ...doc, meta: { ...doc.meta, title: "Five ways to clean a sales pipeline | Acme" } }, "AUX-R-013");
    expect(hits).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · a WebPage whose mainEntity is a product with another name than the page shows still fires critical", async () => {
    const page = { "@context": "https://schema.org", "@type": "WebPage", mainEntity: { "@type": "Product", name: "Zed Gadget" } };
    const [f] = await findings(withLd([org, page], { mainText: CLEAN_TEXT }), "AUX-R-013");
    expect(f).toMatchObject({ severity: "critical" });
    expect(f!.evidence).toMatchObject({ reason: "name", locator: "jsonld[1].mainEntity.name" });
  });
  it("STORY-051 AUX-R-013 · a listing's product names that only client-rendered markup shows are not a contradiction", async () => {
    const list = { "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{ "@type": "ListItem", position: 1, item: { "@type": "Product", name: "Unshown thing", aggregateRating: { "@type": "AggregateRating", ratingValue: "2.0", reviewCount: "9" } } }] };
    expect(await findings(withLd([org, list], { mainText: "Category\nRated 4.6/5 from 120 reviews." }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-051 AUX-R-013 · two top-level products, neither tied to the page, give no name contradiction", async () => {
    const other = { "@context": "https://schema.org", "@type": "Product", name: "Unshown thing" };
    expect(await findings(withLd([org, app, other], { mainText: CLEAN_TEXT }), "AUX-R-013")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-012 · a price carried by priceSpecification, round 6", () => {
  it("STORY-051 AUX-R-012 · an offer whose price sits in a UnitPriceSpecification is priced", async () => {
    const offers = { "@type": "Offer", priceSpecification: { "@type": "UnitPriceSpecification", price: "47.00", priceCurrency: "USD" } };
    expect(await findings(withApp({ offers }), "AUX-R-012")).toEqual([]);
  });
  it("STORY-051 AUX-R-012 · a priceSpecification with no currency is not priced", async () => {
    const offers = { "@type": "Offer", priceSpecification: { "@type": "UnitPriceSpecification", price: "47.00" } };
    expect((await findings(withApp({ offers }), "AUX-R-012"))[0]!.evidence.reason).toBe("offers_incomplete");
  });
});

// STORY-187 — AUX-R-013 judges name, price and rating only against the page's own subject; an offer set agrees when any member is shown.
describe("STORY-187 AUX-R-013 · the rewrite (review rounds 5-7 corpus)", () => {
  const ctx = "https://schema.org";
  const offer = (price: string) => ({ "@type": "Offer", price, priceCurrency: "USD" });
  const blog = { "@context": ctx, "@type": "BlogPosting", headline: "Five ways to clean a sales pipeline" };
  const siteWide = { "@context": ctx, "@type": "SoftwareApplication", name: "Acme CRM", offers: offer("99"), aggregateRating: { "@type": "AggregateRating", ratingValue: "4.9", reviewCount: "400" } };

  it("STORY-187 AC3a · a SaaS tier offers set [9, 29] against 'Plans start at $9/mo' does not fire", async () => {
    const tiers = { "@context": ctx, "@type": "SoftwareApplication", name: "Acme CRM", offers: [offer("9"), offer("29")] };
    expect(await findings(withLd([org, tiers], { mainText: "Acme CRM\nPricing: plans start at $9/mo" }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-187 AC3b · Product.offers with per-variant prices [39.99, 44.99] against 'Price: $39.99' does not fire", async () => {
    const product = { "@context": ctx, "@type": "Product", name: "Wool coat", offers: [offer("39.99"), offer("44.99")] };
    expect(await findings(withLd([org, product], { mainText: "Wool coat\nPrice: $39.99" }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-187 AC3c · a site-wide product price and rating block on a BlogPosting that discusses other prices and ratings does not fire", async () => {
    const text = { mainText: "Five ways to clean a sales pipeline\nOne rival has a price of $20 per month and is rated 3.1/5 by customers." };
    expect(await findings(withLd([org, siteWide, blog], text), "AUX-R-013")).toEqual([]);
  });
  it("STORY-187 AC1 · a price and rating on a related entity are not judged, but the page's own subject (mainEntity) still is", async () => {
    const page = { "@context": ctx, "@type": "WebPage", mainEntity: { "@type": "Product", name: "Wool coat", offers: offer("39.99"), aggregateRating: { "@type": "AggregateRating", ratingValue: "4.9", reviewCount: "10" } } };
    const hits = await findings(withLd([org, page], { mainText: "Wool coat\nPrice: $59.99\nRated 3.1/5 by customers" }), "AUX-R-013");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ severity: "critical", measured_value: 2 });
  });
  it("STORY-187 AC1 · a related-entity fixture: a product's relatedLink product (offer 5, rating 1.0) is not judged beside its own mainEntity", async () => {
    const page = { "@context": ctx, "@type": "WebPage", mainEntity: { "@type": "Product", name: "Wool coat", offers: offer("39.99"), isRelatedTo: { "@type": "Product", name: "Scarf", offers: offer("5"), aggregateRating: { "@type": "AggregateRating", ratingValue: "1.0", reviewCount: "3" } } } };
    expect(await findings(withLd([org, page], { mainText: "Wool coat\nPrice: $39.99" }), "AUX-R-013")).toEqual([]);
  });
  const product99 = { "@context": ctx, "@type": "Product", name: "Wool coat", offers: offer("99") };
  const faqPage = { "@context": ctx, "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A" } }] };
  const wrongPrice = { mainText: "Wool coat\nPrice: $52" };
  it("STORY-187 AC1 · a top-level Product with a wrong price fires on its own (control)", async () => {
    expect(await findings(withLd([org, product99], wrongPrice), "AUX-R-013")).toHaveLength(1);
  });
  it("STORY-187 AC1 · a FAQPage whose mainEntity is Questions does not hide the top-level Product's wrong price", async () => {
    expect(await findings(withLd([org, product99, faqPage], wrongPrice), "AUX-R-013")).toHaveLength(1);
  });
  it("STORY-187 AC1 · a WebPage.about Thing does not hide the top-level Product's wrong price", async () => {
    const wp = { "@context": ctx, "@type": "WebPage", about: { "@type": "Thing", name: "coats" } };
    expect(await findings(withLd([org, product99, wp], wrongPrice), "AUX-R-013")).toHaveLength(1);
  });
  it("STORY-187 AC1 · a FAQPage's Question is not a name check, and does not hide the top-level Product's price when the page names it", async () => {
    const hits = await findings(withLd([org, faqPage, product99], wrongPrice), "AUX-R-013");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.evidence.reason).toBe("price");
  });
  // Decision 97: scenario D exactly as the auditor's probe writes it.
  const siteApp = { "@context": ctx, "@type": "SoftwareApplication", name: "Acme CRM", offers: offer("99") };
  it("STORY-187 decision 97 · a single site-wide SoftwareApplication (offer 99), no Article schema, page about a rival's $20 and not naming the product: no finding", async () => {
    expect(await findings(withLd([org, siteApp], { mainText: "Guide\nOne rival has a price of $20 per month." }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-187 decision 97 · the same page naming the product with a wrong price fires once", async () => {
    const hits = await findings(withLd([org, siteApp], { mainText: "Acme CRM review\nOne rival has a price of $20 per month." }), "AUX-R-013");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.evidence.reason).toBe("price");
  });
  it("STORY-187 decision 97 · the name is matched ignoring case, spacing and typography (acme   CRM\u2122)", async () => {
    const hits = await findings(withLd([org, siteApp], { mainText: "the  ACME\u00a0crm\u2122 review\nOne rival has a price of $20 per month." }), "AUX-R-013");
    expect(hits).toHaveLength(1);
  });
  it("STORY-187 AC1 · an entity reached from a node that is not the page (Organization.about) is not the page's subject", async () => {
    const orgAbout = { ...org, about: { "@type": "Product", name: "Zebra gizmo", offers: offer("52") } };
    const hits = await findings(withLd([orgAbout, product99], wrongPrice), "AUX-R-013");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ measured_value: 1 });
    expect(hits[0]!.evidence.reason).toBe("price");
  });
  it("STORY-187 AC3c · site-wide product blocks (two top-level products) on a page with no Article schema that discusses a rival price: neither is the subject, so no price is judged", async () => {
    const other = { ...siteWide, name: "Acme Mail" };
    expect(await findings(withLd([org, siteWide, other], { mainText: "Compare\nA rival costs a price of $20 per month." }), "AUX-R-013")).toEqual([]);
  });
  it("STORY-187 AC4 · an offer set of which no member is shown is one disagreement, not one per offer", async () => {
    const product = { "@context": ctx, "@type": "Product", name: "Wool coat", offers: [offer("39.99"), offer("44.99")] };
    const hits = await findings(withLd([org, product], { mainText: "Wool coat\nPrice: $59.99" }), "AUX-R-013");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ severity: "critical", measured_value: 1 });
    expect(hits[0]!.evidence.reason).toBe("price");
  });
  it("STORY-187 AC4 · a blog post whose own mainEntity is the product with a wrong price still fires", async () => {
    const post = { ...blog, mainEntity: { "@type": "Product", name: "Wool coat", offers: offer("39.99") } };
    const hits = await findings(withLd([org, post], { mainText: "Wool coat review\nPrice: $59.99" }), "AUX-R-013");
    expect(hits).toHaveLength(1);
  });
});
