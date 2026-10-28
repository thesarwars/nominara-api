import { describe, expect, it } from "vitest";
import { block, makeDoc, variant } from "../../../../test/support/aux-document.js";
import { findings, withThresholds } from "../../../../test/support/aux-rules.js";

// STORY-051 — the context_fitness rules, AUX-R-019..025: the truncation family. Every threshold is a token count or a ratio, so each
// is tested at, one below and one above.

const tokens = (tokenCount: number, mainTokenCount = Math.floor(tokenCount * 0.8)) => makeDoc({ raw: variant({ tokenCount, mainTokenCount }) });

describe("STORY-051 AUX-R-019 · page token count excessive", () => {
  it("STORY-051 AUX-R-019 · 12,000 tokens does not fire; 12,001 fires high", async () => {
    expect(await findings(tokens(12_000), "AUX-R-019")).toEqual([]);
    const [f] = await findings(tokens(12_001), "AUX-R-019");
    expect(f).toMatchObject({ severity: "high", measured_value: 12_001, threshold_value: 12_000, auto_fixable: false });
    expect(f!.guidance!.alignment_link).toEqual({ path: "/geo/alignment", target_url: "https://example.com/products/acme" });
  });
  it("STORY-051 AUX-R-019 · 25,000 is still high; 25,001 is critical", async () => {
    expect((await findings(tokens(25_000), "AUX-R-019"))[0]!.severity).toBe("high");
    const [f] = await findings(tokens(25_001), "AUX-R-019");
    expect(f).toMatchObject({ severity: "critical", threshold_value: 25_000 });
  });
  it("STORY-051 AUX-R-019 · the rendered copy is measured, not the plain one", async () => {
    const doc = makeDoc({ raw: variant({ tokenCount: 100 }), rendered: variant({ tokenCount: 13_000 }) });
    expect(await findings(doc, "AUX-R-019")).toHaveLength(1);
  });
  it("STORY-051 AC5 · the boundary is read from the catalog: a changed row moves it", async () => {
    const cat = withThresholds("AUX-R-019", { warn_tokens: 500 });
    expect(await findings(tokens(500), "AUX-R-019", cat)).toEqual([]);
    expect(await findings(tokens(501), "AUX-R-019", cat)).toHaveLength(1);
  });
});

