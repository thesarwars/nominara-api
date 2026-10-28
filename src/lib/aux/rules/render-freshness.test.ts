import { describe, expect, it } from "vitest";
import { CLEAN_JSON_LD, CLEAN_TEXT, makeDoc, variant } from "../../../../test/support/aux-document.js";
import { findings } from "../../../../test/support/aux-rules.js";

// STORY-051 — render_mode (AUX-R-026, 027, 029) and freshness (AUX-R-030). The render-mode rules compare the plain and the
// rendered variants as ratios.

const mains = (raw: number, rendered: number) => makeDoc({ raw: variant({ mainTokenCount: raw }), rendered: variant({ mainTokenCount: rendered }) });

describe("STORY-051 AUX-R-026 · JS-only main content", () => {
  it("STORY-051 AUX-R-026 · a gap of exactly 0.30 does not fire; just above fires high", async () => {
    expect(await findings(mains(70, 100), "AUX-R-026")).toEqual([]);
    const [f] = await findings(mains(699, 1000), "AUX-R-026");
    expect(f).toMatchObject({ severity: "high", threshold_value: 0.3, auto_fixable: false });
    expect(f!.measured_value).toBeCloseTo(0.301, 6);
  });
  it("STORY-051 AUX-R-026 · 0.60 is still high; just above is critical", async () => {
    expect((await findings(mains(40, 100), "AUX-R-026"))[0]!.severity).toBe("high");
    expect((await findings(mains(399, 1000), "AUX-R-026"))[0]).toMatchObject({ severity: "critical", threshold_value: 0.6 });
  });
  it("STORY-051 AUX-R-026 · a plain copy richer than the rendered one is not a gap", async () => {
    expect(await findings(mains(200, 100), "AUX-R-026")).toEqual([]);
  });
  it("STORY-051 AUX-R-026 · no rendered capture, or an empty rendered main text, has no ratio: it is not a clean page and not a finding", async () => {
    expect(await findings(makeDoc({ rendered: null }), "AUX-R-026")).toEqual([]);
    expect(await findings(mains(0, 0), "AUX-R-026")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-027 · structured data injected client-side only", () => {
  const ld = (jsonLd: unknown[]) => variant({ structured: { jsonLd, microdata: [], rdfa: [], parseErrors: [] } });
  it("STORY-051 #8 · JSON-LD only in the rendered variant fires critical", async () => {
    const [f] = await findings(makeDoc({ raw: ld([]), rendered: ld(CLEAN_JSON_LD) }), "AUX-R-027");
    expect(f).toMatchObject({ severity: "critical", measured_value: 2, threshold_value: 1, auto_fixable: false });
    expect(f!.evidence.locator).toBe("rendered.jsonld[0]");
  });
  it("STORY-051 AUX-R-027 · identical in both, or present only in the plain copy, does not fire", async () => {
    expect(await findings(makeDoc(), "AUX-R-027")).toEqual([]);
    expect(await findings(makeDoc({ raw: ld(CLEAN_JSON_LD), rendered: ld([]) }), "AUX-R-027")).toEqual([]);
  });
  it("STORY-051 AUX-R-027 · one block injected on top of one served in the HTML fires for that block (one is the threshold)", async () => {
    const [f] = await findings(makeDoc({ raw: ld([CLEAN_JSON_LD[0]]), rendered: ld(CLEAN_JSON_LD) }), "AUX-R-027");
    expect(f).toMatchObject({ measured_value: 1, threshold_value: 1 });
    expect(f!.evidence.locator).toBe("rendered.jsonld[1]");
  });
  it("STORY-051 AUX-R-027 · key order does not make a block different", async () => {
    const reordered = { name: "Acme", "@type": "Organization", "@context": "https://schema.org" };
    const original = { "@context": "https://schema.org", "@type": "Organization", name: "Acme" };
    expect(await findings(makeDoc({ raw: ld([original]), rendered: ld([reordered]) }), "AUX-R-027")).toEqual([]);
  });
  it("STORY-051 AUX-R-027 · no rendered capture cannot show an injection", async () => {
    expect(await findings(makeDoc({ rendered: null }), "AUX-R-027")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-027 · a block the HTML serves and scripts then change is not a block added by scripts", () => {
  const ldOf = (blocks: unknown[]) => variant({ structured: { jsonLd: blocks, microdata: [], rdfa: [], parseErrors: [] } });
  const prod = (price: string, extra: Record<string, unknown> = {}) => ({ "@context": "https://schema.org", "@type": "Product", name: "Acme", offers: { "@type": "Offer", price }, ...extra });
  it("STORY-051 AUX-R-027 · the same @id with a price filled in after hydration does not fire", async () => {
    const doc = makeDoc({ raw: ldOf([prod("0", { "@id": "https://example.com/#p" })]), rendered: ldOf([prod("47", { "@id": "https://example.com/#p" })]) });
    expect(await findings(doc, "AUX-R-027")).toEqual([]);
  });
  it("STORY-051 AUX-R-027 · with no @id, the same @type and name matches", async () => {
    expect(await findings(makeDoc({ raw: ldOf([prod("0")]), rendered: ldOf([prod("47")]) }), "AUX-R-027")).toEqual([]);
  });
  it("STORY-051 AUX-R-027 · a block with a different identity is still an injection", async () => {
    const doc = makeDoc({ raw: ldOf([prod("0")]), rendered: ldOf([prod("0"), { ...prod("47"), name: "Other" }]) });
    const [f] = await findings(doc, "AUX-R-027");
    expect(f).toMatchObject({ measured_value: 1, evidence: { locator: "rendered.jsonld[1]" } });
  });
  it("STORY-051 AUX-R-027 · a block with no identity at all that differs is still an injection", async () => {
    expect(await findings(makeDoc({ raw: ldOf([{ "@context": "https://schema.org" }]), rendered: ldOf([{ "@context": "https://schema.org", extra: 1 }]) }), "AUX-R-027")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-027 · an @graph wrapper whose nodes keep their identities and change a value does not fire", async () => {
    const g = (price: string) => ({ "@context": "https://schema.org", "@graph": [{ "@type": "Organization", "@id": "https://example.com/#o", name: "Acme" }, prod(price, { "@id": "https://example.com/#p" })] });
    expect(await findings(makeDoc({ raw: ldOf([g("0")]), rendered: ldOf([g("47")]) }), "AUX-R-027")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-029 · slow first byte for bots", () => {
  const t = (ttfbMs: number | null, loadMs: number | null, bytes: number) => makeDoc({ timing: { ttfbMs, loadMs, bytes } });
  it("STORY-051 AUX-R-029 · 1,500 ms does not fire; 1,501 fires medium", async () => {
    expect(await findings(t(1500, 1000, 1000), "AUX-R-029")).toEqual([]);
    const [f] = await findings(t(1501, 1000, 1000), "AUX-R-029");
    expect(f).toMatchObject({ severity: "medium", measured_value: 1501, threshold_value: 1500 });
    expect(f!.evidence.reason).toBe("ttfb_ms");
  });
  it("STORY-051 AUX-R-029 · a total of 8,000 ms does not fire; 8,001 fires", async () => {
    expect(await findings(t(100, 8000, 1000), "AUX-R-029")).toEqual([]);
    expect((await findings(t(100, 8001, 1000), "AUX-R-029"))[0]!.evidence.reason).toBe("load_ms");
  });
  it("STORY-051 AUX-R-029 · 3 MB does not fire; one byte more fires", async () => {
    expect(await findings(t(100, 1000, 3 * 1024 * 1024), "AUX-R-029")).toEqual([]);
    expect((await findings(t(100, 1000, 3 * 1024 * 1024 + 1), "AUX-R-029"))[0]).toMatchObject({ measured_value: 3 * 1024 * 1024 + 1, threshold_value: 3 * 1024 * 1024 });
  });
  it("STORY-051 AUX-R-029 · an unmeasured timing is null, not zero and not slow; a measured 0 is fine", async () => {
    expect(await findings(t(null, null, 1000), "AUX-R-029")).toEqual([]);
    expect(await findings(t(0, 0, 0), "AUX-R-029")).toEqual([]);
  });
  it("STORY-051 AUX-R-029 · several breaches are one finding that names each", async () => {
    const fs = await findings(t(2000, 9000, 4_000_000), "AUX-R-029");
    expect(fs).toHaveLength(1);
    expect(fs[0]!.evidence.reason).toBe("ttfb_ms+load_ms+bytes");
  });
});

describe("STORY-051 AUX-R-030 · dateModified absent", () => {
  const { dateModified: _gone, ...noMeta } = makeDoc().meta;
  it("STORY-051 AUX-R-030 · a schema dateModified satisfies it", async () => {
    expect(await findings(makeDoc(), "AUX-R-030")).toEqual([]);
  });
  const ldWithout = [{ "@context": "https://schema.org", "@type": "Organization", name: "Acme" }];
  const ldWith = [{ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage", name: "Acme", dateModified: "2026-10-01" }] }];
  const noLd = { jsonLd: ldWithout, microdata: [], rdfa: [], parseErrors: [] };
  const noText = "Acme Widgets\nNo dates here.";
  it("STORY-051 AUX-R-030 · a meta (og/article) modified time alone is not a schema dateModified: it fires", async () => {
    const doc = makeDoc({ raw: variant({ mainText: noText, structured: { jsonLd: ldWithout, microdata: [], rdfa: [], parseErrors: [] } }) });
    expect(doc.meta.dateModified).toBeDefined();
    expect(await findings(doc, "AUX-R-030")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-030 · a schema dateModified (top level or in @graph) satisfies it even when meta has none", async () => {
    for (const jsonLd of [ldWith, [{ ...ldWithout[0], dateModified: "2026-10-01" }]]) {
      const doc = makeDoc({ meta: noMeta, raw: variant({ mainText: noText, structured: { jsonLd, microdata: [], rdfa: [], parseErrors: [] } }) });
      expect(await findings(doc, "AUX-R-030")).toEqual([]);
    }
  });
  it("STORY-051 AUX-R-030 · a blank schema dateModified is no date", async () => {
    const doc = makeDoc({ meta: noMeta, raw: variant({ mainText: noText, structured: { jsonLd: [{ ...ldWithout[0], dateModified: "  " }], microdata: [], rdfa: [], parseErrors: [] } }) });
    expect(await findings(doc, "AUX-R-030")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-030 · a Microdata or RDFa dateModified property satisfies it, nested or not; a blank one does not", async () => {
    const item = (v: string, nested = false) => ({ type: "https://schema.org/Article", properties: nested ? { isPartOf: [{ type: "https://schema.org/WebPage", properties: { dateModified: [v] } }] } : { dateModified: [v] } });
    for (const [key, nested] of [["microdata", false], ["rdfa", false], ["microdata", true]] as const) {
      const doc = makeDoc({ meta: noMeta, raw: variant({ mainText: noText, structured: { jsonLd: ldWithout, microdata: [], rdfa: [], parseErrors: [], [key]: [item("2026-10-01", nested)] } }) });
      expect(await findings(doc, "AUX-R-030"), `${key} nested=${String(nested)}`).toEqual([]);
    }
    const blank = makeDoc({ meta: noMeta, raw: variant({ mainText: noText, structured: { jsonLd: ldWithout, microdata: [item("  ")], rdfa: [], parseErrors: [] } }) });
    expect(await findings(blank, "AUX-R-030")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-030 · no dateModified and no visible date fires medium", async () => {
    const [f] = await findings(makeDoc({ meta: noMeta, raw: variant({ mainText: "Acme Widgets\nNo dates here.", structured: { jsonLd: ldWithout, microdata: [], rdfa: [], parseErrors: [] } }) }), "AUX-R-030");
    expect(f).toMatchObject({ severity: "medium", measured_value: 0, threshold_value: 1, auto_fixable: true });
  });
  it("STORY-051 AUX-R-030 · a visible last-updated date satisfies it, in several forms", async () => {
    for (const s of ["Last updated: 2026-10-01", "Updated on March 3, 2026", "Last modified 3 March 2026", "Revised 03/04/2026"]) {
      expect(await findings(makeDoc({ meta: noMeta, raw: variant({ mainText: `Acme\n${s}`, structured: noLd }) }), "AUX-R-030"), s).toEqual([]);
    }
  });
  it("STORY-051 AUX-R-030 · the word 'updated' with no date after it is not a date", async () => {
    expect(await findings(makeDoc({ meta: noMeta, raw: variant({ mainText: "We have updated our widgets.", structured: noLd }) }), "AUX-R-030")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-030 · a plain CLEAN_TEXT date is read from the same text the page shows", () => {
    expect(CLEAN_TEXT).toContain("Last updated");
  });
});
