import { describe, expect, it } from "vitest";
import { siteFileFindingSchema } from "../../../contracts/aux/index.js";
import {
  AI_CRAWLER_AGENTS,
  SITE_FILE_THRESHOLDS,
  evaluateLlmsTxt,
  evaluateRobotsTxt,
  evaluateSitemap,
  type SiteFile,
} from "./site-files.js";

// NEW-C-8 (STORY-051 subset) — AUX-R-001, 002, 003, 004, 007. Pure evaluators:
// the bodies go in, findings come out. Every rule here is threshold logic, so
// each carries a test at, below and above its boundary.

const ok = (body: string): SiteFile => ({ status: 200, body });
const codes = (findings: readonly { rule_code: string }[]): string[] => findings.map((f) => f.rule_code);
const NOW = new Date("2026-10-07T00:00:00Z");
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("NEW-C-8 AC1 · AUX-R-001 AI crawler Disallow", () => {
  it("NEW-C-8 AC1.1 · root `Disallow: /` on GPTBot is critical", () => {
    const f = evaluateRobotsTxt(ok("User-agent: GPTBot\nDisallow: /\n"), ["/pricing"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule_code: "AUX-R-001", severity: "critical", measured_value: 1, threshold_value: 1 });
    expect(f[0]!.evidence).toMatchObject({ file: "robots.txt", reason: "root_disallow", line: 2, subjects: ["GPTBot"] });
    expect(f[0]!.evidence.snippet).toBe("Disallow: /");
  });

  it("NEW-C-8 AC1.2 · a path Disallow covering a tracked path is high", () => {
    const f = evaluateRobotsTxt(ok("User-agent: ClaudeBot\nDisallow: /pricing\n"), ["/pricing/plans", "/blog"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule_code: "AUX-R-001", severity: "high" });
    expect(f[0]!.evidence.reason).toBe("path_disallow");
  });

  it("NEW-C-8 AC1.3 · just below: a Disallow that covers NO tracked path does not fire", () => {
    expect(evaluateRobotsTxt(ok("User-agent: GPTBot\nDisallow: /private\n"), ["/pricing", "/blog"])).toEqual([]);
  });

  it("NEW-C-8 AC1.4 · an empty `Disallow:` allows everything and does not fire", () => {
    expect(evaluateRobotsTxt(ok("User-agent: GPTBot\nDisallow:\n"), ["/"])).toEqual([]);
  });

  it("NEW-C-8 AC1.5 · a longer Allow beats a shorter Disallow; a tie goes to Allow", () => {
    expect(evaluateRobotsTxt(ok("User-agent: GPTBot\nDisallow: /\nAllow: /pricing\n"), ["/pricing"])).toEqual([]);
    expect(evaluateRobotsTxt(ok("User-agent: GPTBot\nDisallow: /\nAllow: /\n"), ["/"])).toEqual([]);
  });

  it("NEW-C-8 AC1.6 · agent names and directives match case-insensitively; every listed agent is recognised", () => {
    expect(AI_CRAWLER_AGENTS).toEqual([
      "GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Applebot-Extended", "Bytespider", "CCBot", "meta-externalagent",
    ]);
    for (const agent of AI_CRAWLER_AGENTS) {
      const f = evaluateRobotsTxt(ok(`user-agent: ${agent.toLowerCase()}\ndisallow: /\n`), ["/"]);
      expect(codes(f)).toEqual(["AUX-R-001"]);
    }
  });

  it("NEW-C-8 AC1.7 · wildcards and `$` in a Disallow pattern are honoured", () => {
    expect(codes(evaluateRobotsTxt(ok("User-agent: CCBot\nDisallow: /*/plans$\n"), ["/pro/plans"]))).toEqual(["AUX-R-001"]);
    expect(evaluateRobotsTxt(ok("User-agent: CCBot\nDisallow: /*/plans$\n"), ["/pro/plans/x"])).toEqual([]);
  });

  it("NEW-C-8 AC1.8 · a group naming several agents applies to each; severity is the worst across agents", () => {
    const f = evaluateRobotsTxt(ok("User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n"), ["/"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "critical", measured_value: 2 });
    expect(f[0]!.evidence.subjects).toEqual(["GPTBot", "CCBot"]);
  });
});

