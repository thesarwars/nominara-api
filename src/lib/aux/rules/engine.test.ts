import { describe, expect, it } from "vitest";
import { guidanceFor, NON_FIXABLE_RULES } from "../patches/guidance.js";
import { loadAuxCatalog, type AuxCatalog } from "../catalog.js";
import { AuxRuleConfigError, AuxRuleEvaluationError, evaluateDocument, evaluateDocuments } from "./engine.js";
import { AUX_RULES, AUX_RULES_NOT_EVALUATED } from "./index.js";
import { CATALOG, CATALOG_ROWS, PROJECT_ID, findings, runAll } from "../../../../test/support/aux-rules.js";
import { block, makeDoc, variant } from "../../../../test/support/aux-document.js";

const broken = () => makeDoc({ raw: variant({ tokenCount: 30_000, mainTokenCount: 100 }), blocks: [block({ tokens: 4000 })], timing: { ttfbMs: 5000, loadMs: 9000, bytes: 1 } });

describe("STORY-051 · the rule engine", () => {
  it("STORY-051 AC1 · every catalog rule is evaluated by a rule or named as not evaluated; none is dropped", () => {
    const evaluated = AUX_RULES.map((r) => r.code);
    const named = Object.keys(AUX_RULES_NOT_EVALUATED);
    const siteFile = ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007"];
    const all = [...evaluated, ...named, ...siteFile].sort();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(CATALOG_ROWS.map((r) => r.code));
  });

  it("STORY-051 AC1 · the rules not evaluated each carry a reason that names what is missing", () => {
    expect(Object.keys(AUX_RULES_NOT_EVALUATED).sort()).toEqual(["AUX-R-005", "AUX-R-028", "AUX-R-031", "AUX-R-032", "AUX-R-033", "AUX-R-034"]);
    for (const reason of Object.values(AUX_RULES_NOT_EVALUATED)) expect(reason.length).toBeGreaterThan(30);
  });

  it("STORY-051 AC2 · a clean page raises no finding from any rule", async () => {
    expect(await runAll(makeDoc())).toEqual([]);
  });

  it("STORY-051 AC2 · the same document and catalog give byte-identical findings, in a fixed order", async () => {
    const a = await runAll(broken());
    const b = await runAll(broken());
    expect(a.length).toBeGreaterThan(3);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.map((f) => f.rule_code)).toEqual([...a.map((f) => f.rule_code)].sort());
  });

  it("STORY-051 AC3 · every finding carries measured value, threshold, URL, snippet or reason, locator, and the rule version", async () => {
    for (const f of await runAll(broken())) {
      expect(f.url).toBe("https://example.com/products/acme");
      expect(f.evidence.locator.length).toBeGreaterThan(0);
      expect(f.evidence.reason.length).toBeGreaterThan(0);
      expect(f.measured_value).not.toBeUndefined();
      expect(f.threshold_value).not.toBeUndefined();
      expect(f.rule_version).toBe(CATALOG.byCode.get(f.rule_code)!.ruleVersion);
    }
  });

  it("STORY-051 AC5 · findings record the rule version of the row they were measured against", async () => {
    const rows = CATALOG_ROWS.map((r) => (r.code === "AUX-R-019" ? { ...r, ruleVersion: "2027.1.0" } : r));
    const [f] = (await runAll(broken(), loadAuxCatalog(rows))).filter((x) => x.rule_code === "AUX-R-019");
    expect(f!.rule_version).toBe("2027.1.0");
  });

  it("STORY-051 AC5 · a rule whose catalog row is missing fails the page closed rather than passing it", async () => {
    // Built by hand: the loader refuses a category that no longer sums to one, so this is the engine's own guard.
    const rules = CATALOG_ROWS.filter((r) => r.code !== "AUX-R-019");
    const catalog: AuxCatalog = { rules, byCode: new Map(rules.map((r) => [r.code, r])) };
    await expect(evaluateDocument(makeDoc(), catalog, AUX_RULES, { projectId: PROJECT_ID })).rejects.toBeInstanceOf(AuxRuleConfigError);
  });

  it("STORY-051 AC5 · thresholds that do not match the rule's shape fail closed, naming the rule, not the page", async () => {
    const rows = CATALOG_ROWS.map((r) => (r.code === "AUX-R-019" ? { ...r, thresholds: { warn_tokens: "lots" } } : r));
    const err = await evaluateDocument(makeDoc(), loadAuxCatalog(rows), AUX_RULES, { projectId: PROJECT_ID }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuxRuleEvaluationError);
    expect((err as AuxRuleEvaluationError).ruleCode).toBe("AUX-R-019");
    expect((err as Error).message).not.toContain("example.com");
  });

  it("STORY-051 AC12 · each rule declares auto-fixability, and it agrees with the catalog and with the STORY-053 guidance set", () => {
    for (const rule of AUX_RULES) {
      const row = CATALOG_ROWS.find((r) => r.code === rule.code)!;
      expect(rule.autoFixable, rule.code).toBe(row.autoFixable);
      expect(NON_FIXABLE_RULES.includes(rule.code), rule.code).toBe(!rule.autoFixable);
      expect(rule.category, rule.code).toBe(row.category);
    }
  });

  it("STORY-051 #11 · a non-fixable rule's finding carries guidance and an alignment link, never an empty patch", async () => {
    const fs = (await runAll(broken())).filter((f) => !f.auto_fixable);
    expect(fs.length).toBeGreaterThan(2);
    for (const f of fs) {
      expect(f.guidance, f.rule_code).toEqual(guidanceFor(f.rule_code, { projectId: PROJECT_ID, url: f.url }));
      expect(f.guidance!.steps.length).toBeGreaterThan(0);
      expect(f.guidance!.alignment_link).toEqual({ path: "/geo/alignment", target_url: f.url });
    }
  });

  it("STORY-051 #11 · an auto-fixable rule's finding carries no guidance (its fix is a patch)", async () => {
    const doc = makeDoc({ meta: { ...makeDoc().meta, directives: ["noai"] } });
    expect((await findings(doc, "AUX-R-006"))[0]!.guidance).toBeNull();
  });

  it("STORY-051 AC13 · pages are evaluated concurrently and each result stays with its page", async () => {
    const [a, b] = await evaluateDocuments([makeDoc(), broken()], CATALOG, AUX_RULES, { projectId: PROJECT_ID });
    expect(a).toEqual([]);
    expect(b!.length).toBeGreaterThan(0);
  });

  it("STORY-051 #13 · every rule's customer text names an AI consequence and not a rule code", () => {
    for (const r of CATALOG_ROWS) {
      for (const field of [r.title, r.description, r.rationale]) {
        expect(field, r.code).not.toMatch(/AUX-R-\d|rule code|R-\d{3}/iu);
        expect(field.trim().length, r.code).toBeGreaterThan(10);
      }
      expect(r.rationale, r.code).toMatch(/\b(AI|engines?|crawlers?|citations?|cite[sd]?|chatbots?)\b/iu);
      expect(r.rationale, r.code).toMatch(/\b(cannot|can not|never|skip|skipped|ignore|ignored|miss|missing|lose|loses|guess|guesses|trust|credit|not|without|favour|favours|exclud\w*|read|quote|cited?|passed)\b/iu);
    }
  });
});
