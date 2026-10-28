import { describe, expect, it } from "vitest";
import { auxErrorSummarySchema, crawlManifestSchema } from "./crawl-manifest.schema.js";

const failure = { stage: "raw", reason: "http_500", http_status: 500 };

describe("STORY-049 AC12 · aux_audits.error_summary (jsonb)", () => {
  it("records a crawl that the Crawl-delay or wall-clock budget limited, and the partial pages separately from the failed ones", () => {
    const parsed = auxErrorSummarySchema.parse({ crawl_delay_limited: { crawl_delay_ms: 10_000, pages_skipped: 4 }, pages_partial: 3 });
    expect(parsed.crawl_delay_limited).toEqual({ crawl_delay_ms: 10_000, pages_skipped: 4 });
    expect(parsed.crawl_delay_limited).not.toHaveProperty("declared_crawl_delay_ms"); // absent = the declared delay was honoured as declared
    expect(parsed.pages_partial).toBe(3);
    expect(auxErrorSummarySchema.safeParse({ crawl_delay_limited: { crawl_delay_ms: 10_000 } }).success).toBe(false);
  });

  it("review r5 · a capped Crawl-delay states the DECLARED delay beside the honoured one, so a reader can see it was shortened", () => {
    const parsed = auxErrorSummarySchema.parse({ crawl_delay_limited: { crawl_delay_ms: 60_000, declared_crawl_delay_ms: 86_400_000, pages_skipped: 2 } });
    expect(parsed.crawl_delay_limited?.declared_crawl_delay_ms).toBe(86_400_000);
    expect(auxErrorSummarySchema.safeParse({ crawl_delay_limited: { crawl_delay_ms: 60_000, declared_crawl_delay_ms: -1, pages_skipped: 0 } }).success).toBe(false);
    expect(auxErrorSummarySchema.safeParse({ crawl_delay_limited: { crawl_delay_ms: 60_000, declared_crawl_delay_ms: 1.5, pages_skipped: 0 } }).success).toBe(false);
  });

  it("accepts the all-unreachable shape the site-file stage already writes", () => {
    expect(auxErrorSummarySchema.parse({ reason: "all_site_files_unreachable" })).toEqual({ reason: "all_site_files_unreachable" });
  });

  it("accepts per-page failures with a reason, and a null status for a failure with no HTTP response", () => {
    const parsed = auxErrorSummarySchema.parse({
      failed_pages: [{ url: "https://acme.com/a", failures: [failure, { stage: "rendered", reason: "render_timeout", http_status: null }] }],
      skipped_pages: [{ url: "https://acme.com/b", reason: "robots_disallowed" }],
      pages_over_cap: 3,
      stopped_at_cap: false,
      site_files_failed: ["robots.txt"],
    });
    expect(parsed.failed_pages?.[0]?.failures[1]?.http_status).toBeNull();
  });

  it("keeps 0 distinct from absent: pages_over_cap 0 survives a round trip", () => {
    expect(auxErrorSummarySchema.parse({ pages_over_cap: 0 }).pages_over_cap).toBe(0);
    expect(auxErrorSummarySchema.parse({}).pages_over_cap).toBeUndefined();
  });

  it("manifest_stored is only ever written as false", () => {
    expect(auxErrorSummarySchema.parse({ manifest_stored: false }).manifest_stored).toBe(false);
    expect(auxErrorSummarySchema.safeParse({ manifest_stored: true }).success).toBe(false);
  });

  it("refuses an unknown key, an unknown stage, and a failure with no reason", () => {
    expect(auxErrorSummarySchema.safeParse({ stack: "..." }).success).toBe(false);
    expect(auxErrorSummarySchema.safeParse({ failed_pages: [{ url: "u", failures: [{ stage: "dns", reason: "x", http_status: null }] }] }).success).toBe(false);
    expect(auxErrorSummarySchema.safeParse({ failed_pages: [{ url: "u", failures: [{ stage: "raw", http_status: 500 }] }] }).success).toBe(false);
  });
});

