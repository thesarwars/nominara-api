import { describe, expect, it, vi } from "vitest";
import { discover, DISCOVERY_BUDGET_MS, DISCOVERY_LATENCY_OBJECTIVE, meetsLatencyObjective, type DiscoverDeps } from "./discover.js";
import { LOW_CONFIDENCE_THRESHOLD } from "../../../contracts/projects/index.js";

// STORY-043 AC10 (hero / nav / logo alt), AC11 (competitors with a basis), AC15 (latency objective).

const BASE = { rootUrl: "https://hubspot.com", rootDomain: "hubspot.com", fieldsSupplied: [] as string[] };

function serving(html: string): DiscoverDeps {
  let t = 1000;
  return {
    fetch: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(html), finalUrl: "https://hubspot.com/" })),
    now: () => (t += 500),
  };
}

const COMPARISONS = `<html><head><title>HubSpot | CRM</title></head><body>
  <a href="/compare/hubspot-vs-salesforce">HubSpot vs Salesforce</a>
  <a href="/alternatives/pipedrive">Pipedrive alternatives</a></body></html>`;

describe("STORY-043 · discovery signals from the parsed document", () => {
  it("AC11 — proposes competitors from the site's own comparison links, each with a basis", async () => {
    const result = await discover(BASE, serving(COMPARISONS));
    expect(result.competitors_proposed.map((c) => c.name)).toEqual(["Salesforce", "Pipedrive"]);
    for (const c of result.competitors_proposed) expect(c.basis).toBe("own comparison page");
  });

  it("AC11 — proposes none when the caller supplied competitors (supplied wins, not re-proposed)", async () => {
    const result = await discover({ ...BASE, fieldsSupplied: ["competitors"] }, serving(COMPARISONS));
    expect(result.competitors_proposed).toEqual([]);
  });

  it("AC11 — proposes none on a failed fetch, instead of inventing a list", async () => {
    const deps: DiscoverDeps = { fetch: vi.fn(async () => { throw new Error("down"); }), now: () => Date.now() };
    expect((await discover(BASE, deps)).competitors_proposed).toEqual([]);
  });

  it("AC11 — matches the brand by the discovered name, so 'Acme vs X' works when the domain stem differs", async () => {
    const page = `<html><head><script type="application/ld+json">{"@type":"Organization","name":"Acme Corp"}</script></head>
      <body><a href="/vs/rival">Acme Corp vs Rival</a></body></html>`;
    const result = await discover({ ...BASE, rootDomain: "acme-hq.io" }, serving(page));
    expect(result.competitors_proposed.map((c) => c.name)).toEqual(["Rival"]);
  });

  it("AC10 — the logo alt text corroborates a title-derived name and lifts it above the threshold", async () => {
    const page = `<html><head><title>Acme | Tools</title></head><body><img class="logo" src="/l.svg" alt="Acme logo"></body></html>`;
    const result = await discover(BASE, serving(page));
    expect(result.fields.brand_name?.value).toBe("Acme");
    expect(result.fields.brand_name?.confidence).toBeGreaterThanOrEqual(LOW_CONFIDENCE_THRESHOLD);
    expect(result.fields.brand_name?.source).toContain("logo alt");
  });

  it("AC10 — a logo alt that DISAGREES with the title does not override it", async () => {
    const page = `<html><head><title>Acme | Tools</title></head><body><img class="logo" src="/l.svg" alt="Globex logo"></body></html>`;
    const result = await discover(BASE, serving(page));
    expect(result.fields.brand_name?.value).toBe("Acme");
    expect(result.low_confidence_fields).toContain("brand_name");
  });

  it("AC10 — a logo alt alone is a low-confidence name, flagged not applied", async () => {
    const page = `<html><body><img class="logo" src="/l.svg" alt="Acme logo"></body></html>`;
    const result = await discover(BASE, serving(page));
    expect(result.fields.brand_name?.value).toBe("Acme");
    expect(result.low_confidence_fields).toContain("brand_name");
  });

  it("AC10 — hero copy fills the description only when the page has no declared one, at low confidence", async () => {
    const hero = `<html><body><h1>Grow better</h1><p>The customer platform that brings your teams together.</p></body></html>`;
    const result = await discover(BASE, serving(hero));
    expect(result.fields.description?.value).toBe("Grow better. The customer platform that brings your teams together.");
    expect(result.fields.description?.source).toBe("hero copy");
    expect(result.low_confidence_fields).toContain("description");

    const declared = `<html><head><meta name="description" content="Declared."></head><body><h1>Grow better</h1></body></html>`;
    expect((await discover(BASE, serving(declared))).fields.description?.value).toBe("Declared.");
  });

  it("AC10 — nav products fill `products` only when no Product schema exists, flagged low-confidence", async () => {
    const nav = `<nav><ul><li><a href="/p">Products</a><ul><li><a href="/s">Sales Hub</a></li></ul></li></ul></nav>`;
    const result = await discover(BASE, serving(`<html><body>${nav}</body></html>`));
    expect(result.fields.products?.value).toEqual(["Sales Hub"]);
    expect(result.fields.products?.source).toBe("nav structure");
    expect(result.low_confidence_fields).toContain("products");

    const schema = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Real"}</script></head><body>${nav}</body></html>`;
    expect((await discover(BASE, serving(schema))).fields.products?.value).toEqual(["Real"]);
  });

  it("AC1 — a supplied name or description is still not derived from the parsed signals", async () => {
    const page = `<html><body><img class="logo" alt="Acme logo"><h1>Grow</h1><p>A long enough lede paragraph for the test.</p></body></html>`;
    const result = await discover({ ...BASE, fieldsSupplied: ["name", "description"] }, serving(page));
    expect(result.fields.brand_name).toBeUndefined();
    expect(result.fields.description).toBeUndefined();
  });
});

