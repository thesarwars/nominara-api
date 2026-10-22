import { describe, expect, it } from "vitest";
import { PROVISIONAL_PAGE_CAP, pageCapForPlan, selectPages } from "./page-selection.js";
import type { SitemapEntry } from "./sitemap.js";

const entry = (loc: string, priority: number | null = null): SitemapEntry => ({ loc, lastmod: null, priority });
const base = { rootUrl: "https://acme.com/", cap: 10, sitemap: [] as SitemapEntry[], ownedCitationUrls: [] as string[], openTaskUrls: [] as string[], targetUrls: [] as string[] };

describe("STORY-049 AC5 · selectPages", () => {
  it("public_surface is the supplied URL and nothing else, however much the sitemap offers", () => {
    const r = selectPages({ ...base, scope: "public_surface", sitemap: [entry("https://acme.com/a"), entry("https://acme.com/b")] });
    expect(r.urls).toEqual(["https://acme.com/"]);
  });

  it("single_url is the one target, and a target on another site is refused with a reason, not fetched", () => {
    expect(selectPages({ ...base, scope: "single_url", targetUrls: ["https://acme.com/pricing"] }).urls).toEqual(["https://acme.com/pricing"]);
    const foreign = selectPages({ ...base, scope: "single_url", targetUrls: ["https://rival.com/pricing"] });
    expect(foreign.urls).toEqual([]);
    expect(foreign.skipped).toEqual([{ url: "https://rival.com/pricing", reason: "foreign_site" }]);
  });

  it("key_pages: the root first, then every owned-citation and open-task URL, then sitemap pages by priority", () => {
    const r = selectPages({
      ...base,
      scope: "key_pages",
      sitemap: [entry("https://acme.com/low", 0.1), entry("https://acme.com/high", 0.9), entry("https://acme.com/mid", 0.5)],
      ownedCitationUrls: ["https://acme.com/cited"],
      openTaskUrls: ["https://acme.com/task"],
    });
    expect(r.urls).toEqual([
      "https://acme.com/",
      "https://acme.com/cited",
      "https://acme.com/task",
      "https://acme.com/high",
      "https://acme.com/mid",
      "https://acme.com/low",
    ]);
  });

  it("key_pages: an explicit priority 0 sorts below an ABSENT priority (null is the protocol default 0.5, not 0)", () => {
    const r = selectPages({ ...base, scope: "key_pages", sitemap: [entry("https://acme.com/zero", 0), entry("https://acme.com/none", null)] });
    expect(r.urls).toEqual(["https://acme.com/", "https://acme.com/none", "https://acme.com/zero"]);
  });

  it("the cap is a hard stop and the cut is counted, not silent", () => {
    const sitemap = Array.from({ length: 30 }, (_, i) => entry(`https://acme.com/p${i}`, 0.5));
    const r = selectPages({ ...base, scope: "key_pages", cap: 5, sitemap });
    expect(r.urls).toHaveLength(5);
    expect(r.overCap).toBe(26); // 31 candidates (root + 30), 5 kept
  });

  it("a cap of 0 selects nothing, and a non-integer or negative cap is refused (NaN would disable the stop)", () => {
    expect(selectPages({ ...base, scope: "key_pages", cap: 0 }).urls).toEqual([]);
    expect(() => selectPages({ ...base, scope: "key_pages", cap: Number.NaN })).toThrow();
    expect(() => selectPages({ ...base, scope: "key_pages", cap: -1 })).toThrow();
    expect(() => selectPages({ ...base, scope: "key_pages", cap: 1.5 })).toThrow();
  });

  it("never selects another registrable domain, a non-http scheme, or a duplicate (fragment and case in the host ignored)", () => {
    const r = selectPages({
      ...base,
      scope: "key_pages",
      sitemap: [
        entry("https://rival.com/x"),
        entry("javascript:alert(1)"),
        entry("file:///etc/passwd"),
        entry("https://ACME.com/a#top"),
        entry("https://acme.com/a"),
        entry("https://blog.acme.com/post"),
        entry("not a url"),
      ],
    });
    expect(r.urls).toEqual(["https://acme.com/", "https://acme.com/a", "https://blog.acme.com/post"]);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["foreign_site", "not_http", "not_http", "not_http"]);
  });

  it("sitemap_sample is stratified by path depth: a shallow-heavy sitemap still yields the deep pages", () => {
    const sitemap = [
      ...Array.from({ length: 50 }, (_, i) => entry(`https://acme.com/s${i}`)),
      ...Array.from({ length: 5 }, (_, i) => entry(`https://acme.com/a/b/c/d${i}`)),
    ];
    const r = selectPages({ ...base, scope: "sitemap_sample", cap: 6, sitemap });
    expect(r.urls).toHaveLength(6);
    expect(r.urls.some((u) => u.includes("/a/b/c/"))).toBe(true);
    expect(r.urls.some((u) => /\/s\d+$/.test(u))).toBe(true);
  });

  it("sitemap_sample is deterministic: the same sitemap gives the same sample", () => {
    const sitemap = Array.from({ length: 40 }, (_, i) => entry(`https://acme.com/x/${i}`));
    const a = selectPages({ ...base, scope: "sitemap_sample", cap: 7, sitemap }).urls;
    const b = selectPages({ ...base, scope: "sitemap_sample", cap: 7, sitemap }).urls;
    expect(a).toEqual(b);
  });

  it("an empty sitemap on key_pages still audits the root", () => {
    expect(selectPages({ ...base, scope: "key_pages" }).urls).toEqual(["https://acme.com/"]);
  });
});

describe("STORY-049 AC5 · the page cap from the plan", () => {
  it("is a provisional constant until plans-and-entitlements.md gives aux.pages_per_audit values", () => {
    expect(PROVISIONAL_PAGE_CAP).toBe(25);
    expect(pageCapForPlan("free")).toBe(PROVISIONAL_PAGE_CAP);
    expect(pageCapForPlan("anything")).toBe(PROVISIONAL_PAGE_CAP);
  });
});
