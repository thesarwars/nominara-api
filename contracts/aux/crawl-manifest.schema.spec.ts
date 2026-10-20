import { describe, expect, it } from "vitest";
import { auxErrorSummarySchema, crawlManifestSchema } from "./crawl-manifest.schema.js";

const failure = { stage: "raw", reason: "http_500", http_status: 500 };

describe("STORY-049 AC12 · aux_audits.error_summary (jsonb)", () => {
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
    probe: null,
  };

  it("round-trips a manifest, with the probe null when it did not run (not 'consistent')", () => {
    expect(crawlManifestSchema.parse(manifest).probe).toBeNull();
  });

  it("carries a probe result with null statuses for a request that got no response", () => {
    const parsed = crawlManifestSchema.parse({ ...manifest, probe: { outcome: "inconclusive", browserStatus: 200, agentStatus: null } });
    expect(parsed.probe?.agentStatus).toBeNull();
  });

  it("refuses a sha256 that is not 64 hex characters, and an unknown key", () => {
    expect(crawlManifestSchema.safeParse({ ...manifest, pages: [{ ...manifest.pages[0], raw: { ...copy, sha256: "zz" } }] }).success).toBe(false);
    expect(crawlManifestSchema.safeParse({ ...manifest, extra: 1 }).success).toBe(false);
  });
});