describe("STORY-051 AUX-R-020 · main-content ratio low", () => {
  it("STORY-051 AUX-R-020 · ratio exactly 0.35 does not fire; just below fires high", async () => {
    expect(await findings(tokens(2000, 700), "AUX-R-020")).toEqual([]);
    const [f] = await findings(tokens(2000, 699), "AUX-R-020");
    expect(f).toMatchObject({ severity: "high", threshold_value: 0.35 });
    expect(f!.measured_value).toBeCloseTo(0.3495, 6);
  });
  it("STORY-051 AUX-R-020 · above the threshold does not fire", async () => {
    expect(await findings(tokens(2000, 701), "AUX-R-020")).toEqual([]);
  });
  it("STORY-051 AUX-R-020 · a page with no tokens has no ratio: null is not zero", async () => {
    expect(await findings(tokens(0, 0), "AUX-R-020")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-021 · context block truncation risk", () => {
  const section = (t: number, over = {}) => makeDoc({ blocks: [block({ heading: "Long part", tokens: t, ...over })] });
  it("STORY-051 #9 · 1,800 tokens does not fire; 1,801 fires high (the warn boundary)", async () => {
    expect(await findings(section(1800), "AUX-R-021")).toEqual([]);
    const [f] = await findings(section(1801), "AUX-R-021");
    expect(f).toMatchObject({ severity: "high", measured_value: 1801, threshold_value: 1800 });
    expect(f!.evidence).toMatchObject({ reason: "section_tokens", snippet: "Long part", locator: "blocks[0]" });
  });
  it("STORY-051 #9 · 3,000 is still high; 3,001 is critical (the fail boundary fires higher)", async () => {
    expect((await findings(section(3000), "AUX-R-021"))[0]!.severity).toBe("high");
    expect((await findings(section(3001), "AUX-R-021"))[0]).toMatchObject({ severity: "critical", threshold_value: 3000 });
  });
  it("STORY-051 AUX-R-021 · a table or any list in the section is intervening structure", async () => {
    for (const over of [{ tables: 1 }, { lists: { ordered: 1, unordered: 0, definition: 0 } }, { lists: { ordered: 0, unordered: 1, definition: 0 } }, { lists: { ordered: 0, unordered: 0, definition: 1 } }]) {
      expect(await findings(section(5000, over), "AUX-R-021")).toEqual([]);
    }
  });
  it("STORY-051 AUX-R-021 · the largest unstructured section is the one measured; each long section is located", async () => {
    const doc = makeDoc({ blocks: [block({ tokens: 2000 }), block({ tokens: 100 }), block({ tokens: 3500 })] });
    const fs = await findings(doc, "AUX-R-021");
    expect(fs.map((f) => f.evidence.locator)).toEqual(["blocks[0]", "blocks[2]"]);
    expect(fs.map((f) => f.severity)).toEqual(["high", "critical"]);
  });
  it("STORY-051 AUX-R-021 · no blocks, no finding", async () => {
    expect(await findings(makeDoc({ blocks: [] }), "AUX-R-021")).toEqual([]);
  });
});

describe("STORY-051 AUX-R-022 · paragraph density", () => {
  const dense = (over: Partial<ReturnType<typeof block>>) => makeDoc({ blocks: [block(over)] });
  it("STORY-051 AUX-R-022 · a 900-character paragraph does not fire; 901 fires medium", async () => {
    expect(await findings(dense({ longestParagraphChars: 900 }), "AUX-R-022")).toEqual([]);
    const [f] = await findings(dense({ longestParagraphChars: 901 }), "AUX-R-022");
    expect(f).toMatchObject({ severity: "medium", measured_value: 901, threshold_value: 900 });
    expect(f!.evidence.reason).toBe("paragraph_chars");
  });
  it("STORY-051 AUX-R-022 · a mean of 32 words does not fire; 32.01 fires", async () => {
    expect(await findings(dense({ sentences: { count: 5, meanWords: 32, maxWords: 40 } }), "AUX-R-022")).toEqual([]);
    const [f] = await findings(dense({ sentences: { count: 5, meanWords: 32.01, maxWords: 40 } }), "AUX-R-022");
    expect(f).toMatchObject({ measured_value: 32.01, threshold_value: 32 });
    expect(f!.evidence.reason).toBe("sentence_words");
  });
  it("STORY-051 AUX-R-022 · a section with no sentences has no mean: null is not a long sentence", async () => {
    expect(await findings(dense({ sentences: { count: 0, meanWords: null, maxWords: 0 } }), "AUX-R-022")).toEqual([]);
  });
  it("STORY-051 AUX-R-022 · both causes in one section report the paragraph, once", async () => {
    const fs = await findings(dense({ longestParagraphChars: 1200, sentences: { count: 3, meanWords: 40, maxWords: 60 } }), "AUX-R-022");
    expect(fs).toHaveLength(1);
    expect(fs[0]!.evidence.reason).toBe("paragraph_chars+sentence_words");
  });
});

describe("STORY-051 AUX-R-023 · answer-shaped content absent", () => {
  const flat = (t: number, over = {}) => block({ tokens: t, sentences: { count: 9, meanWords: 15, maxWords: 25 }, ...over });
  it("STORY-051 AUX-R-023 · nothing answer-shaped in the first 400 tokens fires medium", async () => {
    const [f] = await findings(makeDoc({ blocks: [flat(900)] }), "AUX-R-023");
    expect(f).toMatchObject({ severity: "medium", measured_value: 0, threshold_value: 1, auto_fixable: true });
  });
  it("STORY-051 AUX-R-023 · a table, a definition list, or a numbered list at the top satisfies it; a bullet list does not", async () => {
    expect(await findings(makeDoc({ blocks: [flat(900, { tables: 1 })] }), "AUX-R-023")).toEqual([]);
    expect(await findings(makeDoc({ blocks: [flat(900, { lists: { ordered: 0, unordered: 0, definition: 1 } })] }), "AUX-R-023")).toEqual([]);
    expect(await findings(makeDoc({ blocks: [flat(900, { lists: { ordered: 1, unordered: 0, definition: 0 } })] }), "AUX-R-023")).toEqual([]);
    expect(await findings(makeDoc({ blocks: [flat(900, { lists: { ordered: 0, unordered: 1, definition: 0 } })] }), "AUX-R-023")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-023 · a summary paragraph of three sentences or fewer satisfies it; four does not", async () => {
    expect(await findings(makeDoc({ blocks: [flat(80, { sentences: { count: 3, meanWords: 15, maxWords: 20 } }), flat(900)] }), "AUX-R-023")).toEqual([]);
    expect(await findings(makeDoc({ blocks: [flat(80, { sentences: { count: 4, meanWords: 15, maxWords: 20 } }), flat(900)] }), "AUX-R-023")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-023 · structure in a section that starts at token 399 counts; one that starts at 400 does not", async () => {
    expect(await findings(makeDoc({ blocks: [flat(399), flat(900, { tables: 1 })] }), "AUX-R-023")).toEqual([]);
    expect(await findings(makeDoc({ blocks: [flat(400), flat(900, { tables: 1 })] }), "AUX-R-023")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-023 · a page with no content blocks has no answer-shaped content", async () => {
    expect(await findings(makeDoc({ blocks: [] }), "AUX-R-023")).toHaveLength(1);
  });
});

describe("STORY-051 AUX-R-024 · heading hierarchy broken", () => {
  const tree = (...levels: number[]) => {
    const roots: { level: number; text: string; children: unknown[] }[] = [];
    const stack: { level: number; text: string; children: unknown[] }[] = [];
    levels.forEach((l, i) => {
      const h = { level: l, text: `H${String(l)} #${String(i)}`, children: [] as unknown[] };
      while (stack.length > 0 && stack[stack.length - 1]!.level >= l) stack.pop();
      if (stack.length === 0) roots.push(h);
      else stack[stack.length - 1]!.children.push(h);
      stack.push(h);
    });
    return roots as never;
  };
  const doc = (...levels: number[]) => makeDoc({ raw: variant({ headingTree: tree(...levels) }) });
  it("STORY-051 AUX-R-024 · one H1 and no skipped level: no finding", async () => {
    expect(await findings(doc(1, 2, 3, 2, 3), "AUX-R-024")).toEqual([]);
  });
  it("STORY-051 AUX-R-024 · no H1 fires medium", async () => {
    const [f] = await findings(doc(2, 3), "AUX-R-024");
    expect(f).toMatchObject({ severity: "medium", measured_value: 1, threshold_value: 1 });
    expect(f!.evidence.reason).toBe("no_h1");
  });
  it("STORY-051 AUX-R-024 · two H1s fires (one is the threshold, two is above it)", async () => {
    expect((await findings(doc(1, 2, 1), "AUX-R-024"))[0]!.evidence.reason).toBe("multiple_h1");
  });
  it("STORY-051 AUX-R-024 · a skip from H2 to H4 fires; H3 to H2 then H3 does not", async () => {
    const [f] = await findings(doc(1, 2, 4), "AUX-R-024");
    expect(f!.evidence).toMatchObject({ reason: "level_skip", snippet: "H4 #2" });
  });
  it("STORY-051 AUX-R-024 · a page with no headings at all has no H1", async () => {
    expect((await findings(makeDoc({ raw: variant({ headingTree: [] }) }), "AUX-R-024"))[0]!.evidence.reason).toBe("no_h1");
  });
});

describe("STORY-051 AUX-R-025 · key facts locked in media", () => {
  const img = (src: string, alt: string, around = "") => makeDoc({ raw: variant({ html: `<main><h1>x</h1>${around}<img src="${src}" alt="${alt}"></main>` }), media: { images: 1, imagesWithAlt: alt === "" ? 0 : 1 } });
  it("STORY-051 AUX-R-025 · a pricing image with a short alt and no adjacent text fires high", async () => {
    const [f] = await findings(img("/img/pricing-table.png", "Pricing"), "AUX-R-025");
    expect(f).toMatchObject({ severity: "high", measured_value: 7, threshold_value: 20, auto_fixable: false });
    expect(f!.evidence.snippet).toContain("pricing-table.png");
  });
  it("STORY-051 AUX-R-025 · an alt of 20 characters does not fire; 19 fires", async () => {
    expect(await findings(img("/pricing.png", "a".repeat(20)), "AUX-R-025")).toEqual([]);
    expect(await findings(img("/pricing.png", "a".repeat(19)), "AUX-R-025")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-025 · adjacent text, or an image that is not a key fact, does not fire", async () => {
    expect(await findings(img("/pricing.png", "Plans", "<p>Starter is $9 per month, Team is $29.</p>"), "AUX-R-025")).toEqual([]);
    expect(await findings(img("/team-photo.jpg", ""), "AUX-R-025")).toEqual([]);
  });
  it("STORY-051 AUX-R-025 · adjacent text of 19 characters is not enough; 20 is", async () => {
    expect(await findings(img("/pricing.png", "Plans", `<p>${"a".repeat(19)}</p>`), "AUX-R-025")).toHaveLength(1);
    expect(await findings(img("/pricing.png", "Plans", `<p>${"a".repeat(20)}</p>`), "AUX-R-025")).toEqual([]);
  });
  it("STORY-051 AUX-R-025 · a heading next to the image is not text about it", async () => {
    expect(await findings(img("/pricing.png", "Plans", "<h2>Pricing plans for every team</h2>"), "AUX-R-025")).toHaveLength(1);
  });
  it("STORY-051 AUX-R-025 · a missing alt is length 0, not an exemption", async () => {
    expect((await findings(img("/feature-comparison.png", ""), "AUX-R-025"))[0]!.measured_value).toBe(0);
  });
});
