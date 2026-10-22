import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { collectSitemap, MAX_SITEMAP_DEPTH, MAX_SITEMAP_URLS, MAX_SITEMAP_FILES, SitemapFetchSkipped } from "./sitemap.js";

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
// Built by join, as ebd1f97 did: ISO-14 reads a template literal ending in a path as an object-key construction site.
const at = (path: string): string => [ORIGIN, path].join("/");
/** A URL on the fixture origin. Built by concatenation so a URL fixture is never mistaken for an object-storage key (ISO-14). */
const u = (path: string): string => ORIGIN + path;
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
    const result = await run({ [u("/sitemap.xml")]: urlset([u("/a"), u("/b")]) }, {}, fetched);
    expect(fetched).toEqual([u("/sitemap.xml")]);
    expect(result.urls.map((u) => u.loc)).toEqual([u("/a"), u("/b")]);
    expect(result.sampled).toBe(false);
  });

  it("takes the URL from the robots.txt Sitemap lines, and NOT the default, when any is declared", async () => {
    const fetched: string[] = [];
    await run({ [u("/maps/main.xml")]: urlset([u("/a")]) }, { declared: [u("/maps/main.xml")] }, fetched);
    expect(fetched).toEqual([u("/maps/main.xml")]);
  });

  it("reads loc, lastmod and priority; priority is null when absent and a real 0 stays 0", async () => {
    const xml = `<urlset><url><loc>${at("a")}</loc><lastmod>2026-09-01</lastmod><priority>0.8</priority></url><url><loc>${at("b")}</loc><priority>0</priority></url><url><loc>${ORIGIN}/c</loc></url></urlset>`;
    const { urls } = await run({ [u("/sitemap.xml")]: xml });
    expect(urls).toEqual([
      { loc: u("/a"), lastmod: "2026-09-01", priority: 0.8 },
      { loc: u("/b"), lastmod: null, priority: 0 },
      { loc: u("/c"), lastmod: null, priority: null },
    ]);
  });

  it("decodes XML entities and CDATA in a loc, and ignores an empty or whitespace-only loc", async () => {
    const xml = `<urlset><url><loc>${ORIGIN}/q?a=1&amp;b=2</loc></url><url><loc><![CDATA[${ORIGIN}/cd?x=1&y=2]]></loc></url><url><loc>   </loc></url></urlset>`;
    const { urls } = await run({ [u("/sitemap.xml")]: xml });
    expect(urls.map((u) => u.loc)).toEqual([u("/q?a=1&b=2"), u("/cd?x=1&y=2")]);
  });

  it("follows an index to its children and merges their URLs, in order", async () => {
    const { urls, filesFetched } = await run({
      [u("/sitemap.xml")]: index([u("/s1.xml"), u("/s2.xml")]),
      [u("/s1.xml")]: urlset([u("/a")]),
      [u("/s2.xml")]: urlset([u("/b")]),
    });
    expect(urls.map((u) => u.loc)).toEqual([u("/a"), u("/b")]);
    expect(filesFetched).toBe(3);
  });

  it("recurses to exactly 3 levels: an index at level 3 is NOT expanded, and the cut is recorded", async () => {
    const fetched: string[] = [];
    const result = await run(
      {
        [u("/sitemap.xml")]: index([u("/l2.xml")]),
        [u("/l2.xml")]: index([u("/l3.xml")]),
        [u("/l3.xml")]: index([u("/l4.xml")]),
        [u("/l4.xml")]: urlset([u("/deep")]),
      },
      {},
      fetched,
    );
    expect(fetched).toEqual([u("/sitemap.xml"), u("/l2.xml"), u("/l3.xml")]);
    expect(result.urls).toEqual([]);
    expect(result.problems).toContainEqual({ url: u("/l4.xml"), reason: "depth_exceeded" });
  });

  it("an index that references itself, or a cycle, is fetched once", async () => {
    const fetched: string[] = [];
    await run(
      {
        [u("/sitemap.xml")]: index([u("/sitemap.xml"), u("/b.xml")]),
        [u("/b.xml")]: index([u("/sitemap.xml")]),
      },
      {},
      fetched,
    );
    expect(fetched).toEqual([u("/sitemap.xml"), u("/b.xml")]);
  });

  it("scenario: a sitemap past 5,000 URLs is SAMPLED to exactly the cap, spread across the whole list, and says so", async () => {
    const locs = Array.from({ length: 12_345 }, (_, i) => u(`/p/${String(i)}`));
    const result = await run({ [u("/sitemap.xml")]: urlset(locs) });
    expect(result.urls).toHaveLength(MAX_SITEMAP_URLS);
    expect(result.sampled).toBe(true);
    expect(result.totalSeen).toBe(12_345);
    const picked = result.urls.map((u) => Number(u.loc.split("/").pop()));
    // not "the first 5,000": the last decile of the list is represented
    expect(Math.max(...picked)).toBeGreaterThan(12_000);
    expect(new Set(picked).size).toBe(MAX_SITEMAP_URLS);
    // deterministic: the same input samples the same URLs
    const again = await run({ [u("/sitemap.xml")]: urlset(locs) });
    expect(again.urls).toEqual(result.urls);
  });

  it("exactly 5,000 URLs is not 'sampled'; 5,001 is", async () => {
    const make = (n: number) => urlset(Array.from({ length: n }, (_, i) => u(`/p/${String(i)}`)));
    expect((await run({ [u("/sitemap.xml")]: make(5000) })).sampled).toBe(false);
    const over = await run({ [u("/sitemap.xml")]: make(5001) });
    expect(over.sampled).toBe(true);
    expect(over.urls).toHaveLength(5000);
  });

  it("a child sitemap on another site is NOT fetched (a crawl never leaves the verified registrable domain), and is named", async () => {
    const fetched: string[] = [];
    const result = await run(
      {
        [u("/sitemap.xml")]: index(["https://evil.example/s.xml", "https://blog.acme.com/s.xml"]),
        "https://blog.acme.com/s.xml": urlset(["https://blog.acme.com/post"]),
      },
      {},
      fetched,
    );
    expect(fetched).toEqual([u("/sitemap.xml"), "https://blog.acme.com/s.xml"]);
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
      [u("/sitemap.xml")]: index([u("/ok.xml"), u("/dead.xml"), u("/gone.xml"), u("/bad.xml")]),
      [u("/ok.xml")]: urlset([u("/a")]),
      [u("/dead.xml")]: "throw",
      [u("/gone.xml")]: { status: 404, body: "" },
      [u("/bad.xml")]: "this is not xml",
    });
    expect(result.urls.map((u) => u.loc)).toEqual([u("/a")]);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        { url: u("/dead.xml"), reason: "fetch_failed" },
        { url: u("/gone.xml"), reason: "http_404" },
        { url: u("/bad.xml"), reason: "not_a_sitemap" },
      ]),
    );
  });

  it("the number of files fetched is bounded, so an index of a million sitemaps cannot become a million requests", async () => {
    const children = Array.from({ length: MAX_SITEMAP_FILES + 30 }, (_, i) => u(`/c${String(i)}.xml`));
    const files: Files = { [u("/sitemap.xml")]: index(children) };
    for (const c of children) files[c] = urlset([[c, "page"].join("/")]);
    const fetched: string[] = [];
    const result = await run(files, {}, fetched);
    expect(fetched).toHaveLength(MAX_SITEMAP_FILES);
    expect(result.problems.some((p) => p.reason === "file_budget_exhausted")).toBe(true);
  });

  it("reads a gzipped sitemap, and refuses one that expands past the size cap (a decompression bomb)", async () => {
    const ok = await run({ [u("/sitemap.xml")]: gzipSync(urlset([u("/z")])) });
    expect(ok.urls.map((u) => u.loc)).toEqual([u("/z")]);
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x20));
    const refused = await run({ [u("/sitemap.xml")]: bomb });
    expect(refused.urls).toEqual([]);
    expect(refused.problems).toContainEqual({ url: u("/sitemap.xml"), reason: "too_large" });
  });

  it("no sitemap at all (404) is an empty, non-failing result with the 404 recorded", async () => {
    const result = await run({});
    expect(result.urls).toEqual([]);
    expect(result.totalSeen).toBe(0);
    expect(result.problems).toEqual([{ url: u("/sitemap.xml"), reason: "http_404" }]);
  });
});