describe("NEW-C-8 AC1 · AUX-R-002 wildcard-only allowance", () => {
  it("NEW-C-8 AC1.9 · `*` restricts a tracked path and no named AI agent appears is medium", () => {
    const f = evaluateRobotsTxt(ok("User-agent: *\nDisallow: /\n"), ["/pricing"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule_code: "AUX-R-002", severity: "medium" });
  });

  it("NEW-C-8 AC1.10 · a named AI agent present (even allowed) suppresses AUX-R-002", () => {
    const f = evaluateRobotsTxt(ok("User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n"), ["/pricing"]);
    expect(f).toEqual([]);
  });

  it("NEW-C-8 AC1.11 · a `*` rule that touches no tracked path is not restrictive", () => {
    expect(evaluateRobotsTxt(ok("User-agent: *\nDisallow: /admin\n"), ["/pricing"])).toEqual([]);
  });

  it("NEW-C-8 AC1.12 · no `*` group at all does not fire", () => {
    expect(evaluateRobotsTxt(ok("User-agent: Googlebot\nDisallow: /\n"), ["/"])).toEqual([]);
  });
});

describe("NEW-C-8 AC1 · AUX-R-003 robots.txt unreachable or malformed", () => {
  it("NEW-C-8 AC1.13 · a 4xx and a 5xx are high, measured as the status", () => {
    for (const status of [404, 403, 500, 503]) {
      const f = evaluateRobotsTxt({ status, body: "" }, ["/"]);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ rule_code: "AUX-R-003", severity: "high", measured_value: status });
      expect(f[0]!.evidence.reason).toBe("http_status");
    }
  });

  it("NEW-C-8 AC1.14 · 399 and 200 are not an HTTP failure", () => {
    expect(evaluateRobotsTxt({ status: 200, body: "User-agent: *\nDisallow:\n" }, ["/"])).toEqual([]);
  });

  it("NEW-C-8 AC1.15 · no response at all (null) is unreachable, measured null not 0", () => {
    const f = evaluateRobotsTxt(null, ["/"]);
    expect(f[0]).toMatchObject({ rule_code: "AUX-R-003", measured_value: null });
    expect(f[0]!.evidence.reason).toBe("unreachable");
  });

  it("NEW-C-8 AC1.16 · size boundary: exactly 500 KiB is fine, one byte more fires", () => {
    const max = SITE_FILE_THRESHOLDS.robotsMaxBytes;
    expect(max).toBe(500 * 1024);
    const pad = (n: number): string => "#" + "x".repeat(n - 1);
    expect(evaluateRobotsTxt(ok(pad(max)), ["/"])).toEqual([]);
    const f = evaluateRobotsTxt(ok(pad(max + 1)), ["/"]);
    expect(f[0]).toMatchObject({ rule_code: "AUX-R-003", severity: "high", measured_value: max + 1, threshold_value: max });
    expect(f[0]!.evidence.reason).toBe("oversize");
  });

  it("NEW-C-8 AC1.17 · an explicit byteLength (a truncated fetch) overrides the body length", () => {
    const f = evaluateRobotsTxt({ status: 200, body: "User-agent: *\nDisallow:\n", byteLength: 600_000 }, ["/"]);
    expect(f[0]).toMatchObject({ rule_code: "AUX-R-003", measured_value: 600_000 });
  });

  it("NEW-C-8 AC1.18 · one unparseable directive fires; zero does not; comments and blanks are fine", () => {
    expect(evaluateRobotsTxt(ok("# hi\n\nUser-agent: *\nDisallow: # nothing\n"), ["/"])).toEqual([]);
    const f = evaluateRobotsTxt(ok("User-agent: *\nthis is not a directive\nDisallow:\n"), ["/"]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule_code: "AUX-R-003", severity: "high", measured_value: 1, threshold_value: 1 });
    expect(f[0]!.evidence).toMatchObject({ reason: "unparseable_directive", line: 2, snippet: "this is not a directive" });
  });

  it("NEW-C-8 AC1.19 · measured counts every unparseable line; the snippet is bounded", () => {
    const long = "x".repeat(500);
    const f = evaluateRobotsTxt(ok(`User-agent: *\n${long}\nbad two\n: novalue-name\n`), ["/"]);
    expect(f[0]!.measured_value).toBe(3);
    expect(f[0]!.evidence.snippet!.length).toBeLessThanOrEqual(200);
  });

  it("NEW-C-8 AC1.20 · an HTTP failure does not also parse the (error page) body for AUX-R-001/002", () => {
    const f = evaluateRobotsTxt({ status: 404, body: "User-agent: GPTBot\nDisallow: /\n" }, ["/"]);
    expect(codes(f)).toEqual(["AUX-R-003"]);
  });

  it("NEW-C-8 AC1.21 · an empty 200 body is valid and fires nothing", () => {
    expect(evaluateRobotsTxt(ok(""), ["/"])).toEqual([]);
  });

  it("NEW-C-8 AC1.22 · a malformed file still has its parseable rules evaluated", () => {
    const f = evaluateRobotsTxt(ok("User-agent: GPTBot\nDisallow: /\ngarbage\n"), ["/"]);
    expect(codes(f).sort()).toEqual(["AUX-R-001", "AUX-R-003"]);
  });
});

