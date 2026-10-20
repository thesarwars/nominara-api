import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { collectSitemap, MAX_SITEMAP_DEPTH, MAX_SITEMAP_URLS, MAX_SITEMAP_FILES } from "./sitemap.js";

// STORY-049 AC4 — "the sitemap with bounded index recursion and a sampling cap" (aux-and-geo-analysis.md §1:
// "GET /sitemap.xml (+ index recursion, max 3 levels, max 5,000 URLs sampled)"). The source is the robots.txt `Sitemap:`
// lines, with /sitemap.xml as the default. Every bound exists because a sitemap is attacker-shaped input: an index can
// reference itself, nest without end, or list a million entries.

type Files = Record<string, string | Buffer | "throw" | { status: number; body: string }>;

const urlset = (locs: string[], extra = ""): string =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc>${extra}</url>`)
    .join("")}</urlset>`;
const index = (locs: string[]): string =>
  `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;

function serve(files: Files, fetched: string[] = []) {
  return async (url: string) => {
    fetched.push(url);
    const hit = files[url];
    if (hit === undefined) return { status: 404, body: Buffer.from("") };
    if (hit === "throw") throw new Error("connection refused");
    if (typeof hit === "object" && !Buffer.isBuffer(hit)) return { status: hit.status, body: Buffer.from(hit.body) };
    return { status: 200, body: Buffer.isBuffer(hit) ? hit : Buffer.from(hit) };
  };
}

const ORIGIN = "https://acme.com";
const run = (files: Files, over: Partial<Parameters<typeof collectSitemap>[0]> = {}, fetched: string[] = []) =>
  collectSitemap({ origin: ORIGIN, declared: [], fetch: serve(files, fetched), ...over });

describe("STORY-049 AC4 · the documented bounds", () => {
  it("3 levels, 5,000 URLs", () => {
    expect(MAX_SITEMAP_DEPTH).toBe(3);
    expect(MAX_SITEMAP_URLS).toBe(5000);
  });
});

describe("STORY-049 AC4 · sitemap discovery", () => {
  it("defaults to /sitemap.xml when robots.txt declares none", async () => {
    const fetched: string[] = [];
    const result = await run({ [`${ORIGIN}/sitemap.xml`]: urlset([`${ORIGIN}/a`, `${ORIGIN}/b`]) }, {}, fetched);
    expect(fetched).toEqual([`${ORIGIN}/sitemap.xml`]);
    expect(result.urls.map((u) => u.loc)).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);
    expect(result.sampled).toBe(false);
  });

  it("takes the URL from the robots.txt Sitemap lines, and NOT the default, when any is declared", async () => {
    const fetched: string[] = [];
    await run({ [`${ORIGIN}/maps/main.xml`]: urlset([`${ORIGIN}/a`]) }, { declared: [`${ORIGIN}/maps/main.xml`] }, fetched);
    expect(fetched).toEqual([`${ORIGIN}/maps/main.xml`]);
  });

  it("reads loc, lastmod and priority; priority is null when absent and a real 0 stays 0", async () => {
    const xml = `<urlset><url><loc>${ORIGIN}/a</loc><lastmod>2026-09-01</lastmod><priority>0.8</priority></url><url><loc>${ORIGIN}/b</loc><priority>0</priority></url><url><loc>${ORIGIN}/c</loc></url></urlset>`;
    const { urls } = await run({ [`${ORIGIN}/sitemap.xml`]: xml });
    expect(urls).toEqual([
      { loc: `${ORIGIN}/a`, lastmod: "2026-09-01", priority: 0.8 },
      { loc: `${ORIGIN}/b`, lastmod: null, priority: 0 },
      { loc: `${ORIGIN}/c`, lastmod: null, priority: null },
    ]);
  });

  it("decodes XML entities and CDATA in a loc, and ignores an empty or whitespace-only loc", async () => {
    const xml = `<urlset><url><loc>${ORIGIN}/q?a=1&amp;b=2</loc></url><url><loc><![CDATA[${ORIGIN}/cd?x=1&y=2]]></loc></url><url><loc>   </loc></url></urlset>`;
    const { urls } = await run({ [`${ORIGIN}/sitemap.xml`]: xml });
    expect(urls.map((u) => u.loc)).toEqual([`${ORIGIN}/q?a=1&b=2`, `${ORIGIN}/cd?x=1&y=2`]);
  });

  it("follows an index to its children and merges their URLs, in order", async () => {
    const { urls, filesFetched } = await run({
      [`${ORIGIN}/sitemap.xml`]: index([`${ORIGIN}/s1.xml`, `${ORIGIN}/s2.xml`]),
      [`${ORIGIN}/s1.xml`]: urlset([`${ORIGIN}/a`]),
      [`${ORIGIN}/s2.xml`]: urlset([`${ORIGIN}/b`]),
    });
    expect(urls.map((u) => u.loc)).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);
    expect(filesFetched).toBe(3);
  });

  it("recurses to exactly 3 levels: an index at level 3 is NOT expanded, and the cut is recorded", async () => {
    const fetched: string[] = [];
    const result = await run(
      {
        [`${ORIGIN}/sitemap.xml`]: index([`${ORIGIN}/l2.xml`]),
        [`${ORIGIN}/l2.xml`]: index([`${ORIGIN}/l3.xml`]),
        [`${ORIGIN}/l3.xml`]: index([`${ORIGIN}/l4.xml`]),
        [`${ORIGIN}/l4.xml`]: urlset([`${ORIGIN}/deep`]),
      },
      {},
      fetched,
    );
    expect(fetched).toEqual([`${ORIGIN}/sitemap.xml`, `${ORIGIN}/l2.xml`, `${ORIGIN}/l3.xml`]);
    expect(result.urls).toEqual([]);
    expect(result.problems).toContainEqual({ url: `${ORIGIN}/l4.xml`, reason: "depth_exceeded" });
  });

  it("an index that references itself, or a cycle, is fetched once", async () => {
    const fetched: string[] = [];
    await run(
      {
        [`${ORIGIN}/sitemap.xml`]: index([`${ORIGIN}/sitemap.xml`, `${ORIGIN}/b.xml`]),
        [`${ORIGIN}/b.xml`]: index([`${ORIGIN}/sitemap.xml`]),
      },
      {},
      fetched,
    );
    expect(fetched).toEqual([`${ORIGIN}/sitemap.xml`, `${ORIGIN}/b.xml`]);
  });

  it("scenario: a sitemap past 5,000 URLs is SAMPLED to exactly the cap, spread across the whole list, and says so", async () => {
    const locs = Array.from({ length: 12_345 }, (_, i) => `${ORIGIN}/p/${String(i)}`);
    const result = await run({ [`${ORIGIN}/sitemap.xml`]: urlset(locs) });
    expect(result.urls).toHaveLength(MAX_SITEMAP_URLS);
    expect(result.sampled).toBe(true);
    expect(result.totalSeen).toBe(12_345);
    const picked = result.urls.map((u) => Number(u.loc.split("/").pop()));
    // not "the first 5,000": the last decile of the list is represented
    expect(Math.max(...picked)).toBeGreaterThan(12_000);
    expect(new Set(picked).size).toBe(MAX_SITEMAP_URLS);
    // deterministic: the same input samples the same URLs
    const again = await run({ [`${ORIGIN}/sitemap.xml`]: urlset(locs) });
    expect(again.urls).toEqual(result.urls);
  });

  it("exactly 5,000 URLs is not 'sampled'; 5,001 is", async () => {
    const make = (n: number) => urlset(Array.from({ length: n }, (_, i) => `${ORIGIN}/p/${String(i)}`));
    expect((await run({ [`${ORIGIN}/sitemap.xml`]: make(5000) })).sampled).toBe(false);
    const over = await run({ [`${ORIGIN}/sitemap.xml`]: make(5001) });
    expect(over.sampled).toBe(true);
    expect(over.urls).toHaveLength(5000);
  });

  it("a child sitemap on another site is NOT fetched (a crawl never leaves the verified registrable domain), and is named", async () => {
    const fetched: string[] = [];
    const result = await run(
      {
        [`${ORIGIN}/sitemap.xml`]: index(["https://evil.example/s.xml", "https://blog.acme.com/s.xml"]),
        "https://blog.acme.com/s.xml": urlset(["https://blog.acme.com/post"]),
      },
      {},
      fetched,
    );
    expect(fetched).toEqual([`${ORIGIN}/sitemap.xml`, "https://blog.acme.com/s.xml"]);
    expect(result.problems).toContainEqual({ url: "https://evil.example/s.xml", reason: "foreign_site" });
    expect(result.urls.map((u) => u.loc)).toEqual(["https://blog.acme.com/post"]);
  });

  it("a declared Sitemap line on another site is skipped the same way", async () => {
    const fetched: string[] = [];
    const result = await run({}, { declared: ["https://evil.example/s.xml"] }, fetched);
    expect(fetched).toEqual([]);
    expect(result.problems).toContainEqual({ url: "https://evil.example/s.xml", reason: "foreign_site" });
  });

  it("a child that fails does not stop the others; the failure is recorded with its reason", async () => {
    const result = await run({
      [`${ORIGIN}/sitemap.xml`]: index([`${ORIGIN}/ok.xml`, `${ORIGIN}/dead.xml`, `${ORIGIN}/gone.xml`, `${ORIGIN}/bad.xml`]),
      [`${ORIGIN}/ok.xml`]: urlset([`${ORIGIN}/a`]),
      [`${ORIGIN}/dead.xml`]: "throw",
      [`${ORIGIN}/gone.xml`]: { status: 404, body: "" },
      [`${ORIGIN}/bad.xml`]: "this is not xml",
    });
    expect(result.urls.map((u) => u.loc)).toEqual([`${ORIGIN}/a`]);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        { url: `${ORIGIN}/dead.xml`, reason: "fetch_failed" },
        { url: `${ORIGIN}/gone.xml`, reason: "http_404" },
        { url: `${ORIGIN}/bad.xml`, reason: "not_a_sitemap" },
      ]),
    );
  });

  it("the number of files fetched is bounded, so an index of a million sitemaps cannot become a million requests", async () => {
    const children = Array.from({ length: MAX_SITEMAP_FILES + 30 }, (_, i) => `${ORIGIN}/c${String(i)}.xml`);
    const files: Files = { [`${ORIGIN}/sitemap.xml`]: index(children) };
    for (const c of children) files[c] = urlset([`${c}/page`]);
    const fetched: string[] = [];
    const result = await run(files, {}, fetched);
    expect(fetched).toHaveLength(MAX_SITEMAP_FILES);
    expect(result.problems.some((p) => p.reason === "file_budget_exhausted")).toBe(true);
  });

  it("reads a gzipped sitemap, and refuses one that expands past the size cap (a decompression bomb)", async () => {
    const ok = await run({ [`${ORIGIN}/sitemap.xml`]: gzipSync(urlset([`${ORIGIN}/z`])) });
    expect(ok.urls.map((u) => u.loc)).toEqual([`${ORIGIN}/z`]);
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x20));
    const refused = await run({ [`${ORIGIN}/sitemap.xml`]: bomb });
    expect(refused.urls).toEqual([]);
    expect(refused.problems).toContainEqual({ url: `${ORIGIN}/sitemap.xml`, reason: "too_large" });
  });

  it("no sitemap at all (404) is an empty, non-failing result with the 404 recorded", async () => {
    const result = await run({});
    expect(result.urls).toEqual([]);
    expect(result.totalSeen).toBe(0);
    expect(result.problems).toEqual([{ url: `${ORIGIN}/sitemap.xml`, reason: "http_404" }]);
  });
});
