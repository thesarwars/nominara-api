import { describe, expect, it, vi } from "vitest";
import { discover, DISCOVERY_BUDGET_MS, type DiscoverDeps } from "./discover.js";
import { MAX_PROPOSED_COMPETITORS, proposeCompetitors, selectComparisonPages } from "./competitors.js";
import { GuardedFetchRefusal } from "../net/guarded-fetch.js";
import { incrementCounter } from "../telemetry/metrics.js";

vi.mock("../telemetry/metrics.js", () => ({ observeValue: vi.fn(), incrementCounter: vi.fn() }));
const startSpan = vi.hoisted(() => vi.fn());
vi.mock("@opentelemetry/api", async (orig) => {
  const actual = await orig<typeof import("@opentelemetry/api")>();
  return {
    ...actual,
    trace: {
      getTracer: () => ({
        startActiveSpan: (name: string, fn: (span: unknown) => unknown) => {
          const attrs: Record<string, unknown> = {};
          startSpan(name, attrs);
          return fn({ setAttribute: (k: string, v: unknown) => (attrs[k] = v), setStatus: () => undefined, end: () => undefined });
        },
      }),
    },
  };
});

// STORY-190 — competitors from the site's own comparison pages, fetched through the guarded fetcher in the run phase. Fixtures only.

const BASE = { rootUrl: "https://hubspot.com", rootDomain: "hubspot.com", fieldsSupplied: [] as string[] };
const BRANDS = ["HubSpot"];
const page = (url: string, html: string) => ({ url, html });

const HOME = (links: string) => `<html><head><title>HubSpot | CRM</title></head><body>${links}</body></html>`;

type Route = string | { status?: number; finalUrl?: string; throws?: unknown; hang?: boolean };

function serving(routes: Record<string, Route>, now: () => number = () => Date.now()): DiscoverDeps & { fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async (url: string) => {
    const key = url.replace(/\/$/, "");
    const route = routes[key] ?? routes[url];
    if (route === undefined) throw new Error(`no fixture for ${url}`);
    if (typeof route === "string") return { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(route), finalUrl: url };
    if (route.throws !== undefined) throw route.throws;
    if (route.hang === true) return new Promise<never>(() => undefined);
    return { status: route.status ?? 200, headers: { "content-type": "text/html" }, body: Buffer.from(""), finalUrl: route.finalUrl ?? url };
  });
  return { fetch: fetch as never, now } as never;
}

describe("STORY-190 · which links are comparison pages", () => {
  const sel = (links: { href: string; text: string }[]) => selectComparisonPages(links, "https://hubspot.com", "hubspot.com");
  const selOn = (rootUrl: string, rootDomain: string, links: { href: string; text: string }[]) => selectComparisonPages(links, rootUrl, rootDomain);

  it("AC1/decision 99g - a path word (/compare, /vs, /alternatives) or the link text marks a comparison page", () => {
    const out = sel([
      { href: "/compare/salesforce", text: "Learn more" },
      { href: "/vs/zoho", text: "Read" },
      { href: "/why-us", text: "Compare plans" },
      { href: "/pricing", text: "Pricing" },
    ]);
    expect(out.urls).toEqual(["https://hubspot.com/compare/salesforce", "https://hubspot.com/vs/zoho", "https://hubspot.com/why-us"]);
    expect(sel([{ href: "/alternatives", text: "x" }]).urls).toEqual(["https://hubspot.com/alternatives"]);
  });

  it("AC1 - at most 3 pages", () => {
    const links = ["a", "b", "c", "d", "e"].map((s) => ({ href: `/compare/${s}`, text: "" }));
    expect(sel(links).urls).toHaveLength(3);
  });

  it("AC1 - off-site links are not selected and are counted; the www host of the same registrable domain is on-site", () => {
    const out = sel([
      { href: "https://evil.example/compare", text: "Compare" },
      { href: "https://www.hubspot.com/compare/x", text: "" },
      { href: "https://g2.com/hubspot-vs-x", text: "HubSpot vs X" },
    ]);
    expect(out.urls).toEqual(["https://www.hubspot.com/compare/x"]);
    expect(out.offSite).toBe(2);
  });

  it("review - a project on a shared host (github.io, vercel.app, myshopify.com) never follows another tenant's site on that host", () => {
    for (const [root, mine, theirs] of [
      ["https://acme.github.io", "https://acme.github.io/vs/x", "https://other.github.io/vs/x"],
      ["https://acme.vercel.app", "https://acme.vercel.app/compare", "https://other.vercel.app/compare"],
      ["https://acme.myshopify.com", "https://www.acme.myshopify.com/compare", "https://other.myshopify.com/compare"],
    ] as const) {
      const rootDomain = new URL(root).hostname.split(".").slice(-2).join("."); // what a public-suffix-only reading stores: the shared host
      const out = selOn(root, rootDomain, [{ href: mine, text: "" }, { href: theirs, text: "" }]);
      expect(out.urls).toEqual([mine]);
      expect(out.offSite).toBe(1);
    }
  });

  it("AC1 - the same page linked twice (or with a fragment) is selected once", () => {
    const out = sel([{ href: "/compare/x", text: "" }, { href: "/compare/x#top", text: "" }]);
    expect(out.urls).toHaveLength(1);
  });
});

