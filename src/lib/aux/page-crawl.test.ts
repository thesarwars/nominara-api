import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { GuardedFetchRefusal, type GuardedResponse } from "../net/guarded-fetch.js";
import { crawlPages, NOMINARA_USER_AGENT, type PageCrawlDeps } from "./page-crawl.js";
import { PolitenessBudget } from "./politeness.js";
import { parseRobots } from "./robots.js";
import { RendererUnavailable, unavailableRenderer, type Renderer } from "./renderer.js";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

interface Harness {
  deps: PageCrawlDeps;
  budget: PolitenessBudget;
  fetched: { url: string; headers: Record<string, string>; truncateAtCap: boolean | undefined; followRedirect: ((next: string) => boolean) | undefined }[];
  stored: Map<string, Buffer>;
  sleeps: number[];
  rendered: string[];
}

function harness(
  opts: {
    pages?: Record<string, { status: number; body?: string; truncated?: boolean; finalUrl?: string } | "refuse" | "throw">;
    renderer?: Renderer;
    hardCap?: number;
    robots?: PageCrawlDeps["robots"];
    store?: PageCrawlDeps["store"];
    renderTimeoutMs?: number;
    crawlDelaySeconds?: number;
    wallClockBudgetMs?: number;
  } = {},
): Harness {
  let clock = 0;
  const sleeps: number[] = [];
  const budget = new PolitenessBudget({
    hardCap: opts.hardCap ?? 100,
    crawlDelaySeconds: opts.crawlDelaySeconds ?? null,
    ...(opts.wallClockBudgetMs === undefined ? {} : { wallClockBudgetMs: opts.wallClockBudgetMs }),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  const fetched: Harness["fetched"] = [];
  const stored = new Map<string, Buffer>();
  const rendered: string[] = [];
  const renderer: Renderer =
    opts.renderer ??
    ({
      render: async (url) => {
        rendered.push(url);
        return { html: `<html>rendered ${url}</html>`, finalUrl: url, status: 200 };
      },
    } satisfies Renderer);
  const deps: PageCrawlDeps = {
    rootUrl: "https://acme.com/",
    budget,
    robots: opts.robots ?? null,
    renderer,
    renderTimeoutMs: opts.renderTimeoutMs ?? 1000,
    fetch: async (url, init) => {
      fetched.push({ url, headers: { ...init.headers }, truncateAtCap: init.truncateAtCap, followRedirect: init.followRedirect });
      const hit = (opts.pages ?? {})[new URL(url).pathname] ?? { status: 200, body: `<html>raw ${url}</html>` };
      if (hit === "refuse") throw new GuardedFetchRefusal("address_not_global");
      if (hit === "throw") throw new Error("connect ECONNREFUSED 10.0.0.5:443");
      return { status: hit.status, headers: {}, body: Buffer.from(hit.body ?? ""), finalUrl: hit.finalUrl ?? url, truncated: hit.truncated ?? false } satisfies GuardedResponse;
    },
    store: opts.store ?? (async (relative, body) => {
      stored.set(relative, body);
      return `crawl/test/ws/${relative}`;
    }),
    keyPrefix: "audit-1",
  };
  return { deps, budget, fetched, stored, sleeps, rendered };
}

describe("STORY-049 · crawlPages", () => {
  it("scenario 7 · a page is fetched twice, plain and rendered, and BOTH are stored gzipped with their hashes", async () => {
    const h = harness();
    const { pages } = await crawlPages(["https://acme.com/a"], h.deps);
    expect(pages).toHaveLength(1);
    const p = pages[0]!;
    expect(p.outcome).toBe("ok");
    expect(p.raw && p.rendered).toBeTruthy();
    const keys = [...h.stored.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.endsWith(".raw.html.gz"))).toBe(true);
    expect(keys.some((k) => k.endsWith(".rendered.html.gz"))).toBe(true);
    const rawKey = keys.find((k) => k.endsWith(".raw.html.gz"))!;
    const renderedKey = keys.find((k) => k.endsWith(".rendered.html.gz"))!;
    expect(gunzipSync(h.stored.get(rawKey)!).toString()).toBe("<html>raw https://acme.com/a</html>");
    expect(gunzipSync(h.stored.get(renderedKey)!).toString()).toBe("<html>rendered https://acme.com/a</html>");
    expect(p.raw?.sha256).toBe(sha("<html>raw https://acme.com/a</html>"));
    expect(p.rendered?.sha256).toBe(sha("<html>rendered https://acme.com/a</html>"));
    expect(p.raw?.object_key).toBe(`crawl/test/ws/${rawKey}`);
  });

  it("AC6/AC7 · the plain fetch identifies itself as NominaraBot and asks to truncate rather than throw at the cap", async () => {
    const h = harness();
    await crawlPages(["https://acme.com/a"], h.deps);
    expect(NOMINARA_USER_AGENT).toBe("NominaraBot/1.0 (+https://nominara.com/bot)");
    expect(h.fetched[0]!.headers["user-agent"]).toBe(NOMINARA_USER_AGENT);
    expect(h.fetched[0]!.truncateAtCap).toBe(true);
  });

  it("scenario 5 · an oversized body is stored truncated and the cut is RECORDED on the page", async () => {
    const h = harness({ pages: { "/big": { status: 200, body: "x".repeat(10), truncated: true } } });
    const { pages } = await crawlPages(["https://acme.com/big"], h.deps);
    expect(pages[0]!.raw?.truncated).toBe(true);
    expect(pages[0]!.rendered?.truncated).toBe(false);
  });

  it("scenario 8 · both fetches of a page are charged to the one budget, spaced by the interval", async () => {
    const h = harness();
    await crawlPages(["https://acme.com/a", "https://acme.com/b"], h.deps);
    expect(h.budget.usedBy("page")).toBe(4);
    expect(h.sleeps).toEqual([500, 500, 500]);
  });

  it("scenario 8 · a declared Crawl-delay is honoured between page requests", async () => {
    const h = harness({ crawlDelaySeconds: 2 });
    await crawlPages(["https://acme.com/a"], h.deps);
    expect(h.sleeps).toEqual([2000]);
  });

  it("scenario 11 · a page returning an error is recorded as failed with its reason, and the crawl CONTINUES", async () => {
    const h = harness({ pages: { "/broken": { status: 500 } } });
    const { pages } = await crawlPages(["https://acme.com/broken", "https://acme.com/fine"], h.deps);
    expect(pages[0]).toMatchObject({ url: "https://acme.com/broken", outcome: "failed", failures: [{ stage: "raw", reason: "http_500", http_status: 500 }] });
    expect(pages[1]!.outcome).toBe("ok");
    expect(h.stored.size).toBe(2); // only the good page's two copies; an error page's body is not evidence
    expect(h.rendered).toEqual(["https://acme.com/fine"]); // and a page that failed plain is not rendered
  });

  it("scenario 11 · a guard refusal is recorded by the check that refused it, never the address, and the crawl continues", async () => {
    const h = harness({ pages: { "/internal": "refuse" } });
    const { pages } = await crawlPages(["https://acme.com/internal", "https://acme.com/fine"], h.deps);
    expect(pages[0]!.failures[0]).toMatchObject({ stage: "raw", reason: "unsafe_target:address_not_global" });
    expect(pages[1]!.outcome).toBe("ok");
  });

  it("a network error is recorded as fetch_failed and the error text (which can carry an address) is never kept", async () => {
    const h = harness({ pages: { "/down": "throw" } });
    const { pages } = await crawlPages(["https://acme.com/down"], h.deps);
    expect(pages[0]!.failures[0]).toMatchObject({ stage: "raw", reason: "fetch_failed", http_status: null });
    expect(JSON.stringify(pages)).not.toContain("10.0.0.5");
  });

  it("AC7 · a page the target's robots.txt disallows for NominaraBot is skipped: not fetched, not charged to the budget", async () => {
    const h = harness({ robots: parseRobots("User-agent: NominaraBot\nDisallow: /private\n") });
    const { pages } = await crawlPages(["https://acme.com/private/x", "https://acme.com/ok"], h.deps);
    expect(pages[0]).toMatchObject({ outcome: "skipped", skipped_reason: "robots_disallowed" });
    expect(h.fetched.map((f) => f.url)).toEqual(["https://acme.com/ok"]);
    expect(h.budget.usedBy("page")).toBe(2);
  });

  it("AC7 · a robots.txt that could not be fetched means NO page is crawled (RFC 9309: assume disallow), each recorded as skipped", async () => {
    const h = harness({ robots: "unavailable" });
    const { pages } = await crawlPages(["https://acme.com/a", "https://acme.com/b"], h.deps);
    expect(pages.map((p) => [p.outcome, p.skipped_reason])).toEqual([["skipped", "robots_unavailable"], ["skipped", "robots_unavailable"]]);
    expect(h.fetched).toHaveLength(0);
  });

  it("AC7 · the hard cap stops the crawl: remaining pages are recorded as skipped, and nothing is fetched past it", async () => {
    const h = harness({ hardCap: 3 }); // page 1 raw + rendered = 2, page 2 raw = 3, page 2 rendered refused
    const { pages, stoppedAtCap } = await crawlPages(["https://acme.com/1", "https://acme.com/2", "https://acme.com/3"], h.deps);
    expect(stoppedAtCap).toBe(true);
    expect(pages[0]!.outcome).toBe("ok");
    expect(pages[1]).toMatchObject({ outcome: "partial", failures: [{ stage: "rendered", reason: "page_cap_reached" }] });
    expect(pages[2]).toMatchObject({ outcome: "skipped", skipped_reason: "page_cap_reached" });
    expect(h.fetched).toHaveLength(2);
    expect(h.budget.used).toBe(3);
  });

  it("a page that redirects off the verified site is a failure and NOTHING of the other site is stored", async () => {
    const h = harness({ pages: { "/away": { status: 200, body: "rival", finalUrl: "https://rival.com/" } } });
    const { pages } = await crawlPages(["https://acme.com/away"], h.deps);
    expect(pages[0]).toMatchObject({ outcome: "failed", failures: [{ stage: "raw", reason: "redirected_off_site" }] });
    expect(h.stored.size).toBe(0);
  });

  it("AC6 · with no renderer, the plain copy is kept and the page is PARTIAL: renderer_unavailable, never an empty rendered copy", async () => {
    const h = harness({ renderer: { render: () => Promise.reject(new RendererUnavailable()) } });
    const { pages } = await crawlPages(["https://acme.com/a"], h.deps);
    expect(pages[0]).toMatchObject({ outcome: "partial", failures: [{ stage: "rendered", reason: "renderer_unavailable" }] });
    expect(pages[0]!.raw).toBeTruthy();
    expect(pages[0]!.rendered).toBeUndefined();
    expect([...h.stored.keys()]).toHaveLength(1);
  });

  // Review round 2 — a renderer known to be unavailable must not be charged to the politeness budget: the request is
  // never sent, but an interval slot (up to the declared Crawl-delay) and a hard-cap unit were spent on it.
  it("with the unavailable renderer a page costs ONE budget request (the plain fetch), and the renderer is never called", async () => {
    const h = harness({ renderer: unavailableRenderer });
    const { pages } = await crawlPages(["https://acme.com/a", "https://acme.com/b", "https://acme.com/c"], h.deps);
    expect(h.deps.budget.usedBy("page")).toBe(3);
    for (const page of pages) {
      expect(page).toMatchObject({ outcome: "partial", failures: [{ stage: "rendered", reason: "renderer_unavailable" }] });
    }
  });

  it("with the unavailable renderer no interval is slept for the render that never happens", async () => {
    const h = harness({ renderer: unavailableRenderer, crawlDelaySeconds: 10 });
    await crawlPages(["https://acme.com/a", "https://acme.com/b"], h.deps);
    // one wait between the two plain fetches, none for a render
    expect(h.sleeps).toHaveLength(1);
  });

  it("a renderer that IS installed still costs two requests per page", async () => {
    const h = harness();
    await crawlPages(["https://acme.com/a"], h.deps);
    expect(h.deps.budget.usedBy("page")).toBe(2);
  });

  it("a renderer that hangs is cut at the render timeout and recorded as render_timeout", async () => {
    const h = harness({ renderer: { render: () => new Promise(() => undefined) }, renderTimeoutMs: 20 });
    const { pages } = await crawlPages(["https://acme.com/a"], h.deps);
    expect(pages[0]!.failures[0]).toMatchObject({ stage: "rendered", reason: "render_timeout" });
  });

  it("AC10 · the renderer is handed a request guard bound to THIS page: a foreign request is refused through it", async () => {
    let decision: unknown;
    const h = harness({
      renderer: {
        render: async (url, guard) => {
          decision = await guard("https://tracker.example.net/p.js");
          return { html: "<html/>", finalUrl: url, status: 200 };
        },
      },
    });
    await crawlPages(["https://acme.com/a"], h.deps);
    expect(decision).toEqual({ allow: false, reason: "foreign_site" });
  });

  it("a storage failure is recorded against the page (stage store) and the crawl continues", async () => {
    let calls = 0;
    const h = harness({
      store: async (relative) => {
        calls += 1;
        if (calls <= 2) throw new Error("storage down");
        return `crawl/test/ws/${relative}`;
      },
    });
    const { pages } = await crawlPages(["https://acme.com/a", "https://acme.com/b"], h.deps);
    expect(pages[0]).toMatchObject({ outcome: "failed" });
    expect(pages[0]!.failures.map((f) => [f.stage, f.reason])).toEqual([["store", "storage_unavailable"], ["store", "storage_unavailable"]]);
    expect(pages[1]!.outcome).toBe("ok");
  });

  it("a recorded URL carries no control characters (it reaches a jsonb column)", async () => {
    const h = harness({ pages: { "/x": { status: 404 } } });
    const { pages } = await crawlPages(["https://acme.com/x\u0000"], h.deps);
    expect(pages[0]!.url.includes("\u0000")).toBe(false);
  });

  it("no pages selected is an empty crawl, not an error", async () => {
    const h = harness();
    expect(await crawlPages([], h.deps)).toEqual({ pages: [], stoppedAtCap: false, stoppedAtDeadline: false });
  });

  // REVIEW FINDINGS — robots.txt was checked only against the URL as SELECTED, and redirects went anywhere public first.
  it("a page that redirects into a path robots.txt disallows is discarded: not stored, not rendered, recorded", async () => {
    const h = harness({
      robots: parseRobots("User-agent: *\nDisallow: /private\n"),
      pages: { "/a": { status: 200, body: "<html>secret</html>", finalUrl: "https://acme.com/private/x" } },
    });
    const { pages } = await crawlPages(["https://acme.com/a"], h.deps);
    expect(pages[0]).toMatchObject({ outcome: "failed", failures: [{ stage: "raw", reason: "robots_disallowed_after_redirect", http_status: 200 }] });
    expect(pages[0]!.raw).toBeUndefined();
    expect(h.stored.size).toBe(0);
    expect(h.rendered).toEqual([]);
  });

  it("a redirect that lands on an ALLOWED path of the same site is kept", async () => {
    const h = harness({
      robots: parseRobots("User-agent: *\nDisallow: /private\n"),
      pages: { "/a": { status: 200, finalUrl: "https://acme.com/public/x" } },
    });
    const { pages } = await crawlPages(["https://acme.com/a"], h.deps);
    expect(pages[0]!.outcome).toBe("ok");
  });

  it("each redirect hop is vetted BEFORE it is requested: off-site and robots-disallowed hops are vetoed, an allowed same-site hop is not", async () => {
    const h = harness({ robots: parseRobots("User-agent: *\nDisallow: /private\n") });
    await crawlPages(["https://acme.com/a"], h.deps);
    const follow = h.fetched[0]!.followRedirect!;
    expect(follow).toBeTypeOf("function");
    expect(follow("https://acme.com/elsewhere")).toBe(true);
    expect(follow("https://www.acme.com/elsewhere")).toBe(true);
    expect(follow("https://third-party.example/x")).toBe(false);
    expect(follow("https://acme.com/private/x")).toBe(false);
  });

  it("a redirect the guard did not follow is recorded as such, not as a page", async () => {
    const h = harness({ pages: { "/a": { status: 302, body: "" } } });
    const { pages } = await crawlPages(["https://acme.com/a"], h.deps);
    expect(pages[0]).toMatchObject({ outcome: "failed", failures: [{ stage: "raw", reason: "redirect_not_followed", http_status: 302 }] });
  });

  it("a crawl that runs out of wall-clock budget skips the rest as crawl_delay_budget, finishing in bounded virtual time", async () => {
    const h = harness({ crawlDelaySeconds: 10, wallClockBudgetMs: 25_000 });
    const urls = Array.from({ length: 10 }, (_, i) => `https://acme.com/p${String(i)}`);
    const result = await crawlPages(urls, h.deps);
    expect(result.stoppedAtDeadline).toBe(true);
    expect(result.stoppedAtCap).toBe(false);
    // t = 0, 10 s, 20 s: three requests, i.e. one page (raw + rendered) and the raw fetch of the next
    expect(h.budget.used).toBe(3);
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(25_000);
    expect(result.pages.filter((p) => p.outcome === "skipped").every((p) => p.skipped_reason === "crawl_delay_budget")).toBe(true);
    expect(result.pages).toHaveLength(10);
  });

  it("a hostile Crawl-delay is honoured, not clamped: one request goes out, nothing is slept, and every other page is recorded as skipped", async () => {
    const h = harness({ crawlDelaySeconds: 1e9, wallClockBudgetMs: 25_000 });
    const urls = Array.from({ length: 10 }, (_, i) => `https://acme.com/p${String(i)}`);
    const result = await crawlPages(urls, h.deps);
    expect(result.stoppedAtDeadline).toBe(true);
    expect(h.budget.used).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(result.pages).toHaveLength(10);
    expect(result.pages.filter((p) => p.outcome === "skipped").every((p) => p.skipped_reason === "crawl_delay_budget")).toBe(true);
  });
});