describe("STORY-049 AC6 · the crawl manifest under dom_object_prefix", () => {
  const copy = { object_key: "crawl/test/ws/a/x.raw.html.gz", sha256: "a".repeat(64), bytes: 10, status: 200, truncated: false };
  const manifest = {
    version: 1,
    audit_id: "0190b1c0-0000-7000-8000-000000000002",
    scope: "public_surface",
    root_url: "https://acme.com/",
    pages: [{ url: "https://acme.com/", outcome: "ok", raw: copy, rendered: { ...copy, object_key: "crawl/test/ws/a/x.rendered.html.gz" }, failures: [] }],
    pages_over_cap: 0,
    stopped_at_cap: false,
    selection_skipped: [],
    sitemap: { files_fetched: 1, total_seen: 2, sampled: false, problems: [] },
    ai_bot_access: null,
  };

  it("round-trips a manifest, with ai_bot_access null when robots.txt could not be judged (not 'allowed')", () => {
    expect(crawlManifestSchema.parse(manifest).ai_bot_access).toBeNull();
  });

  it("review r5 · carries the robots.txt verdict per AI crawler token, and a real false (disallowed) stays false", () => {
    const parsed = crawlManifestSchema.parse({
      ...manifest,
      ai_bot_access: [{ agent: "GPTBot", allowed: false }, { agent: "ClaudeBot", allowed: true }],
    });
    expect(parsed.ai_bot_access?.map((a) => a.allowed)).toEqual([false, true]);
  });

  it("review r5 · the differential probe is gone: a manifest carrying a probe result is refused (no spoofed-agent request exists to record)", () => {
    expect(crawlManifestSchema.safeParse({ ...manifest, probe: { outcome: "consistent", browser_status: 200, agent_status: 200 } }).success).toBe(false);
  });

  it("review r5 · an ai_bot_access entry with an unknown key or a non-boolean verdict is refused", () => {
    expect(crawlManifestSchema.safeParse({ ...manifest, ai_bot_access: [{ agent: "GPTBot", allowed: "no" }] }).success).toBe(false);
    expect(crawlManifestSchema.safeParse({ ...manifest, ai_bot_access: [{ agent: "GPTBot", allowed: true, status: 200 }] }).success).toBe(false);
  });

  it("refuses a sha256 that is not 64 hex characters, and an unknown key", () => {
    expect(crawlManifestSchema.safeParse({ ...manifest, pages: [{ ...manifest.pages[0], raw: { ...copy, sha256: "zz" } }] }).success).toBe(false);
    expect(crawlManifestSchema.safeParse({ ...manifest, extra: 1 }).success).toBe(false);
  });
});

describe("STORY-050 AC7 / AC8 / AC10 · the fetch record a page's snapshot is rebuilt from", () => {
  const manifest = (page: Record<string, unknown>) => ({
    version: 1,
    audit_id: "0197a0a0-0000-7000-8000-000000000001",
    scope: "key_pages",
    root_url: "https://acme.com/",
    pages: [{ url: "https://acme.com/a", outcome: "ok", failures: [], ...page }],
    pages_over_cap: 0,
    stopped_at_cap: false,
    selection_skipped: [],
    sitemap: null,
    ai_bot_access: null,
  });
  const fetchRecord = { final_url: "https://acme.com/b", redirect_chain: ["https://acme.com/a"], http_status: 200, headers: { "x-robots-tag": "nosnippet" }, ttfb_ms: 0, load_ms: 12 };

  it("a page records its final URL, redirect chain, status, the headers the model reads, and timing", () => {
    const parsed = crawlManifestSchema.parse(manifest({ fetch: fetchRecord }));
    expect(parsed.pages[0]?.fetch).toEqual(fetchRecord);
  });

  it("a measured 0 stays 0 and an unmeasured timing is null, never 0", () => {
    expect(crawlManifestSchema.parse(manifest({ fetch: fetchRecord })).pages[0]?.fetch?.ttfb_ms).toBe(0);
    expect(crawlManifestSchema.parse(manifest({ fetch: { ...fetchRecord, ttfb_ms: null, load_ms: null } })).pages[0]?.fetch?.load_ms).toBeNull();
  });

  it("a manifest written before the record existed still parses (no fetch)", () => {
    expect(crawlManifestSchema.safeParse(manifest({})).success).toBe(true);
  });

  it("refuses an unknown key and a negative timing", () => {
    expect(crawlManifestSchema.safeParse(manifest({ fetch: { ...fetchRecord, cookies: "x" } })).success).toBe(false);
    expect(crawlManifestSchema.safeParse(manifest({ fetch: { ...fetchRecord, ttfb_ms: -1 } })).success).toBe(false);
  });
});