describe("NEW-C-8 AC1 · AUX-R-004 llms.txt absent versus invalid", () => {
  const valid = "# Acme\n\n> Acme makes anvils.\n\n## Docs\n\n- [Pricing](https://acme.test/pricing): plans\n";

  it("NEW-C-8 AC1.23 · absent (both locations missing or non-2xx) is low", () => {
    for (const [a, b] of [[null, null], [{ status: 404, body: "" }, { status: 404, body: "" }]] as const) {
      const f = evaluateLlmsTxt(a, b);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ rule_code: "AUX-R-004", severity: "low" });
      expect(f[0]!.evidence.reason).toBe("absent");
    }
  });

  it("NEW-C-8 AC1.24 · a valid root file, or a valid well-known file alone, fires nothing", () => {
    expect(evaluateLlmsTxt(ok(valid), null)).toEqual([]);
    expect(evaluateLlmsTxt({ status: 404, body: "" }, ok(valid))).toEqual([]);
  });

  it("NEW-C-8 AC1.25 · invalid is medium: no H1, an empty body, HTML, or a link-less list item", () => {
    for (const body of ["Just some words\n", "   \n", "<html><body>nope</body></html>", "# Acme\n\n## Docs\n\n- not a link\n"]) {
      const f = evaluateLlmsTxt(ok(body), null);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ rule_code: "AUX-R-004", severity: "medium" });
      expect(f[0]!.evidence.reason).toBe("invalid");
    }
  });

  it("NEW-C-8 AC1.26 · when the root file is invalid but the well-known file is valid, the root file is judged (it wins)", () => {
    expect(codes(evaluateLlmsTxt(ok("nope"), ok(valid)))).toEqual(["AUX-R-004"]);
  });

  it("NEW-C-8 AC1.27 · a bare H1 is the smallest valid file", () => {
    expect(evaluateLlmsTxt(ok("# Acme\n"), null)).toEqual([]);
  });
});