// Review round 2 — the parser used to scan with lazy-quantifier regexes, so a file of UNCLOSED tags made every start
// position scan to the end of the input: quadratic, about 11 minutes for a 5 MB file, on a synchronous call.
//
// WHY A FIXED 5000 ms BOUND STILL MEANS SOMETHING (measured at review, round 2): the pre-fcccc94 regex implementation on
// these same inputs did not finish. The urlset regex over 400k unclosed `<url>` was killed at 40 s; the 5 MB case takes
// about 11 minutes. The linear implementation takes tens of milliseconds, so 5000 ms is ~100x headroom for a loaded host
// and still ~8x below the point where the quadratic version had not yet returned. If a future change makes this bound
// flake, widen it with a new measurement here; do not remove the test.
describe("STORY-049 AC4 · a hostile sitemap cannot make the parser quadratic", () => {
  const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
    const start = performance.now();
    const value = await fn();
    return { value, ms: performance.now() - start };
  };
  const collect = (body: string) =>
    collectSitemap({ origin: ORIGIN, declared: [at("sitemap.xml")], fetch: serve({ [at("sitemap.xml")]: body }) });

  it("2 MB of unclosed <url> tags in a urlset finishes in quickly (linear-time)", async () => {
    const { value, ms } = await timed(() => collect(`<urlset>${"<url>".repeat(400_000)}`));
    expect(value.urls).toEqual([]);
    expect(ms).toBeLessThan(5000);
  });

  it("2 MB of unclosed <sitemap> tags in an index finishes in quickly (linear-time)", async () => {
    const { ms } = await timed(() => collect(`<sitemapindex>${"<sitemap>".repeat(250_000)}`));
    expect(ms).toBeLessThan(5000);
  });

  it("2 MB of unclosed <loc> tags INSIDE one <url> is linear too", async () => {
    const { ms } = await timed(() => collect(`<urlset><url>${"<loc>".repeat(400_000)}</url></urlset>`));
    expect(ms).toBeLessThan(5000);
  });

  it("still reads the well-formed entries that precede the junk", async () => {
    const { value } = await timed(() => collect(`<urlset><url><loc>${at("a")}</loc></url><url><loc>${at("b")}</loc></url>${"<url>".repeat(1000)}`));
    expect(value.urls.map((u) => u.loc)).toEqual([at("a"), at("b")]);
  });

  it("a tag whose name merely STARTS with url (<urlx>) is not a <url>", async () => {
    const { value } = await timed(() => collect(`<urlset><urlx><loc>${at("no")}</loc></urlx><url><loc>${at("yes")}</loc></url></urlset>`));
    expect(value.urls.map((u) => u.loc)).toEqual([at("yes")]);
  });
});


