import { describe, expect, it } from "vitest";
import { CLEAN_JSON_LD, CLEAN_TEXT, makeDoc, variant } from "../../../../test/support/aux-document.js";
import { CATALOG, findings } from "../../../../test/support/aux-rules.js";
import type { AuxDocument } from "../document-model.js";
import { createHash } from "node:crypto";
import { generatePagePatch, MAX_FEATURE_LIST_ITEMS } from "./page-patch.js";
import { PatchRejectedError } from "./types.js";

// STORY-053 AC1 / AC2 / AC7, end to end: the page-level findings of STORY-051 (AUX-R-014, AUX-R-023) drive the page generators.
// Scenario 1 (each kind valid, with a reversal and precondition hash) and 2 (every derived value traceable to the page).

const app = CLEAN_JSON_LD[1] as Record<string, unknown>;
const org = CLEAN_JSON_LD[0];
const noFeatures = (({ featureList: _f, ...rest }) => rest)(app);
const docWith = (jsonLd: unknown[], over: Partial<ReturnType<typeof variant>> = {}): AuxDocument =>
  makeDoc({ raw: variant({ structured: { jsonLd, microdata: [], rdfa: [], parseErrors: [] }, ...over }) });
const one = async (doc: AuxDocument, code: string) => {
  const [f] = await findings(doc, code);
  if (f === undefined) throw new Error(`${code} did not fire`);
  return f;
};
const sha = (s: string): string => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const thresholds = (code: string) => CATALOG.byCode.get(code)!.thresholds;