describe("NEW-C-8 AC1 · AUX-R-007 sitemap absent or stale", () => {
  const sitemap = (ages: readonly (number | null)[]): string =>
    `<?xml version="1.0"?><urlset>${ages
      .map((a, i) => `<url><loc>https://acme.test/p${i}</loc>${a === null ? "" : `<lastmod>${daysAgo(a)}</lastmod>`}</url>`)
      .join("")}</urlset>`;
  const ctx = { now: NOW, declaredInRobots: false };

  it("NEW-C-8 AC1.28 · absent (null or non-2xx) is medium", () => {
    for (const file of [null, { status: 500, body: "" }]) {
      const f = evaluateSitemap(file, ctx);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ rule_code: "AUX-R-007", severity: "medium" });
      expect(f[0]!.evidence.reason).toBe("absent");
    }
  });

  it("NEW-C-8 AC1.29 · a sitemap declared in robots.txt that 404s is its own reason", () => {
    const f = evaluateSitemap({ status: 404, body: "" }, { now: NOW, declaredInRobots: true });
    expect(f[0]).toMatchObject({ rule_code: "AUX-R-007", severity: "medium", measured_value: 404 });
    expect(f[0]!.evidence.reason).toBe("declared_sitemap_404");
  });

  it("NEW-C-8 AC1.30 · a declared sitemap that is absent via null (no response) is absent, not 404", () => {
    expect(evaluateSitemap(null, { now: NOW, declaredInRobots: true })[0]!.evidence.reason).toBe("absent");
  });

  it("NEW-C-8 AC1.31 · staleness boundary: exactly 50% stale does NOT fire; over 50% does", () => {
    expect(evaluateSitemap(ok(sitemap([365, 365, 1, 1])), ctx)).toEqual([]);
    const f = evaluateSitemap(ok(sitemap([365, 365, 365, 1, 1])), ctx);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule_code: "AUX-R-007", severity: "medium", measured_value: 0.6, threshold_value: 0.5 });
    expect(f[0]!.evidence.reason).toBe("stale_lastmod");
  });

  it("NEW-C-8 AC1.32 · age boundary: exactly 180 days is not stale; 181 is", () => {
    expect(evaluateSitemap(ok(sitemap([180, 180])), ctx)).toEqual([]);
    expect(codes(evaluateSitemap(ok(sitemap([181, 181])), ctx))).toEqual(["AUX-R-007"]);
  });

  it("NEW-C-8 AC1.33 · entries with no (or unparseable) lastmod count in the denominator but are not stale", () => {
    expect(evaluateSitemap(ok(sitemap([365, null, null])), ctx)).toEqual([]);
    expect(codes(evaluateSitemap(ok(sitemap([365, 365, null])), ctx))).toEqual(["AUX-R-007"]);
    const bad = `<urlset><url><loc>a</loc><lastmod>not-a-date</lastmod></url></urlset>`;
    expect(evaluateSitemap(ok(bad), ctx)).toEqual([]);
  });

  it("NEW-C-8 AC1.34 · a date-only lastmod is read; a sitemap index's <sitemap> entries count too", () => {
    const d = NOW.getTime() - 400 * 86_400_000;
    const date = new Date(d).toISOString().slice(0, 10);
    const index = `<sitemapindex><sitemap><loc>x</loc><lastmod>${date}</lastmod></sitemap></sitemapindex>`;
    expect(codes(evaluateSitemap(ok(index), ctx))).toEqual(["AUX-R-007"]);
  });

  it("NEW-C-8 AC1.35 · an empty urlset measured nothing, so it fires nothing", () => {
    expect(evaluateSitemap(ok("<urlset></urlset>"), ctx)).toEqual([]);
  });

  it("NEW-C-8 AC1.36 · the threshold constants are the specified ones", () => {
    expect(SITE_FILE_THRESHOLDS).toMatchObject({ robotsMaxBytes: 512_000, sitemapStaleDays: 180, sitemapStaleRatio: 0.5 });
  });
});

describe("NEW-C-8 AC2 · findings are contract-valid and the evaluators are pure", () => {
  it("NEW-C-8 AC2.1 · every finding parses against the strict contract", () => {
    const all = [
      ...evaluateRobotsTxt(ok("User-agent: GPTBot\nDisallow: /\nbad\n"), ["/"]),
      ...evaluateRobotsTxt(null, ["/"]),
      ...evaluateLlmsTxt(null, null),
      ...evaluateSitemap(null, { now: NOW, declaredInRobots: false }),
    ];
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const f of all) expect(siteFileFindingSchema.safeParse(f).success).toBe(true);
    expect(siteFileFindingSchema.safeParse({ ...all[0], extra: 1 }).success).toBe(false);
  });

  it("NEW-C-8 AC2.2 · the module imports no network or clock facility", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./site-files.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/node:(http|https|net|dns)|\bfetch\(|guarded-fetch|Date\.now\(|new Date\(\)/);
  });

  it("NEW-C-8 AC2.3 · same input, same output (deterministic)", () => {
    const body = ok("User-agent: GPTBot\nDisallow: /pricing\n");
    expect(evaluateRobotsTxt(body, ["/pricing"])).toEqual(evaluateRobotsTxt(body, ["/pricing"]));
  });
});
