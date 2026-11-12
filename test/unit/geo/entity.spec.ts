import { describe, expect, it } from "vitest";
import { geoAnalysisWriteSchema, geoEntityDetailSchema } from "../../../contracts/analytics/index.js";
import {
  buildEntity,
  casedSpellings,
  casedVariants,
  deriveNodeRecord,
  disambiguationLevel,
  ENTITY_ALIAS_TASK_RULE,
  ENTITY_MIN_CATEGORY_PASSAGES,
  ENTITY_MIN_NAME_MATCHES,
  ENTITY_NODE_TASK_RULE,
  HEURISTIC_JUDGE,
  insideUrlOrDomain,
  isAmbiguousNameMatch,
  judgeNameMatch,
  mentionContext,
  spanOfMention,
  termPattern,
  type EntityInput,
  type EntityNodeRecord,
} from "../../../src/lib/geo/entity.js";

// STORY-060 — A2 entity readiness (pure). Scenario numbers are the story's table. Hand-computed values come from
// scoring-models.md §10: EntityAuthority = 100 · (0.75 · Σ NODES(n)·presence(n) + 0.25 · sameas_coverage).

const node = (n: EntityNodeRecord["node"], over: Partial<EntityNodeRecord> = {}): EntityNodeRecord => ({
  node: n,
  present: true,
  complete: true,
  url: `https://${n}.example/acme`,
  missingFields: [],
  inBrandSameas: true,
  ...over,
});
const absent = (n: EntityNodeRecord["node"]): EntityNodeRecord => node(n, { present: false, complete: false, url: null, inBrandSameas: false });

/** All seven scored nodes checked. wikidata/linkedin/g2 complete+linked, wikipedia/category_directory thin+unlinked, crunchbase/github absent. */
const KNOWN: EntityNodeRecord[] = [
  node("wikidata"),
  node("wikipedia", { complete: false, missingFields: ["founded", "headquarters"], inBrandSameas: false }),
  node("g2"),
  absent("capterra"),
  absent("crunchbase"),
  node("linkedin"),
  absent("github"),
  node("category_directory", { complete: false, missingFields: ["description", "pricing"], inBrandSameas: false }),
];

const input = (over: Partial<EntityInput> = {}): EntityInput => ({
  windowStart: "2026-09-08",
  windowDays: 30,
  rootDomain: "acme.com",
  // A MODEL judge (STORY-191): the figure is publishable. The guard tests below use HEURISTIC_JUDGE.
  judge: "fixture-model:name-match-v1",
  nodes: KNOWN,
  nameMatches: 100,
  unjudged: 0,
  notAboutBrand: 2,
  cooccurrence: { terms: ["crm"], categoryPassages: 40, entities: [{ name: "Acme", isBrand: true, passages: 12 }, { name: "Rival", isBrand: false, passages: 20 }] },
  ...over,
});

