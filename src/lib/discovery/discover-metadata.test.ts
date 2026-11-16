import { describe, expect, it, vi } from "vitest";
import { discover, type DiscoverDeps } from "./discover.js";
import { CrawlRefusal } from "../net/crawl-gate.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { LOW_CONFIDENCE_THRESHOLD } from "../../../contracts/projects/index.js";

vi.mock("../telemetry/metrics.js", () => ({ observeValue: vi.fn(), incrementCounter: vi.fn() }));

// STORY-043 AC10 - the section 2.1 "Metadata" row: CMS/stack, robots.txt state, sitemap size (locale was already derived). Each with a value, a
// confidence, a source and an edited flag, and every fetch of robots.txt and the sitemap through the crawl gate (decisions 70(d) / 106(g)), never
// the bare guarded fetcher.

const WORDPRESS_PAGE = `<html lang="en"><head><title>Acme</title><meta name="generator" content="WordPress 6.5"></head><body></body></html>`;
const PLAIN_PAGE = `<html lang="en"><head><title>Acme</title></head><body></body></html>`;
const urlset = (n: number) => `<?xml version="1.0"?><urlset>${Array.from({ length: n }, (_, i) => `<url><loc>https://acme.com/p${String(i)}</loc></url>`).join("")}</urlset>`;
const BASE = { rootUrl: "https://acme.com", rootDomain: "acme.com", fieldsSupplied: [] as string[] };

type Answer = { status: number; body?: string } | "throw" | "refuse";

function deps(html: string, files: Record<string, Answer>): { deps: DiscoverDeps; gated: ReturnType<typeof vi.fn>; direct: ReturnType<typeof vi.fn> } {
  let t = 1000;
  const direct = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(html), finalUrl: "https://acme.com/" }));
  const gated = vi.fn(async (url: string) => {
    const answer = files[new URL(url).pathname] ?? { status: 404 };
    if (answer === "throw") throw new Error("boom");
    if (answer === "refuse") throw new CrawlRefusal("robots_unavailable");
    return { status: answer.status, headers: {}, body: Buffer.from(answer.body ?? ""), finalUrl: url, redirectChain: [] };
  });
  return { deps: { fetch: direct as never, gatedFetch: gated as never, now: () => (t += 100) }, gated, direct };
}

describe("STORY-043 AC10 · CMS", () => {
  it("AC10 names the platform a page declares, with confidence, source and an unedited flag", async () => {
    const { deps: d } = deps(WORDPRESS_PAGE, {});
    const { fields } = await discover(BASE, d);
    expect(fields.cms).toEqual({ value: "wordpress", confidence: 0.95, source: "generator meta tag", user_edited: false });
  });

  it("AC10 no marker found is 'custom' at a confidence below the review line (flagged, not asserted)", async () => {
    const { deps: d } = deps(PLAIN_PAGE, {});
    const result = await discover(BASE, d);
    expect(result.fields.cms?.value).toBe("custom");
    expect(result.fields.cms!.confidence).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
    expect(result.low_confidence_fields).toContain("cms");
  });

  it("AC10 an unreadable page derives no CMS at all (nothing to read is not 'custom')", async () => {
    const { deps: d } = deps(PLAIN_PAGE, {});
    const result = await discover(BASE, { ...d, fetch: (async () => ({ status: 503, headers: {}, body: Buffer.from(""), finalUrl: "" })) as never });
    expect(result.fields.cms).toBeUndefined();
  });
});

describe("STORY-043 AC10 · robots.txt state", () => {
  it("AC10 GPTBot allowed: read from the file through the gate, confidence 1", async () => {
    const { deps: d, gated, direct } = deps(PLAIN_PAGE, { "/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private\n" } });
    const { fields } = await discover(BASE, d);
    expect(fields.robots_state).toEqual({ value: "gptbot_allowed", confidence: 1, source: "robots.txt", user_edited: false });
    expect(gated.mock.calls.map((c) => c[0])).toContain("https://acme.com/robots.txt");
    expect(direct.mock.calls.map((c) => c[0])).not.toContain("https://acme.com/robots.txt"); // never the bare fetcher
  });

  it("AC10 GPTBot disallowed outright", async () => {
    const { deps: d } = deps(PLAIN_PAGE, { "/robots.txt": { status: 200, body: "User-agent: GPTBot\nDisallow: /\n" } });
    expect((await discover(BASE, d)).fields.robots_state?.value).toBe("gptbot_blocked");
  });

  it("AC10 no robots.txt (404) is its own state, at confidence 1", async () => {
    const { deps: d } = deps(PLAIN_PAGE, { "/robots.txt": { status: 404 } });
    expect((await discover(BASE, d)).fields.robots_state).toMatchObject({ value: "no_robots_txt", confidence: 1 });
  });

  it("AC10 a robots.txt that cannot be read (5xx, error, refusal) derives nothing rather than guessing", async () => {
    for (const answer of [{ status: 503 }, "throw", "refuse"] as const) {
      const { deps: d } = deps(PLAIN_PAGE, { "/robots.txt": answer });
      expect((await discover(BASE, d)).fields.robots_state, String(answer)).toBeUndefined();
    }
  });
});