describe("STORY-190 · rivals read from a comparison page's own structure", () => {
  it("AC3 - an 'X vs Y' title and heading, each with the page URL as its basis URL", () => {
    const out = proposeCompetitors({
      brandNames: BRANDS,
      links: [],
      pages: [page("https://hubspot.com/compare/a", `<html><head><title>HubSpot vs Salesforce</title></head><body><h2>HubSpot vs Zoho</h2></body></html>`)],
    });
    expect(out.map((c) => c.name).sort()).toEqual(["Salesforce", "Zoho"]);
    for (const c of out) {
      expect(c.basis).toBe("own comparison page");
      expect(c.basis_url).toBe("https://hubspot.com/compare/a");
    }
  });

  it("AC3 - table headers beside the brand's own column name rivals", () => {
    const html = `<table><thead><tr><th>Feature</th><th>HubSpot</th><th>Pipedrive</th><th>Zoho CRM</th></tr></thead></table>`;
    const out = proposeCompetitors({ brandNames: BRANDS, links: [], pages: [page("https://hubspot.com/compare", html)] });
    expect(out.map((c) => c.name)).toEqual(["Pipedrive", "Zoho CRM"]);
  });

  it("AC3 - a table that does not include the brand names nobody; generic headers are not names", () => {
    const html = `<table><tr><th>Feature</th><th>Price</th><th>Plan</th></tr></table><table><tr><th>Feature</th><th>HubSpot</th><th>Pricing</th></tr></table>`;
    expect(proposeCompetitors({ brandNames: BRANDS, links: [], pages: [page("https://hubspot.com/compare", html)] })).toEqual([]);
  });

  it("AC3 - names are never read from the URL slug", () => {
    const out = proposeCompetitors({
      brandNames: BRANDS,
      links: [],
      pages: [page("https://hubspot.com/compare/hubspot-vs-salesforce", `<html><body><h1>See how we stack up</h1><p>HubSpot vs Salesforce in prose</p></body></html>`)],
    });
    expect(out).toEqual([]);
  });

  it("decision 99g - a rival found only on a comparison page has a lower confidence than one in a home-page link", () => {
    const [home] = proposeCompetitors({ brandNames: BRANDS, links: [{ href: "/vs/z", text: "HubSpot vs Zoho" }] });
    const [onPage] = proposeCompetitors({ brandNames: BRANDS, links: [], pages: [page("https://hubspot.com/vs/z", `<h1>HubSpot vs Zoho</h1>`)] });
    expect(onPage!.confidence).toBeLessThan(home!.confidence);
    const [alt] = proposeCompetitors({ brandNames: BRANDS, links: [{ href: "/alternatives/p", text: "Pipedrive alternatives" }] });
    expect(onPage!.confidence).toBeLessThan(alt!.confidence);
  });

  it("AC4 - never repeats the brand, and a rival also in a home link is proposed once, keeping the home link's confidence and no page URL", () => {
    const out = proposeCompetitors({
      brandNames: BRANDS,
      links: [{ href: "/vs/z", text: "HubSpot vs Zoho" }],
      pages: [page("https://hubspot.com/compare", `<h1>HubSpot vs ZOHO</h1><h2>HubSpot vs HubSpot CRM</h2>`)],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Zoho", confidence: 0.8 });
    expect(out[0]!.basis_url).toBeUndefined();
  });

  it("AC5 - the cap stays 5 and the home-page links are taken first", () => {
    const home = ["H1", "H2", "H3", "H4"].map((n) => ({ href: "/vs/x", text: `HubSpot vs ${n}` }));
    const headings = ["P1", "P2", "P3"].map((n) => `<h2>HubSpot vs ${n}</h2>`).join("");
    const out = proposeCompetitors({ brandNames: BRANDS, links: home, pages: [page("https://hubspot.com/compare", headings)] });
    expect(MAX_PROPOSED_COMPETITORS).toBe(5);
    expect(out).toHaveLength(5);
    expect(out.slice(0, 4).map((c) => c.name)).toEqual(["H1", "H2", "H3", "H4"]);
    expect(out[4]!.basis_url).toBe("https://hubspot.com/compare");
  });
});

describe("STORY-190 · discover() opens comparison pages through the guarded fetcher", () => {
  const home = HOME(`<a href="/compare">Compare</a><a href="/alternatives">See alternatives</a>`);

  it("AC1/AC3 - a generic 'Compare' link proposes nobody from the home page, but the page behind it does", async () => {
    const deps = serving({
      "https://hubspot.com": home,
      "https://hubspot.com/compare": `<h1>HubSpot vs Salesforce</h1>`,
      "https://hubspot.com/alternatives": `<table><tr><th>HubSpot</th><th>Pipedrive</th></tr></table>`,
    });
    const result = await discover(BASE, deps);
    expect(result.competitors_proposed.map((c) => c.name).sort()).toEqual(["Pipedrive", "Salesforce"]);
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    // Redirects off the site are vetoed through the guarded fetcher's hook, and the body may be truncated rather than rejected.
    const init = deps.fetch.mock.calls[1]![1] as { followRedirect: (u: string) => boolean };
    expect(init.followRedirect("https://hubspot.com/x")).toBe(true);
    expect(init.followRedirect("https://elsewhere.example/x")).toBe(false);
  });

  it("review - 'Discover Financial' and 'Checkout.com' are real rivals, not calls to action; 'See alternatives' still names nobody", () => {
    const out = proposeCompetitors({
      brandNames: BRANDS,
      links: [{ href: "/a", text: "Discover Financial alternatives" }, { href: "/b", text: "Checkout.com alternatives" }, { href: "/c", text: "All Saints vs HubSpot" }, { href: "/d", text: "See alternatives" }, { href: "/e", text: "View all alternatives" }, { href: "/f", text: "Find more alternatives" }],
    });
    expect(out.map((c) => c.name).sort()).toEqual(["All Saints", "Checkout.com", "Discover Financial"]);
  });

  it("review - a fetch that loses the budget race and answers LATE is discarded: its page proposes nothing and nothing throws", async () => {
    vi.useFakeTimers();
    try {
      const late = `<h1>HubSpot vs Latecomer</h1>`;
      const deps = serving({ "https://hubspot.com": HOME(`<a href="/compare">Compare</a>`), "https://hubspot.com/compare": late });
      const real = deps.fetch.getMockImplementation()! as (url: string, init?: unknown) => Promise<unknown>;
      deps.fetch.mockImplementation(async (url: string, init?: unknown) => {
        if (!url.endsWith("/compare")) return real(url, init);
        await new Promise((r) => setTimeout(r, DISCOVERY_BUDGET_MS + 5_000)); // answers after the budget has closed
        return real(url, init);
      });
      const seen: { skippedBudget: number; fetched: number }[] = [];
      Object.assign(deps, { onComparisonPages: (s: { skippedBudget: number; fetched: number }) => seen.push(s) });
      const pending = discover(BASE, deps);
      await vi.advanceTimersByTimeAsync(DISCOVERY_BUDGET_MS + 1);
      const result = await pending;
      await vi.advanceTimersByTimeAsync(10_000); // the late answer lands now
      expect(result.competitors_proposed).toEqual([]);
      expect(seen).toEqual([expect.objectContaining({ skippedBudget: 1, fetched: 0 })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC4 - supplied competitors: nothing proposed and no comparison page is fetched", async () => {
    const deps = serving({ "https://hubspot.com": home });
    const result = await discover({ ...BASE, fieldsSupplied: ["competitors"] }, deps);
    expect(result.competitors_proposed).toEqual([]);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it("AC1 - a redirect off the registrable domain, a refusal and a failure are skipped and recorded, never failing the pass", async () => {
    const seen: unknown[] = [];
    const deps = {
      ...serving({
        "https://hubspot.com": HOME(`<a href="/compare/a">A</a><a href="/compare/b">B</a><a href="/compare/c">C</a><a href="/compare/d">D</a>`),
        "https://hubspot.com/compare/a": { finalUrl: "https://other.example/compare" },
        "https://hubspot.com/compare/b": { throws: new GuardedFetchRefusal("redirect_target_refused") },
        "https://hubspot.com/compare/c": `<h1>HubSpot vs Zoho</h1>`,
      }),
      onComparisonPages: (stats: unknown) => seen.push(stats),
    } as DiscoverDeps;
    const result = await discover(BASE, deps);
    expect(result.discovery_status).toBe("completed");
    expect(result.competitors_proposed.map((c) => c.name)).toEqual(["Zoho"]);
    expect(seen).toEqual([{ selected: 3, fetched: 1, offSite: 0, redirectedOff: 1, refused: 1, failed: 0, skippedBudget: 0 }]);
  });

  it("AC2 - a page that would exceed the discovery budget is skipped and the run is not failed", async () => {
    vi.useFakeTimers();
    try {
      const deps = serving({
        "https://hubspot.com": home,
        "https://hubspot.com/compare": { hang: true },
        "https://hubspot.com/alternatives": `<h1>HubSpot vs Zoho</h1>`,
      });
      const pending = discover(BASE, deps);
      await vi.advanceTimersByTimeAsync(DISCOVERY_BUDGET_MS + 1);
      const result = await pending;
      expect(result.discovery_status).toBe("completed");
      expect(result.competitors_proposed.map((c) => c.name)).toEqual(["Zoho"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC2 - no budget left after the root fetch: no page is fetched at all", async () => {
    let t = 0;
    const deps = serving({ "https://hubspot.com": home }, () => t);
    (deps.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      t += DISCOVERY_BUDGET_MS;
      return { status: 200, headers: {}, body: Buffer.from(home), finalUrl: "https://hubspot.com/" };
    });
    const result = await discover(BASE, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(result.discovery_status).toBe("completed");
  });

  it("AC6 - a login wall (401/403) or a non-HTML answer proposes nothing", async () => {
    const deps = serving({
      "https://hubspot.com": home,
      "https://hubspot.com/compare": { status: 403 },
      "https://hubspot.com/alternatives": { status: 401 },
    });
    expect((await discover(BASE, deps)).competitors_proposed).toEqual([]);
  });

  it("observability - a span and a counter per outcome, with counts only (no URL, no name)", async () => {
    vi.mocked(incrementCounter).mockClear();
    startSpan.mockClear();
    const deps = serving({
      "https://hubspot.com": home,
      "https://hubspot.com/compare": `<h1>HubSpot vs Salesforce</h1>`,
      "https://hubspot.com/alternatives": { status: 403 },
    });
    await discover(BASE, deps);
    expect(startSpan).toHaveBeenCalledWith("discovery.comparison_pages", expect.objectContaining({ "nominara.discovery.comparison_pages_selected": 2, "nominara.discovery.comparison_pages_fetched": 1 }));
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_discovery_comparison_pages_total", { outcome: "fetched" });
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_discovery_comparison_pages_total", { outcome: "failed" });
    const serialised = JSON.stringify([...vi.mocked(incrementCounter).mock.calls, ...startSpan.mock.calls]);
    expect(serialised).not.toMatch(/Salesforce|hubspot\.com\/compare/);
  });
});
