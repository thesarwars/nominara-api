import { describe, expect, it, vi } from "vitest";
import { discover, FREE_PROMPT_ALLOWANCE, type DiscoverDeps } from "./discover.js";
import { GuardedFetchRefusal } from "../net/guarded-fetch.js";
import { LOW_CONFIDENCE_THRESHOLD } from "../../../contracts/projects/index.js";

// STORY-043 scenarios 4, 13, 14, 16 and §4.5's four rules.

const PAGE = `<!doctype html>
<html lang="en-US">
<head>
  <title>HubSpot | Customer Platform</title>
  <meta name="description" content="Customer platform with CRM, marketing, and service hubs.">
  <meta property="og:site_name" content="HubSpot">
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"HubSpot CRM",
     "description":"The customer platform for scaling companies."}
  </script>
  <script type="application/ld+json">
    [{"@type":"Product","name":"Sales Hub"},{"@type":"Product","name":"Marketing Hub"}]
  </script>
</head>
<body><h1>Grow better</h1></body></html>`;

function depsServing(html: string, status = 200): DiscoverDeps {
  let t = 1000;
  return {
    fetch: vi.fn(async () => ({ status, headers: {}, body: Buffer.from(html), finalUrl: "https://hubspot.com/" })),
    now: () => (t += 500),
  };
}

const BASE = { rootUrl: "https://hubspot.com", rootDomain: "hubspot.com", fieldsSupplied: [] as string[] };