describe("STORY-043 AC10 · sitemap size", () => {
  it("AC10 counts the URLs in the sitemap the robots.txt declares", async () => {
    const { deps: d, gated } = deps(PLAIN_PAGE, {
      "/robots.txt": { status: 200, body: "Sitemap: https://acme.com/map.xml\n" },
      "/map.xml": { status: 200, body: urlset(7) },
    });
    const { fields } = await discover(BASE, d);
    expect(fields.sitemap_urls).toEqual({ value: 7, confidence: 1, source: "sitemap", user_edited: false });
    expect(gated.mock.calls.map((c) => c[0])).toContain("https://acme.com/map.xml");
  });

  it("AC10 falls back to /sitemap.xml when robots.txt declares none", async () => {
    const { deps: d } = deps(PLAIN_PAGE, { "/robots.txt": { status: 200, body: "User-agent: *\n" }, "/sitemap.xml": { status: 200, body: urlset(3) } });
    expect((await discover(BASE, d)).fields.sitemap_urls?.value).toBe(3);
  });

  it("AC10 an empty sitemap is 0, and a 0 stays a 0", async () => {
    const { deps: d } = deps(PLAIN_PAGE, { "/sitemap.xml": { status: 200, body: urlset(0) } });
    expect((await discover(BASE, d)).fields.sitemap_urls).toMatchObject({ value: 0, confidence: 1 });
  });

  it("AC10 no sitemap anywhere (404) is 0 at a lower confidence, not an absent field", async () => {
    const { deps: d } = deps(PLAIN_PAGE, {});
    const field = (await discover(BASE, d)).fields.sitemap_urls;
    expect(field?.value).toBe(0);
    expect(field?.source).toBe("no sitemap found");
    expect(field!.confidence).toBeLessThan(1);
  });

  it("AC10 a sitemap that cannot be read (5xx / error) is absent: unknown is not 0", async () => {
    for (const answer of [{ status: 503 }, "throw"] as const) {
      const { deps: d } = deps(PLAIN_PAGE, { "/sitemap.xml": answer });
      expect((await discover(BASE, d)).fields.sitemap_urls, String(answer)).toBeUndefined();
    }
  });

  it("AC10 an index larger than the discovery file budget is a lower bound, said so in the source and below full confidence", async () => {
    const index = `<sitemapindex>${Array.from({ length: 8 }, (_, i) => `<sitemap><loc>https://acme.com/s${String(i)}.xml</loc></sitemap>`).join("")}</sitemapindex>`;
    const files: Record<string, Answer> = { "/sitemap.xml": { status: 200, body: index } };
    for (let i = 0; i < 8; i++) files[`/s${String(i)}.xml`] = { status: 200, body: urlset(10) };
    const { deps: d, gated } = deps(PLAIN_PAGE, files);
    const field = (await discover(BASE, d)).fields.sitemap_urls;
    expect(field?.source).toBe("sitemap (partial read)");
    expect(field!.confidence).toBeLessThan(1);
    expect(Number(field!.value)).toBeGreaterThan(0);
    // robots.txt + the index + at most the budgeted children, not all 8
    expect(gated.mock.calls.length).toBeLessThanOrEqual(1 + 5 + 1);
  });
});

describe("STORY-043 AC10 · discipline", () => {
  it("AC10 a metadata failure never fails or downgrades the pass: the document's fields stand and the status is completed", async () => {
    const { deps: d } = deps(WORDPRESS_PAGE, { "/robots.txt": "throw", "/sitemap.xml": "throw" });
    const result = await discover(BASE, d);
    expect(result.discovery_status).toBe("completed");
    expect(result.fields.cms?.value).toBe("wordpress");
  });

  it("AC10 without a crawl gate injected, robots.txt and the sitemap are not read at all (and the bare fetcher is not used for them)", async () => {
    const direct = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(PLAIN_PAGE), finalUrl: "https://acme.com/" }));
    const result = await discover(BASE, { fetch: direct as never, now: () => 1, gatedFetch: undefined });
    expect(result.fields.robots_state).toBeUndefined();
    expect(result.fields.sitemap_urls).toBeUndefined();
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it("AC10 each metadata field is skipped when a person decided it (supplied wins)", async () => {
    const { deps: d, gated } = deps(WORDPRESS_PAGE, { "/robots.txt": { status: 200, body: "" } });
    const result = await discover({ ...BASE, fieldsSupplied: ["cms", "robots_state", "sitemap_urls"] }, d);
    expect(result.fields.cms).toBeUndefined();
    expect(result.fields.robots_state).toBeUndefined();
    expect(result.fields.sitemap_urls).toBeUndefined();
    expect(gated).not.toHaveBeenCalled();
  });
});

describe("STORY-043 AC10 · observability", () => {
  it("AC10 counts each site-file field by outcome, and the counter carries no URL or file text", async () => {
    vi.mocked(incrementCounter).mockClear();
    const { deps: d } = deps(PLAIN_PAGE, { "/robots.txt": { status: 503 }, "/sitemap.xml": { status: 200, body: urlset(2) } });
    await discover(BASE, d);
    const calls = vi.mocked(incrementCounter).mock.calls.filter((c) => c[0] === "nominara_discovery_site_file_fields_total");
    expect(calls).toEqual([
      ["nominara_discovery_site_file_fields_total", { field: "robots_state", outcome: "not_derived" }],
      ["nominara_discovery_site_file_fields_total", { field: "sitemap_urls", outcome: "derived" }],
    ]);
  });
});
