import { describe, expect, it, vi } from "vitest";
import { LOW_CONFIDENCE_THRESHOLD } from "../../../contracts/projects/index.js";
import { CATEGORY_CLASSIFICATION_SOURCE } from "../categories/classify.js";
import { discover, type DiscoverDeps } from "./discover.js";

// STORY-189 AC3 and AC4 — discovery classifies the site from the text it already extracts, and records the category like every other
// discovered field: a value, a confidence, a source and an edited flag. Below the threshold it is flagged, not applied; a caller-supplied
// category is never derived or re-proposed.

const PAGE = `<!doctype html><html lang="en-US"><head>
  <title>Acme CRM | Sell more</title>
  <meta name="description" content="Pipeline and contact management for sales teams.">
  <script type="application/ld+json">[{"@type":"Product","name":"Acme Pipeline"}]</script>
</head><body><nav><ul><li><a href="/p">Products</a><ul><li><a href="/s">Sales Cloud</a></li></ul></li></ul></nav><h1>Close deals faster</h1><p>Everything your sellers need in one place to win.</p></body></html>`;

const BASE = { rootUrl: "https://acme.example", rootDomain: "acme.example", fieldsSupplied: [] as string[] };

function deps(classify: DiscoverDeps["classify"], html = PAGE): DiscoverDeps {
  let t = 0;
  return {
    fetch: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(html), finalUrl: "https://acme.example/" })),
    now: () => (t += 100),
    ...(classify === undefined ? {} : { classify }),
  };
}

describe("STORY-189 · discovery proposes a category", () => {
  it("AC3 — records the category with a value, a confidence, a source and an unedited flag", async () => {
    const classify = vi.fn(async () => ({ slug: "crm", confidence: 0.91, source: CATEGORY_CLASSIFICATION_SOURCE, tokens: 12 }));
    const result = await discover(BASE, deps(classify));
    expect(result.fields.category).toEqual({ value: "crm", confidence: 0.91, source: CATEGORY_CLASSIFICATION_SOURCE, user_edited: false });
    expect(result.low_confidence_fields).not.toContain("category");
  });

  it("AC3 — classifies from the extracted title, description, hero copy, nav and Product schema together", async () => {
    const classify = vi.fn(async (_text: string) => ({ slug: "crm", confidence: 0.9, source: CATEGORY_CLASSIFICATION_SOURCE, tokens: 1 }));
    await discover(BASE, deps(classify));
    const text = classify.mock.calls[0]![0];
    for (const part of ["Acme CRM | Sell more", "Pipeline and contact management for sales teams.", "Acme Pipeline", "Sales Cloud"]) {
      expect(text, part).toContain(part);
    }
  });

  it("AC4 — a category below the confidence threshold is listed in low_confidence_fields", async () => {
    const classify = vi.fn(async () => ({ slug: "crm", confidence: LOW_CONFIDENCE_THRESHOLD - 0.01, source: CATEGORY_CLASSIFICATION_SOURCE, tokens: 1 }));
    const result = await discover(BASE, deps(classify));
    expect(result.fields.category?.confidence).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
    expect(result.low_confidence_fields).toContain("category");
  });

  it("AC4 — a confidence exactly at the threshold is not low (the line is 'below 0.60')", async () => {
    const classify = vi.fn(async () => ({ slug: "crm", confidence: LOW_CONFIDENCE_THRESHOLD, source: CATEGORY_CLASSIFICATION_SOURCE, tokens: 1 }));
    expect((await discover(BASE, deps(classify))).low_confidence_fields).not.toContain("category");
  });

  it("AC4 — a caller-supplied category is never derived or re-proposed: the classifier is not even asked", async () => {
    const classify = vi.fn(async () => ({ slug: "banks", confidence: 0.99, source: CATEGORY_CLASSIFICATION_SOURCE, tokens: 1 }));
    const result = await discover({ ...BASE, fieldsSupplied: ["category_slug"] }, deps(classify));
    expect(classify).not.toHaveBeenCalled();
    expect(result.fields.category).toBeUndefined();
  });

  it("a category a person already decided (carried in as 'category') is skipped the same way", async () => {
    const classify = vi.fn(async () => ({ slug: "banks", confidence: 0.99, source: CATEGORY_CLASSIFICATION_SOURCE, tokens: 1 }));
    const result = await discover({ ...BASE, fieldsSupplied: ["category"] }, deps(classify));
    expect(classify).not.toHaveBeenCalled();
    expect(result.fields.category).toBeUndefined();
  });

  it("a page with nothing to classify is not sent to the classifier", async () => {
    const classify = vi.fn(async () => ({ slug: "crm", confidence: 0.99, source: CATEGORY_CLASSIFICATION_SOURCE, tokens: 1 }));
    const result = await discover(BASE, deps(classify, "<html><head></head><body></body></html>"));
    expect(classify).not.toHaveBeenCalled();
    expect(result.fields.category).toBeUndefined();
  });

  it("no match (null) proposes no category, and is not invented as a zero-confidence one", async () => {
    const result = await discover(BASE, deps(async () => null));
    expect(result.fields.category).toBeUndefined();
    expect(result.low_confidence_fields).not.toContain("category");
  });

  it("a provider failure leaves discovery COMPLETED with everything else intact and no category (fail closed, never a guess)", async () => {
    const classify = vi.fn(async () => {
      throw new Error("provider down");
    });
    const result = await discover(BASE, deps(classify));
    expect(classify).toHaveBeenCalledTimes(1);
    expect(result.discovery_status).toBe("completed");
    expect(result.fields.category).toBeUndefined();
    expect(result.fields.description?.value).toBe("Pipeline and contact management for sales teams.");
  });

  it("an unreachable site is not classified: there is no page text, and the classifier is not called", async () => {
    const classify = vi.fn(async () => null);
    const unreachable: DiscoverDeps = {
      fetch: vi.fn(async () => {
        throw new Error("refused");
      }),
      now: () => 0,
      classify,
    };
    const result = await discover(BASE, unreachable);
    expect(classify).not.toHaveBeenCalled();
    expect(result.fields.category).toBeUndefined();
  });

  it("without a classifier configured (existing callers), nothing changes", async () => {
    const result = await discover(BASE, deps(undefined));
    expect(result.fields.category).toBeUndefined();
  });
});