describe("STORY-053 scenario 1 / 2 · AUX-R-014 produces a jsonld patch from the page's own headings", () => {
  it("STORY-053 AC1 · a SoftwareApplication with no featureList gets a jsonld patch carrying its H2/H3 headings, a reversal and a page_hash precondition", async () => {
    const doc = docWith([org, noFeatures]);
    const finding = await one(doc, "AUX-R-014");
    const draft = generatePagePatch({ finding, document: doc, thresholds: thresholds("AUX-R-014") });
    expect(draft).not.toBeNull();
    expect(draft).toMatchObject({ kind: "jsonld", ruleCode: "AUX-R-014", targetUrl: doc.url, requiresHumanReview: false });
    expect(draft!.jsonldBlocks![0]).toMatchObject({ "@type": "SoftwareApplication", name: "Acme Widgets", featureList: ["Pipeline analytics", "Workflow automation"] });
    expect(draft!.reversal.operation).toBe("restore_jsonld");
    expect(draft!.preconditions).toEqual([{ kind: "page_hash", value: sha(doc.raw.html) }]);
    expect(draft!.derivation).toMatch(/verbatim from the page's own/);
  });
  it("STORY-053 AC2 · a heading that is not capability copy (the catalog's non_capability_headings) is never offered as a feature", async () => {
    const heading = (text: string) => ({ level: 2, text, children: [] });
    const skip = (thresholds("AUX-R-014")["non_capability_headings"] as string[])[0]!;
    const doc = docWith([org, noFeatures], {
      mainText: `${CLEAN_TEXT}\n${skip}`,
      headingTree: [{ level: 1, text: "Acme Widgets", children: [heading("Pipeline analytics"), heading(skip)] }],
    });
    const finding = await one(doc, "AUX-R-014");
    const draft = generatePagePatch({ finding, document: doc, thresholds: thresholds("AUX-R-014") });
    expect((draft!.jsonldBlocks![0] as { featureList: string[] }).featureList).toEqual(["Pipeline analytics"]);
  });
  it("STORY-053 AC1 · a page with no capability heading offers no patch (an honest empty, not an empty featureList)", async () => {
    const doc = docWith([org, noFeatures], { headingTree: [{ level: 1, text: "Acme Widgets", children: [] }] });
    const finding = await one(doc, "AUX-R-014");
    expect(generatePagePatch({ finding, document: doc, thresholds: thresholds("AUX-R-014") })).toBeNull();
  });
  it("STORY-053 AC7 · a thin featureList is merged into the existing block (union), never added as a second SoftwareApplication", async () => {
    const thin = { ...app, featureList: ["Unrelated claim"] };
    const doc = docWith([org, thin]);
    const finding = await one(doc, "AUX-R-014");
    const draft = generatePagePatch({ finding, document: doc, thresholds: thresholds("AUX-R-014") });
    expect((draft!.jsonldBlocks![0] as { featureList: string[] }).featureList).toEqual(["Unrelated claim", "Pipeline analytics", "Workflow automation"]);
    expect(draft!.jsonldBlocks).toHaveLength(1);
  });
  it("STORY-053 AC1 · a finding on an entity that is not a top-level block (nested under mainEntity) offers no patch rather than a duplicate block", async () => {
    const page = { "@context": "https://schema.org", "@type": "WebPage", mainEntity: { "@type": "SoftwareApplication", name: "Acme Widgets" } };
    const doc = docWith([org, page]);
    const finding = await one(doc, "AUX-R-014");
    expect(finding.evidence.locator).toBe("jsonld[1].mainEntity.featureList");
    expect(generatePagePatch({ finding, document: doc, thresholds: thresholds("AUX-R-014") })).toBeNull();
  });
  it("STORY-053 AC1 · the list is bounded (NOT FROM THE REFERENCE) so a page with many H2s does not produce an unreviewable block", async () => {
    const many = Array.from({ length: MAX_FEATURE_LIST_ITEMS + 5 }, (_, i) => ({ level: 2, text: `Capability number ${String(i)}`, children: [] }));
    const doc = docWith([org, noFeatures], { mainText: many.map((h) => h.text).join("\n"), headingTree: [{ level: 1, text: "Acme Widgets", children: many }] });
    const finding = await one(doc, "AUX-R-014");
    const draft = generatePagePatch({ finding, document: doc, thresholds: thresholds("AUX-R-014") });
    expect((draft!.jsonldBlocks![0] as { featureList: string[] }).featureList).toHaveLength(MAX_FEATURE_LIST_ITEMS);
  });
});

describe("STORY-053 scenario 1 · AUX-R-023 produces a markdown structure patch", () => {
  const longBlocks = { tokens: 900, longestUnstructuredTokens: 900, sentences: { count: 30, meanWords: 20, maxWords: 40 } };
  const textDoc = (): AuxDocument =>
    makeDoc({
      raw: variant({ mainText: "Acme Widgets\nAcme builds widgets for teams. We ship every week and we support every plan with care across all regions.\nPipeline analytics\nSee every deal." }),
      blocks: [{ heading: "Acme Widgets", level: 1, ...longBlocks, longestParagraphChars: 300, tables: 0, lists: { ordered: 0, unordered: 0, definition: 0 }, codeSpans: 0 }],
    });
  it("STORY-053 AC1 · the summary slot goes under the page's own first heading, with a reversal and a page_hash precondition", async () => {
    const doc = textDoc();
    const finding = await one(doc, "AUX-R-023");
    const draft = generatePagePatch({ finding, document: doc, thresholds: thresholds("AUX-R-023") });
    expect(draft).toMatchObject({ kind: "markdown", ruleCode: "AUX-R-023", targetUrl: doc.url, requiresHumanReview: false });
    expect(draft!.contentAfter).toMatch(/^# Acme Widgets\n\n## Summary\n\n\[Write a summary of "Acme Widgets"/);
    expect(draft!.reversal.operation).toBe("replace_file");
    expect(draft!.preconditions[0]).toMatchObject({ kind: "page_hash" });
  });
  it("STORY-053 AC2 · the only page text the template adds to is the page's own: no new sentence is generated", async () => {
    const doc = textDoc();
    const finding = await one(doc, "AUX-R-023");
    const draft = generatePagePatch({ finding, document: doc, thresholds: thresholds("AUX-R-023") })!;
    expect(draft.contentAfter).toContain("Acme builds widgets for teams.");
    expect(draft.derivation).toMatch(/placeholder, not a statement/);
  });
  it("STORY-053 AC1 · a page whose main text has no heading line is rejected as no_heading, never a patch with no anchor", async () => {
    const doc = makeDoc({
      raw: variant({ mainText: "Just a paragraph with no heading at all.", headingTree: [] }),
      blocks: [{ heading: null, level: 0, ...longBlocks, longestParagraphChars: 300, tables: 0, lists: { ordered: 0, unordered: 0, definition: 0 }, codeSpans: 0 }],
    });
    const finding = await one(doc, "AUX-R-023");
    expect(() => generatePagePatch({ finding, document: doc, thresholds: thresholds("AUX-R-023") })).toThrow(PatchRejectedError);
  });
});

describe("STORY-053 · a rule with no page generator offers no patch", () => {
  it("STORY-053 AC1 · AUX-R-010 (no spec'd content to derive) returns null", async () => {
    const doc = docWith([org]);
    const finding = await one(doc, "AUX-R-010").catch(() => null);
    const f = finding ?? { rule_code: "AUX-R-010", url: doc.url, evidence: { reason: "x", snippet: null, locator: "jsonld" } };
    expect(generatePagePatch({ finding: f as never, document: doc, thresholds: {} })).toBeNull();
  });
});
