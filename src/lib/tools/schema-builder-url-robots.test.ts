import { describe, expect, it, vi } from "vitest";
import { CATALOG_ROWS } from "../../../test/support/aux-rules.js";
import { createCrawlGate } from "../net/crawl-gate.js";
import type { GuardedFetchInit, GuardedResponse } from "../net/guarded-fetch.js";
import type { ToolCatalogRow } from "./aux-audit-run.js";
import { checkUrlStructuredData } from "./schema-builder-url-check.js";

vi.mock("../net/crawl-gate.js", async (importOriginal) => ({ ...(await importOriginal<object>()), crawlGatedFetch: vi.fn() }));

// Owner decisions 70(d) and 105(c): every fetch that identifies as NominaraBot reads the target's robots.txt and keeps the per-host budget. Schema Builder URL mode
// identifies as NominaraBot, so it goes through the crawl gate; a path the site disallows is not fetched.
const CATALOG: readonly ToolCatalogRow[] = CATALOG_ROWS.map((r) => ({ code: r.code, category: r.category, title: r.title, weight: r.weight, rule_version: r.ruleVersion, thresholds: r.thresholds, task_threshold: r.taskThreshold, auto_fixable: r.autoFixable, rationale: r.rationale }));
const page = (url: string, body: string, type = "text/html"): GuardedResponse => ({ status: 200, headers: { "content-type": type }, body: Buffer.from(body), finalUrl: url, redirectChain: [], truncated: false, ttfbMs: 1, loadMs: 1 });

describe("Schema Builder URL mode · decision 70(d) robots gate", () => {
  it("the DEFAULT fetch is the robots-gated one", async () => {
    const { crawlGatedFetch } = await import("../net/crawl-gate.js");
    vi.mocked(crawlGatedFetch).mockResolvedValue(page("https://default.example/p", "<html><head></head><body>x</body></html>"));
    const out = await checkUrlStructuredData({ url: "https://default.example/p", catalog: CATALOG });
    expect(out.kind).toBe("checked");
    expect(crawlGatedFetch).toHaveBeenCalledTimes(1);
  });

  it("a path robots.txt disallows is NOT fetched, and the run reads as refused, never as a clean page", async () => {
    const requested: string[] = [];
    const inner = async (url: string, _init?: GuardedFetchInit): Promise<GuardedResponse> => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return page(url, "User-agent: *\nDisallow: /private/", "text/plain");
      return page(url, "<html><body>secret</body></html>");
    };
    const out = await checkUrlStructuredData({ url: "https://blocked.example/private/page", catalog: CATALOG }, { fetch: createCrawlGate({ fetch: inner }) });
    expect(out).toEqual({ kind: "unreachable", reason: "refused" });
    expect(requested).toEqual(["https://blocked.example/robots.txt"]);
  });

  it("a robots.txt that cannot be read fails closed: the page is not fetched", async () => {
    const requested: string[] = [];
    const inner = async (url: string): Promise<GuardedResponse> => {
      requested.push(url);
      return { ...page(url, ""), status: 503 };
    };
    const out = await checkUrlStructuredData({ url: "https://down.example/p", catalog: CATALOG }, { fetch: createCrawlGate({ fetch: inner }) });
    expect(out).toEqual({ kind: "unreachable", reason: "refused" });
    expect(requested).toEqual(["https://down.example/robots.txt"]);
  });
});