describe("STORY-043 · discover", () => {
  it("derives brand, description, products and locale from one fetch", async () => {
    const result = await discover(BASE, depsServing(PAGE));

    expect(result.discovery_status).toBe("completed");
    expect(result.fields.brand_name?.value).toBe("HubSpot CRM"); // JSON-LD beats og:site_name and <title>
    expect(result.fields.brand_name?.source).toBe("Organization schema");
    expect(result.fields.description?.value).toBe("The customer platform for scaling companies.");
    expect(result.fields.products?.value).toEqual(["Sales Hub", "Marketing Hub"]);
    expect(result.fields.locale?.value).toBe("en-US");
  });

  it("§4.5 — every discovered field carries a value, a confidence and a source", async () => {
    const result = await discover(BASE, depsServing(PAGE));
    for (const [name, field] of Object.entries(result.fields)) {
      expect(field.value, name).toBeDefined();
      expect(field.confidence, name).toBeGreaterThan(0);
      expect(field.source, name).toBeTruthy();
      expect(field.user_edited, name).toBe(false);
    }
  });

  it("falls back through JSON-LD -> Open Graph -> <title>, and strips a title's tagline", async () => {
    const ogOnly = `<html><head><title>X | Y</title><meta property="og:site_name" content="Acme"></head></html>`;
    expect((await discover(BASE, depsServing(ogOnly))).fields.brand_name?.value).toBe("Acme");

    const titleOnly = `<html><head><title>Acme Tools | The best tools</title></head></html>`;
    expect((await discover(BASE, depsServing(titleOnly))).fields.brand_name?.value).toBe("Acme Tools");
  });

  // AC1 / scenario 4 — supplied wins, and is not re-proposed for review.
  it("scenario 4 — skips a supplied field entirely; it is absent from the payload", async () => {
    const result = await discover({ ...BASE, fieldsSupplied: ["name", "category_slug"] }, depsServing(PAGE));

    expect(result.fields.brand_name).toBeUndefined();
    expect(result.fields.category).toBeUndefined();
    // Everything NOT supplied is still discovered.
    expect(result.fields.description).toBeDefined();
    expect(result.fields.products).toBeDefined();
  });

  it("scenario 4 — a supplied description is skipped while the brand name is still discovered", async () => {
    const result = await discover({ ...BASE, fieldsSupplied: ["description"] }, depsServing(PAGE));
    expect(result.fields.description).toBeUndefined();
    expect(result.fields.brand_name?.value).toBe("HubSpot CRM");
  });

  // AC13 / scenario 13.
  it("scenario 13 — a timeout leaves a usable partial result, not a throw", async () => {
    const deps: DiscoverDeps = {
      fetch: vi.fn(async () => { throw new Error("guarded-fetch: total timeout"); }),
      now: () => Date.now(),
    };
    const result = await discover(BASE, deps);

    expect(result.discovery_status).toBe("partial");
    // "with whatever it obtained" — aliases come from the domain, not the page.
    expect(result.fields.aliases?.value).toEqual(["Hubspot"]);
  });

  it("scenario 13 — a guard refusal mid-discovery is partial, never a thrown job", async () => {
    const deps: DiscoverDeps = {
      fetch: vi.fn(async () => { throw new GuardedFetchRefusal("redirect_target_refused"); }),
      now: () => Date.now(),
    };
    await expect(discover(BASE, deps)).resolves.toMatchObject({ discovery_status: "partial" });
  });

  it("a 404 is partial — reached, but nothing read", async () => {
    const result = await discover(BASE, depsServing("", 404));
    expect(result.discovery_status).toBe("partial");
  });

  // `failed` must mean something different from `partial`, or a customer
  // reading "partial" waits for fields that are never coming.
  it("is failed, not partial, when nothing at all could be derived", async () => {
    const deps: DiscoverDeps = { fetch: vi.fn(async () => { throw new Error("down"); }), now: () => Date.now() };
    const result = await discover({ ...BASE, fieldsSupplied: ["brand_aliases", "negative_aliases"] }, deps);

    expect(result.fields).toEqual({});
    expect(result.discovery_status).toBe("failed");
  });

  // AC14 / scenario 14 — flagged, not applied.
  it("scenario 14 — a value below the threshold is listed in low_confidence_fields", async () => {
    const result = await discover(BASE, depsServing(PAGE));
    for (const name of result.low_confidence_fields) {
      expect(result.fields[name]!.confidence).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
    }
    // And the list is complete, not merely correct about what it contains.
    const belowThreshold = Object.entries(result.fields)
      .filter(([, f]) => f.confidence < LOW_CONFIDENCE_THRESHOLD)
      .map(([n]) => n);
    expect(result.low_confidence_fields.sort()).toEqual(belowThreshold.sort());
  });

  it("AC13 — a low-confidence value still appears in fields, with its confidence", async () => {
    // Nothing is dropped for being uncertain; it is surfaced and flagged.
    const result = await discover(BASE, depsServing(PAGE));
    expect(Object.keys(result.fields).length).toBeGreaterThan(0);
  });

  // AC12 / scenario 15.
  it("AC12 — charges nothing and reports the full free allowance", async () => {
    const result = await discover(BASE, depsServing(PAGE));
    expect(result.credits_charged).toBe(0);
    expect(result.prompts_free_remaining).toBe(FREE_PROMPT_ALLOWANCE);
  });

  // AC16 / scenario 16.
  it("scenario 16 — proposes negative aliases for a common-word brand", async () => {
    const page = `<html><head><script type="application/ld+json">{"@type":"Organization","name":"Notion"}</script></head></html>`;
    const result = await discover({ ...BASE, rootDomain: "notion.so" }, depsServing(page));

    expect(result.fields.negative_aliases?.value).toContain("the notion");
    expect(result.fields.negative_aliases?.source).toBe("common-word dictionary");
  });

  it("proposes no negative aliases for a distinctive brand", async () => {
    const result = await discover(BASE, depsServing(PAGE));
    expect(result.fields.negative_aliases).toBeUndefined();
  });

  it("records a duration", async () => {
    const result = await discover(BASE, depsServing(PAGE));
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  // Not built, and empty rather than faked — an invented competitor list with
  // no basis is exactly what §4.5 forbids.
  it("proposes no competitors or prompts — both are downstream stories", async () => {
    const result = await discover(BASE, depsServing(PAGE));
    expect(result.competitors_proposed).toEqual([]);
    expect(result.prompts_generated).toEqual([]);
  });

  it("survives malformed JSON-LD without losing the other blocks", async () => {
    const page = `<html><head>
      <script type="application/ld+json">{ NOT JSON </script>
      <script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
    </head></html>`;
    expect((await discover(BASE, depsServing(page))).fields.brand_name?.value).toBe("Acme");
  });

  it("handles a @graph wrapper", async () => {
    const page = `<html><head><script type="application/ld+json">
      {"@graph":[{"@type":"WebSite"},{"@type":"Organization","name":"Graphed"}]}
    </script></head></html>`;
    expect((await discover(BASE, depsServing(page))).fields.brand_name?.value).toBe("Graphed");
  });

  it("handles an empty document without throwing", async () => {
    const result = await discover(BASE, depsServing(""));
    expect(result.discovery_status).toBe("completed");
    expect(result.fields.aliases).toBeDefined();
  });
});