describe("STORY-043 · AC15 latency objective", () => {
  it("the objective is the reference's: median 20 s, p95 45 s", () => {
    expect(DISCOVERY_LATENCY_OBJECTIVE).toEqual({ p50Ms: 20_000, p95Ms: 45_000 });
  });

  it("meetsLatencyObjective judges the median and the upper percentile separately", () => {
    expect(meetsLatencyObjective([1000, 2000, 3000, 4000, 5000])).toBe(true);
    // Median fine, p95 blown.
    expect(meetsLatencyObjective([...Array<number>(19).fill(1000), 60_000])).toBe(false);
    // p95 fine, median blown.
    expect(meetsLatencyObjective(Array<number>(10).fill(25_000))).toBe(false);
    // Exactly on the limits is inside the objective (<=).
    expect(meetsLatencyObjective([20_000])).toBe(true);
  });

  it("no measurements is not 'met' — null is not zero", () => {
    expect(meetsLatencyObjective([])).toBeNull();
  });

  it("scenario 18 — a typical site (a slow 4 s root fetch) is measured inside the objective", async () => {
    let t = 0;
    const deps: DiscoverDeps = {
      fetch: vi.fn(async () => { t += 4000; return { status: 200, headers: {}, body: Buffer.from(COMPARISONS), finalUrl: "https://hubspot.com/" }; }),
      now: () => t,
    };
    const result = await discover(BASE, deps);
    expect(result.duration_ms).toBe(4000);
    expect(meetsLatencyObjective([result.duration_ms!])).toBe(true);
  });

  it("scenario 13 — a fetch that outlives the budget ends the pass as a partial project, not a hang", async () => {
    vi.useFakeTimers();
    try {
      const deps: DiscoverDeps = { fetch: vi.fn(() => new Promise<never>(() => undefined)), now: () => Date.now() };
      const pending = discover(BASE, deps);
      await vi.advanceTimersByTimeAsync(DISCOVERY_BUDGET_MS + 1);
      const result = await pending;
      expect(result.discovery_status).toBe("partial");
      expect(result.fields.aliases).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