describe("STORY-060 · A2 entity readiness (pure)", () => {
  it("#1 · present, absent and thin nodes record presence and completeness separately", () => {
    const { detail } = buildEntity(input());
    const by = Object.fromEntries(detail!.nodes.map((n) => [n.node, n]));
    expect(by.wikidata).toMatchObject({ status: "complete", presence: 1 });
    expect(by.wikipedia).toMatchObject({ status: "thin", presence: 0.6, missing_fields: ["founded", "headquarters"], url: "https://wikipedia.example/acme" });
    expect(by.crunchbase).toMatchObject({ status: "absent", presence: 0, url: null });
    expect(detail!.nodes.map((n) => n.node)).toEqual(["wikidata", "wikipedia", "g2_or_capterra", "crunchbase", "linkedin", "github", "category_directory"]);
    expect(geoEntityDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("#2 · the authority score matches the hand-computed value (66.3)", () => {
    // Σ = .22·1 + .14·.6 + .18·1 + .08·1 + .20·.6 = 0.684; present nodes 5, linked 3 -> coverage 0.6
    // 100 · (0.75·0.684 + 0.25·0.6) = 66.3
    const { write, detail } = buildEntity(input());
    expect(write.score).toBe(66.3);
    expect(write.score_label).toBe("Entity Authority");
    expect(detail!.sameas_coverage).toBe(0.6);
    expect(detail!.authority).toEqual({ score: 66.3, suppressed: false, reason: null });
  });

  it("a perfect set scores 100 and an all-absent set scores 0 (a computed zero is not a missing score)", () => {
    const all = (mk: (n: EntityNodeRecord["node"]) => EntityNodeRecord): EntityNodeRecord[] =>
      (["wikidata", "wikipedia", "g2", "crunchbase", "linkedin", "github", "category_directory"] as const).map(mk);
    expect(buildEntity(input({ nodes: all((n) => node(n)) })).write.score).toBe(100);
    const none = buildEntity(input({ nodes: all(absent) }));
    expect(none.write.score).toBe(0);
    expect(none.detail!.sameas_coverage).toBeNull();
  });

  it("g2 and capterra are ONE scored node: either present counts once, and absent only when both are", () => {
    const base = KNOWN.filter((n) => n.node !== "g2" && n.node !== "capterra");
    const capterraOnly = buildEntity(input({ nodes: [...base, absent("g2"), node("capterra")] })).detail!;
    expect(capterraOnly.nodes.find((n) => n.node === "g2_or_capterra")).toMatchObject({ status: "complete", url: "https://capterra.example/acme" });
    const both = buildEntity(input({ nodes: [...base, node("g2"), node("capterra")] }));
    expect(both.write.score).toBe(66.3);
  });

  it("#3 · a profile that exists but is not linked from the brand's structured data is a link gap with a fix path", () => {
    const { detail, write } = buildEntity(input());
    const wiki = detail!.nodes.find((n) => n.node === "wikipedia")!;
    expect(wiki.link_gap).toBe(true);
    expect(wiki.fix_path).toMatch(/sameAs/u);
    expect(detail!.nodes.find((n) => n.node === "wikidata")!.link_gap).toBe(false);
    // An absent node is not a link gap: there is nothing to link.
    expect(detail!.nodes.find((n) => n.node === "github")!.link_gap).toBe(false);
    expect(write.findings.find((f) => f.id === "entity-link-gap")!.headline).toMatch(/2 profiles/u);
  });

  it("#4 · HIGH disambiguation risk suppresses the score and surfaces the alias-tuning task", () => {
    const { write, detail } = buildEntity(input({ nameMatches: 100, notAboutBrand: 21 }));
    expect(write.score).toBeNull();
    expect(write.sufficient).toBe(true);
    expect(detail!.authority.suppressed).toBe(true);
    expect(detail!.authority.score).toBeNull();
    expect(detail!.authority.reason).toMatch(/disambiguation risk/iu);
    expect(detail!.disambiguation).toMatchObject({ risk: 0.21, level: "high" });
    const alias = write.findings.find((f) => f.task_rule_code === ENTITY_ALIAS_TASK_RULE)!;
    expect(alias.severity).toBe("high");
    expect(alias.evidence.length).toBeGreaterThan(0);
    // The node facts are still reported; only the figure is withheld.
    expect(detail!.nodes.find((n) => n.node === "wikidata")!.status).toBe("complete");
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
  });

  it("#5 · LOW risk publishes the score and reports the risk separately; risk never moves the score", () => {
    const low = buildEntity(input({ nameMatches: 100, notAboutBrand: 2 }));
    const medium = buildEntity(input({ nameMatches: 100, notAboutBrand: 10 }));
    expect(low.write.score).toBe(66.3);
    expect(low.detail!.disambiguation).toMatchObject({ risk: 0.02, level: "low", name_matches: 100, not_about_brand: 2 });
    expect(medium.detail!.disambiguation.level).toBe("medium");
    expect(medium.write.score).toBe(low.write.score);
    expect(low.write.findings.some((f) => f.task_rule_code === ENTITY_ALIAS_TASK_RULE)).toBe(false);
  });

  it("risk bands: < 0.05 low, 0.05..0.20 medium (both ends included), > 0.20 high", () => {
    expect(disambiguationLevel(0.0499)).toBe("low");
    expect(disambiguationLevel(0.05)).toBe("medium");
    expect(disambiguationLevel(0.2)).toBe("medium");
    expect(disambiguationLevel(0.2001)).toBe("high");
    expect(disambiguationLevel(0)).toBe("low");
    expect(disambiguationLevel(1)).toBe("high");
  });

  it("100 matches all unjudged (a lowercase-only brand) is UNMEASURED, the score is withheld, and entity-ready is not emitted", () => {
    const { write, detail } = buildEntity(input({ nameMatches: 100, unjudged: 100, notAboutBrand: 0 }));
    expect(detail!.disambiguation).toMatchObject({ risk: null, level: "unmeasured", name_matches: 100, unjudged: 100 });
    expect(write.score).toBeNull();
    expect(write.findings.some((f) => f.id === "entity-ready")).toBe(false);
  });

  it("fewer than the minimum name matches leaves risk UNMEASURED (null, not 0) and the score is WITHHELD with a stated reason, even when most matches look like false positives", () => {
    const { write, detail } = buildEntity(input({ nameMatches: ENTITY_MIN_NAME_MATCHES - 1, notAboutBrand: 20 }));
    expect(detail!.disambiguation).toMatchObject({ risk: null, level: "unmeasured", minimum_matches: ENTITY_MIN_NAME_MATCHES });
    expect(write.score).toBeNull();
    expect(write.suppression_reason).toMatch(/cannot be measured/u);
    expect(detail!.authority).toMatchObject({ score: null, suppressed: true });
    expect(detail!.authority.reason).toMatch(/cannot be measured/u);
    expect(write.findings.some((f) => f.id === "entity-ready")).toBe(false);
    // exactly the minimum IS measured, and is published
    const atMin = buildEntity(input({ nameMatches: ENTITY_MIN_NAME_MATCHES, notAboutBrand: 0 }));
    expect(atMin.detail!.disambiguation).toMatchObject({ risk: 0, level: "low" });
    expect(atMin.write.score).toBe(66.3);
  });

  it("#6 · a missing high-weight node (weight >= 0.18) raises a finding carrying the TG-ENTITY-NODE rule code (no task is generated here); a missing low-weight node does not", () => {
    const missingWikidata = buildEntity(input({ nodes: KNOWN.map((n) => (n.node === "wikidata" ? absent("wikidata") : n)) }));
    const f = missingWikidata.write.findings.find((x) => x.id === "entity-node-missing-wikidata")!;
    expect(f.task_rule_code).toBe(ENTITY_NODE_TASK_RULE);
    expect(f.severity).toBe("medium");
    expect(f.evidence[0]!.url).toMatch(/^https:\/\//u);
    // crunchbase (0.10) and github (0.08) are absent in KNOWN and raise nothing; neither does the thin category_directory (present).
    const ids = buildEntity(input()).write.findings.map((x) => x.id);
    expect(ids.filter((i) => i.startsWith("entity-node-missing"))).toEqual([]);
    // 0.18 is the boundary: g2_or_capterra (exactly 0.18) missing IS high-weight.
    const noG2 = buildEntity(input({ nodes: KNOWN.map((n) => (n.node === "g2" ? absent("g2") : n)) }));
    expect(noG2.write.findings.some((x) => x.id === "entity-node-missing-g2_or_capterra")).toBe(true);
  });

  it("#10 · below the evidence minimum the analysis suppresses itself with a stated reason", () => {
    // Nothing measurable at all: no node checked, too few name matches, no category passages.
    const empty = { nameMatches: 0, unjudged: 0, notAboutBrand: 0, cooccurrence: { terms: [], categoryPassages: 0, entities: [] } };
    const none = buildEntity(input({ nodes: [], ...empty }));
    expect(none.write.sufficient).toBe(false);
    expect(none.write.suppression_reason).toMatch(/not been checked/u);
    expect(none.write.score).toBeNull();
    expect(none.write.findings).toEqual([]);
    expect(none.detail).toBeNull();
    const partial = buildEntity(input({ nodes: KNOWN.filter((n) => n.node !== "github" && n.node !== "linkedin"), ...empty }));
    expect(partial.write.sufficient).toBe(false);
    expect(partial.write.suppression_reason).toMatch(/github/u);
    expect(partial.write.suppression_reason).toMatch(/linkedin/u);
    expect(geoAnalysisWriteSchema.safeParse(partial.write).success).toBe(true);
  });

  it("#5/#6/#8 · risk and co-occurrence do not wait for the profile check: unchecked nodes withhold only the score", () => {
    const { write, detail } = buildEntity(input({ nodes: [], nameMatches: 100, notAboutBrand: 21 }));
    expect(write.sufficient).toBe(true);
    expect(write.score).toBeNull();
    expect(detail!.nodes).toHaveLength(7);
    expect(detail!.nodes.every((n) => n.status === "unchecked" && n.presence === 0 && !n.link_gap && n.fix_path === null)).toBe(true);
    expect(detail!.sameas_coverage).toBeNull();
    expect(detail!.disambiguation).toMatchObject({ risk: 0.21, level: "high" });
    expect(detail!.authority).toMatchObject({ score: null, suppressed: true });
    expect(write.findings.some((f) => f.task_rule_code === ENTITY_ALIAS_TASK_RULE)).toBe(true);
    // An unchecked node is not an absent one: no missing-node finding is invented.
    expect(write.findings.some((f) => f.id.startsWith("entity-node-missing"))).toBe(false);
    expect(detail!.cooccurrence.sufficient).toBe(true);
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
    expect(geoEntityDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("partly checked nodes publish no score and no node-based finding, and name the unchecked ones", () => {
    const { write, detail } = buildEntity(input({ nodes: KNOWN.filter((n) => n.node !== "github") }));
    expect(write.sufficient).toBe(true);
    expect(write.score).toBeNull();
    expect(detail!.authority).toMatchObject({ score: null, suppressed: false });
    expect(detail!.authority.reason).toMatch(/github/u);
    expect(write.suppression_reason).toMatch(/github/u);
    expect(detail!.nodes.find((n) => n.node === "github")!.status).toBe("unchecked");
    expect(write.findings.some((f) => f.id.startsWith("entity-node-missing") || f.id === "entity-link-gap")).toBe(false);
    expect(detail!.disambiguation.level).toBe("low");
  });

  // STORY-060 E7 / owner decision 99(b): the profile probe checks Wikidata and Wikipedia ONLY, so the missing-node finding (and with it the alert and the
  // task) must not wait for all seven nodes: a CHECKED, absent, high-weight node is a missing node whatever the other nodes' state.
  it("E7 · a CHECKED absent high-weight node raises its finding and task rule while the other five nodes are unchecked and the score stays withheld", () => {
    const { write, detail } = buildEntity(input({ nodes: [absent("wikidata"), absent("wikipedia")] }));
    expect(write.score).toBeNull();
    expect(detail!.authority).toMatchObject({ score: null });
    const missing = write.findings.filter((f) => f.id.startsWith("entity-node-missing"));
    // wikidata weighs 0.22 (>= 0.18): a finding with the task rule. wikipedia weighs 0.14: none.
    expect(missing.map((f) => f.id)).toEqual(["entity-node-missing-wikidata"]);
    expect(missing[0]).toMatchObject({ task_rule_code: ENTITY_NODE_TASK_RULE, severity: "medium", metric: { name: "node_weight", value: 0.22, target: 0.18 } });
    expect(missing[0]!.evidence.length).toBeGreaterThan(0);
    expect(detail!.nodes.filter((n) => n.status === "unchecked")).toHaveLength(5);
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
  });

  it("E7 · a checked, absent, high-weight node is a measured fact: with risk UNMEASURED and no co-occurrence, the missing-node finding is still written (the analysis is not 'insufficient')", () => {
    const { write, detail } = buildEntity(input({ nodes: [absent("wikidata"), absent("wikipedia")], nameMatches: 0, notAboutBrand: 0, cooccurrence: { terms: [], categoryPassages: 0, entities: [] } }));
    expect(write.sufficient).toBe(true);
    expect(write.score).toBeNull();
    expect(write.findings.map((f) => f.id)).toContain("entity-node-missing-wikidata");
    expect(detail!.disambiguation.level).toBe("unmeasured");
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
    // ...and with NO node checked, or only present or low-weight nodes, and nothing else measurable it stays insufficient, as before.
    expect(buildEntity(input({ nodes: [node("wikidata"), absent("wikipedia")], nameMatches: 0, notAboutBrand: 0, cooccurrence: { terms: [], categoryPassages: 0, entities: [] } })).write.sufficient).toBe(false);
    expect(buildEntity(input({ nodes: [], nameMatches: 0, notAboutBrand: 0, cooccurrence: { terms: [], categoryPassages: 0, entities: [] } })).write.sufficient).toBe(false);
  });

  it("E7 · an UNCHECKED node is never a missing one, and a present high-weight node raises nothing", () => {
    expect(buildEntity(input({ nodes: [absent("wikipedia")] })).write.findings.some((f) => f.id.startsWith("entity-node-missing"))).toBe(false);
    expect(buildEntity(input({ nodes: [node("wikidata"), absent("wikipedia")] })).write.findings.some((f) => f.id.startsWith("entity-node-missing"))).toBe(false);
  });

  it("E7 · the finding does not depend on the judge: the heuristic guard withholds the score, never the missing-node finding", () => {
    const { write } = buildEntity(input({ nodes: [absent("wikidata")], judge: HEURISTIC_JUDGE }));
    expect(write.score).toBeNull();
    expect(write.findings.map((f) => f.id)).toContain("entity-node-missing-wikidata");
  });

  it("co-occurrence: the brand's rate against each competitor's, over the passages that carry a category term", () => {
    const { detail } = buildEntity(input());
    expect(detail!.cooccurrence).toMatchObject({ sufficient: true, reason: null, terms: ["crm"], category_passages: 40 });
    expect(detail!.cooccurrence.entities).toEqual([
      { name: "Acme", is_brand: true, passages: 12, rate: 0.3 },
      { name: "Rival", is_brand: false, passages: 20, rate: 0.5 },
    ]);
  });

  it("co-occurrence below the passage minimum states why and publishes no rate (null, not 0)", () => {
    const { detail } = buildEntity(input({ cooccurrence: { terms: ["crm"], categoryPassages: ENTITY_MIN_CATEGORY_PASSAGES - 1, entities: [{ name: "Acme", isBrand: true, passages: 0 }] } }));
    expect(detail!.cooccurrence.sufficient).toBe(false);
    expect(detail!.cooccurrence.reason).toMatch(/8 cited passages/u);
    expect(detail!.cooccurrence.entities[0]!.rate).toBeNull();
    // no category terms at all is also stated, not a zero
    const noTerms = buildEntity(input({ cooccurrence: { terms: [], categoryPassages: 0, entities: [] } })).detail!.cooccurrence;
    expect(noTerms.sufficient).toBe(false);
    expect(noTerms.reason).toMatch(/category/u);
  });

  it("a brand named in none of the category passages has a rate of 0, which is a finding, not an absence", () => {
    const { detail, write } = buildEntity(input({ cooccurrence: { terms: ["crm"], categoryPassages: 40, entities: [{ name: "Acme", isBrand: true, passages: 0 }, { name: "Rival", isBrand: false, passages: 10 }] } }));
    expect(detail!.cooccurrence.entities[0]!.rate).toBe(0);
    expect(write.findings.some((f) => f.id === "entity-category-cooccurrence")).toBe(true);
  });

  it("a fully ready brand still persists its detail: the detail rides on a no-action finding, never dropped", () => {
    const all = (["wikidata", "wikipedia", "g2", "crunchbase", "linkedin", "github", "category_directory"] as const).map((n) => node(n));
    const { write, detail } = buildEntity(input({ nodes: all, cooccurrence: { terms: [], categoryPassages: 0, entities: [] } }));
    expect(write.findings).toHaveLength(1);
    expect(write.findings[0]!.no_action).toBe(true);
    expect(write.findings[0]!.entity).toEqual(detail);
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
  });

  it("every finding is evidenced and terminates in a task rule or a no-action verdict", () => {
    for (const over of [{}, { notAboutBrand: 40 }, { nodes: KNOWN.map((n) => (n.node === "wikidata" ? absent("wikidata") : n)) }]) {
      expect(geoAnalysisWriteSchema.safeParse(buildEntity(input(over)).write).success).toBe(true);
    }
  });
});

describe("STORY-060 · entity node records and name-match judging (pure)", () => {
  it("a profile missing 2 or more core fields is incomplete; 0 or 1 missing is complete", () => {
    const rec = (missing: string[]) => deriveNodeRecord({ node: "github", url: "https://github.com/acme", missingFields: missing }, []);
    expect(rec([]).complete).toBe(true);
    expect(rec(["bio"]).complete).toBe(true);
    expect(rec(["bio", "website"]).complete).toBe(false);
    expect(rec(["bio", "website"])).toMatchObject({ present: true, missingFields: ["bio", "website"] });
  });

  it("an absent check records no url and is never linked", () => {
    expect(deriveNodeRecord({ node: "github", url: null, missingFields: [] }, ["https://github.com/acme"])).toMatchObject({ present: false, complete: false, url: null, inBrandSameas: false });
  });

  it("in_brand_sameas compares normalised URLs (case, www, trailing slash, fragment, scheme-insensitive host)", () => {
    const linked = (sameAs: string[]) => deriveNodeRecord({ node: "linkedin", url: "https://www.linkedin.com/company/acme/", missingFields: [] }, sameAs).inBrandSameas;
    expect(linked(["http://LinkedIn.com/company/acme"])).toBe(true);
    expect(linked(["https://linkedin.com/company/acme#about"])).toBe(true);
    expect(linked(["https://linkedin.com/company/other"])).toBe(false);
    expect(linked([])).toBe(false);
  });

  it("judgeNameMatch: a lowercase use of a capitalised brand name is a common word, not the brand", () => {
    expect(judgeNameMatch({ alias: "Notion", span: "notion" })).toBe("not_about_brand");
    expect(judgeNameMatch({ alias: "Notion", span: "Notion" })).toBe("about_brand");
    expect(judgeNameMatch({ alias: "Notion", span: "NOTION" })).toBe("about_brand");
    // an alias that is itself lowercase carries no case signal: never guessed to be a false positive
    expect(judgeNameMatch({ alias: "Notion", span: "" })).toBe("unjudged");
    // a span that is not the alias once folded is a misread offset: unjudged, neither a false positive nor evidence it is the brand
    expect(judgeNameMatch({ alias: "Notion", span: "otion " })).toBe("unjudged");
    expect(judgeNameMatch({ alias: "Notion", span: "ion" })).toBe("unjudged");
    // diacritic folding is the matcher's: "Café" matched as "cafe" is still the same name
    expect(judgeNameMatch({ alias: "Café", span: "café" })).toBe("not_about_brand");
  });

  it("judgeNameMatch: a brand whose cased spelling has no uppercase letter gives the case heuristic no signal, so every match is unjudged (never about_brand)", () => {
    const mc = (raw: string, span: string) => mentionContext(raw, raw.indexOf(span), raw.indexOf(span) + span.length)!;
    for (const span of ["monday", "Monday", "MONDAY"]) expect(judgeNameMatch({ alias: "monday", ...mc(`See you on ${span} then.`, span) }), span).toBe("unjudged");
    expect(judgeNameMatch({ alias: "acme", span: "acme" })).toBe("unjudged");
    // even a domain-shaped use: the heuristic has no signal for this brand, so it is not counted as judged
    expect(judgeNameMatch({ alias: "monday", ...mc("Visit monday.com now.", "monday") })).toBe("unjudged");
  });

  it("spanOfMention: offsets index the NORMALISED text, so a raw CRLF, triple blank line, zero-width or astral character before the mention cannot shift the span", () => {
    const raw = "\u{1F680} Launch\r\n\n\n\u200BWe like Notion a lot";
    const normalised = "\u{1F680} Launch\n\nWe like Notion a lot";
    const start = normalised.indexOf("Notion");
    expect(spanOfMention(raw, start, start + 6)).toBe("Notion");
    expect(judgeNameMatch({ alias: "Notion", span: spanOfMention(raw, start, start + 6)! })).toBe("about_brand");
    // no text held, or an offset outside it, is unreadable (null), never a guess
    expect(spanOfMention(null, 0, 3)).toBeNull();
    expect(spanOfMention("abc", 2, 9)).toBeNull();
    expect(spanOfMention("abc", 2, 2)).toBeNull();
  });
});

describe("STORY-060 hazard · termPattern is a Postgres ARE for a literal term", () => {
  it("never backslash-escapes a letter or digit of any script (a backslash before an alphanumeric is an ARE escape or an error)", () => {
    for (const term of ["Café", "Müller", "Año", "Яндекс", "東京", "naïve co"]) {
      expect(termPattern(term), term).not.toMatch(/\\[\p{L}\p{N}]/u);
      expect(termPattern(term), term).toContain(term);
    }
  });
  it("escapes every regex metacharacter", () => {
    expect(termPattern("C++")).toContain("C\\+\\+");
    expect(termPattern("a.b|c(d)[e]{f}^$?*\\")).toContain("a\\.b\\|c\\(d\\)\\[e\\]\\{f\\}\\^\\$\\?\\*\\\\");
  });
  it("bounds by lookaround, not \\m...\\M, so a term starting or ending in a non-word character still has a boundary", () => {
    expect(termPattern(".NET")).not.toMatch(/\\m|\\M/u);
    expect(termPattern("C++")).not.toMatch(/\\m|\\M/u);
  });
});

describe("STORY-060 hazard · a brand written as its domain or URL is the brand, not a common word", () => {
  const ctx = (raw: string, span: string) => mentionContext(raw, raw.indexOf(span), raw.indexOf(span) + span.length)!;
  it("a lowercase span followed by a TLD, or inside a URL or markdown link target, is about the brand", () => {
    for (const [raw, span] of [
      ["Try notion.so for notes.", "notion"],
      ["See https://www.notion.so/pricing today.", "notion"],
      ["See [the docs](notion.so/docs) now.", "notion"],
      ["Visit www.notion.com now.", "notion"],
    ] as const) {
      expect(judgeNameMatch({ alias: "Notion", ...ctx(raw, span) }), raw).toBe("about_brand");
    }
  });
  it("a lowercase common-word use is still not about the brand, including before a full stop and a space", () => {
    expect(judgeNameMatch({ alias: "Notion", ...ctx("That is a notion. So we left.", "notion") })).toBe("not_about_brand");
    expect(judgeNameMatch({ alias: "Notion", ...ctx("A vague notion of safety.", "notion") })).toBe("not_about_brand");
    expect(insideUrlOrDomain("a ", ". So")).toBe(false);
    // markdown link text is the brand being linked
    expect(insideUrlOrDomain("see [", "](https://notion.so)")).toBe(true);
  });
});

describe("STORY-060 · cased spellings", () => {
  it("a lowercase alias never replaces the cased spelling of the same name, in either order", () => {
    expect(casedSpellings(["Notion", "notion"]).get("notion")).toBe("Notion");
    expect(casedSpellings(["notion", "Notion"]).get("notion")).toBe("Notion");
    expect(casedSpellings(["notion"]).get("notion")).toBe("notion");
  });
  it("a cased alias is accepted as spelled, in capitals and capitalised, never lowercase", () => {
    expect(casedVariants("HubSpot")).toEqual(["HubSpot", "HUBSPOT", "Hubspot"]);
    expect(casedVariants("Notion")).toEqual(["Notion", "NOTION"]);
  });
});

// STORY-191 - the owner-decision-17 publish guard, and the matches only a model is asked about.

const ALL_SEVEN_PRESENT: EntityNodeRecord[] = (["wikidata", "wikipedia", "g2", "crunchbase", "linkedin", "github", "category_directory"] as const).map((n) => node(n));

describe("STORY-191 AC8 · the publish guard: no Entity Authority score while the judge in force is the v1 heuristic", () => {
  it("every node checked, every node complete and linked, risk LOW: the score is still null, suppressed, with a stated reason", () => {
    const { write, detail } = buildEntity(input({ nodes: ALL_SEVEN_PRESENT, judge: HEURISTIC_JUDGE, nameMatches: 100, notAboutBrand: 1 }));
    expect(write.score).toBeNull();
    expect(detail!.authority.score).toBeNull();
    expect(detail!.authority.suppressed).toBe(true);
    expect(detail!.authority.reason).toMatch(/v1 case heuristic/iu);
    // The risk and the node facts are still reported, separately.
    expect(detail!.disambiguation).toMatchObject({ level: "low", risk: 0.01 });
    expect(detail!.nodes.every((n) => n.status === "complete")).toBe(true);
    // No "ready" verdict is issued for a figure that is not published.
    expect(write.findings.map((f) => f.id)).not.toContain("entity-ready");
  });

  it("the same input under a MODEL judge publishes (the guard is lifted by binding the judge, and only by that)", () => {
    const { write, detail } = buildEntity(input({ nodes: ALL_SEVEN_PRESENT, judge: "gemini-2.5-flash:name-match-v1", nameMatches: 100, notAboutBrand: 1 }));
    expect(write.score).toBe(100);
    expect(detail!.authority).toEqual({ score: 100, suppressed: false, reason: null });
    expect(write.findings.map((f) => f.id)).not.toContain("entity-nodes-unchecked");
  });

  it("no input shape publishes by omission: an empty or unknown judge identity is not the heuristic, but the heuristic identity is the ONLY one the guard names", () => {
    expect(HEURISTIC_JUDGE).toBe("heuristic-v1");
    expect(buildEntity(input({ nodes: ALL_SEVEN_PRESENT, judge: "heuristic-v1" })).write.score).toBeNull();
  });
});

describe("STORY-191 AC4 · isAmbiguousNameMatch names exactly the matches the v1 heuristic gets wrong or cannot judge", () => {
  const at = (raw: string, span: string, alias = "Notion") => {
    const start = raw.indexOf(span);
    return { alias, span, before: raw.slice(Math.max(0, start - 64), start), after: raw.slice(start + span.length, start + span.length + 16) };
  };

  it("a capitalised common word at the start of a sentence is ambiguous (the heuristic passes it as the brand)", () => {
    for (const raw of ["Notion is a concept in philosophy.", "It was late. Notion was not on anyone's mind.", "Stop!\nNotion was a thing", "Why? Notion"]) {
      const m = at(raw, "Notion");
      expect(judgeNameMatch(m), raw).toBe("about_brand");
      expect(isAmbiguousNameMatch(m), raw).toBe(true);
    }
  });

  it("a capitalised word inside markup or a heading is ambiguous", () => {
    for (const raw of ["## Notion", "- **Notion** helps teams", "| Tool | Notion |", "use `Notion` here", "1. Notion"]) {
      expect(isAmbiguousNameMatch(at(raw, "Notion")), raw).toBe(true);
    }
  });

  it("a lowercase-only brand such as monday is ambiguous in every casing (unjudged under v1)", () => {
    for (const span of ["monday", "Monday", "MONDAY"]) {
      const m = at(`See you on ${span} then.`, span, "monday");
      expect(judgeNameMatch(m)).toBe("unjudged");
      expect(isAmbiguousNameMatch(m)).toBe(true);
    }
  });

  it("the matches the heuristic settles firmly are NOT sent to a model", () => {
    // mid-sentence capitalised use, a URL or domain, the lowercase common word of a cased brand, a misread offset
    expect(isAmbiguousNameMatch(at("We use Notion daily.", "Notion"))).toBe(false);
    expect(isAmbiguousNameMatch(at("Open notion.so now", "notion"))).toBe(false);
    expect(isAmbiguousNameMatch(at("Visit https://www.notion.so/x", "notion"))).toBe(false);
    expect(isAmbiguousNameMatch(at("That is a notion we like.", "notion"))).toBe(false);
    expect(isAmbiguousNameMatch({ alias: "Notion", span: "otion " })).toBe(false);
    expect(isAmbiguousNameMatch({ alias: "Notion", span: "" })).toBe(false);
  });

  it("judgeNameMatch itself is unchanged: it is still the fallback verdict", () => {
    expect(judgeNameMatch(at("Notion is a concept.", "Notion"))).toBe("about_brand");
    expect(judgeNameMatch(at("That is a notion we like.", "notion"))).toBe("not_about_brand");
  });
});