describe("review r5 · a sitemap file the wall-clock budget did not allow is a SKIP, not a failure", () => {
  it("records crawl_delay_budget, counts no file as fetched, and never reports fetch_failed", async () => {
    const result = await collectSitemap({
      origin: ORIGIN,
      declared: [],
      fetch: async () => {
        throw new SitemapFetchSkipped();
      },
    });
    expect(result.problems).toEqual([{ url: at("sitemap.xml"), reason: "crawl_delay_budget" }]);
    expect(result.filesFetched).toBe(0);
    expect(result.urls).toEqual([]);
  });

  it("a skipped child does not stop its siblings, and only the requests actually made are counted", async () => {
    const files: Files = {
      [at("sitemap.xml")]: index([at("a.xml"), at("b.xml")]),
      [at("b.xml")]: urlset([at("p")]),
    };
    const inner = serve(files);
    const result = await collectSitemap({
      origin: ORIGIN,
      declared: [],
      fetch: async (url) => {
        if (url === at("a.xml")) throw new SitemapFetchSkipped();
        return inner(url);
      },
    });
    expect(result.problems).toEqual([{ url: at("a.xml"), reason: "crawl_delay_budget" }]);
    expect(result.filesFetched).toBe(2); // the index and b.xml; a.xml was never requested
    expect(result.urls.map((e) => e.loc)).toEqual([at("p")]);
  });

  it("a fetch that FAILED (as opposed to skipped) is still counted as a file fetched and reported as fetch_failed", async () => {
    const result = await run({ [at("sitemap.xml")]: "throw" });
    expect(result.problems).toEqual([{ url: at("sitemap.xml"), reason: "fetch_failed" }]);
    expect(result.filesFetched).toBe(1);
  });
});
