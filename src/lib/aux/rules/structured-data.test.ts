import { describe, expect, it } from "vitest";
import { CLEAN_JSON_LD, CLEAN_TEXT, makeDoc, variant } from "../../../../test/support/aux-document.js";
import { findings, withThresholds } from "../../../../test/support/aux-rules.js";

// STORY-051 — the structured_data rules, AUX-R-008..018, and AUX-R-006 (crawler directive). Each rule is a threshold, so each is
// tested at, below and above it (AC4), and from the hazard the rule exists for.

const org = CLEAN_JSON_LD[0] as Record<string, unknown>;
const app = CLEAN_JSON_LD[1] as Record<string, unknown>;
const withLd = (jsonLd: unknown[], over: Partial<ReturnType<typeof variant>> = {}) => makeDoc({ raw: variant({ structured: { jsonLd, microdata: [], rdfa: [], parseErrors: [] }, ...over }) });
const withApp = (patch: Record<string, unknown>, over: Partial<ReturnType<typeof variant>> = {}) => withLd([org, { ...app, ...patch }], over);
const withoutKey = (o: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
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
  it("STORY-051 AUX-R-013 · a product name absent from the visible text fires", async () => {
    const [f] = await findings(withApp({ name: "Zed Gadget" }), "AUX-R-013");
    expect(f!.evidence).toMatchObject({ reason: "name", locator: "jsonld[1].name" });
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
    const doc = withApp({ name: "Zed Gadget" }, { mainText: CLEAN_TEXT.replace("$47", "$57") });
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
    const [f] = await findings(withLd([typed("WebApplication", { name: "Zed Gadget" })]), "AUX-R-013");
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
  it("STORY-051 AUX-R-013 · Offer 0 with NO free word on a page that prices everything does fire", async () => {
    const [f] = await findings(tiers("Acme Widgets\nEvery plan starts at $47 per month."), "AUX-R-013");
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
    expect(await findings(tiers("Acme Widgets\nA carefree plan. Every plan starts at $47 per month."), "AUX-R-013")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-013 · the free words come from the catalog row", async () => {
    const { withThresholds } = await import("../../../../test/support/aux-rules.js");
    const cat = withThresholds("AUX-R-013", { free_words: ["gratis"] });
    expect(await findings(tiers("Acme Widgets\nFree forever. Pro starts at $47 per month."), "AUX-R-013", cat)).toHaveLength(1);
    expect(await findings(tiers("Acme Widgets\nGratis. Pro starts at $47 per month."), "AUX-R-013", cat)).toEqual([]);
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
