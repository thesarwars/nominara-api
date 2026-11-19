import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOG } from "../../../test/support/aux-rules.js";
import { parseArgs, runCli, urlPathOf, UsageError } from "./static-audit-cli.js";
import { runStaticAudit, StaticAuditError, type StaticAuditInput } from "./static-audit.js";

// STORY-102 AC10 / decision 68(j) - the AUX audit over a directory of built static HTML. Fixture HTML only: no network, no database.

const BASE = "https://example.com";
const GOOD = `<!doctype html><html lang="en"><head><title>Acme Widgets</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme","url":"https://example.com","logo":"https://example.com/l.png","sameAs":["https://x.com/acme"],"description":"Widgets","dateModified":"2026-10-01"}</script>
</head><body><main><h1>Acme</h1><p>Acme makes widgets for teams. They ship fast.</p><table><tr><td>a</td></tr></table></main></body></html>`;
const BROKEN_JSONLD = GOOD.replace('"Acme","url"', '"Acme" "url"');
const ROBOTS_OK = "User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n";
const LLMS_OK = "# Acme\n\n- [Home](https://example.com/)\n";
const SITEMAP_OK = `<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc><lastmod>2026-11-01</lastmod></url></urlset>`;
const NOW = new Date("2026-11-19T00:00:00Z");

const input = (over: Partial<StaticAuditInput> = {}): StaticAuditInput => ({
  pages: [{ path: "/", html: GOOD }],
  siteFiles: { robots: ROBOTS_OK, llms: LLMS_OK, llmsWellKnown: null, sitemap: SITEMAP_OK },
  baseUrl: BASE,
  now: NOW,
  catalog: CATALOG,
  ...over,
});

describe("STORY-102 AC10 - runStaticAudit", () => {
  it("a clean site scores 100 with no findings, and says it is partial (some rules cannot be decided from files)", async () => {
    const report = await runStaticAudit(input());
    expect(report.findings).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.partial).toBe(true);
    expect(report.score_capped).toBe(false);
  });

  it("a rule the engine finds a defect with appears as a finding with its page URL, and costs score", async () => {
    const report = await runStaticAudit(input({ pages: [{ path: "/", html: GOOD }, { path: "/pricing/", html: BROKEN_JSONLD }] }));
    const hit = report.findings.find((f) => f.rule_code === "AUX-R-008");
    expect(hit).toBeDefined();
    expect(hit!.url).toBe("https://example.com/pricing/");
    expect(report.score).toBeLessThan(100);
    expect(report.pages_audited).toBe(2);
  });

  it("rules that need rendering, a response, or inputs no directory holds are NOT EVALUATED - listed with a reason, never passed, never a finding", async () => {
    const report = await runStaticAudit(input());
    const reasons = new Map(report.rules_not_evaluated.map((r) => [r.rule_code, r.reason]));
    for (const code of ["AUX-R-026", "AUX-R-027", "AUX-R-029", "AUX-R-005", "AUX-R-028", "AUX-R-031", "AUX-R-032", "AUX-R-033", "AUX-R-034"]) {
      expect(reasons.has(code), code).toBe(true);
      expect(reasons.get(code)!.length).toBeGreaterThan(10);
      expect(report.rules_evaluated).not.toContain(code);
      expect(report.findings.some((f) => f.rule_code === code)).toBe(false);
    }
    expect(reasons.get("AUX-R-026")).toMatch(/rendered/i);
    expect(reasons.get("AUX-R-029")).toMatch(/response/i);
  });

  it("the five site-file rules and the document-model rules are all evaluated", async () => {
    const report = await runStaticAudit(input());
    for (const code of ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007", "AUX-R-006", "AUX-R-008"]) expect(report.rules_evaluated).toContain(code);
    expect(report.limitations.join(" ")).toMatch(/header/i);
  });

  it("every catalog rule is exactly one of evaluated or not evaluated", async () => {
    const report = await runStaticAudit(input());
    const all = new Set(CATALOG.rules.map((r) => r.code));
    const evaluated = new Set(report.rules_evaluated);
    const not = new Set(report.rules_not_evaluated.map((r) => r.rule_code));
    for (const code of all) expect(evaluated.has(code) !== not.has(code), code).toBe(true);
    expect(report.rules_evaluated.length + report.rules_not_evaluated.length).toBe(all.size);
  });

  it("a robots.txt that blocks an AI crawler from the whole site is a critical AUX-R-001 and the score is capped at 72", async () => {
    const report = await runStaticAudit(input({ siteFiles: { robots: "User-agent: GPTBot\nDisallow: /\n", llms: LLMS_OK, llmsWellKnown: null, sitemap: SITEMAP_OK } }));
    expect(report.findings.some((f) => f.rule_code === "AUX-R-001" && f.severity === "critical")).toBe(true);
    expect(report.score_capped).toBe(true);
    expect(report.score).toBeLessThanOrEqual(72);
  });

  it("a site file the directory does not hold is judged as the deployed site would answer: 404 (a robots.txt finding, an absent sitemap)", async () => {
    const report = await runStaticAudit(input({ siteFiles: { robots: null, llms: null, llmsWellKnown: null, sitemap: null } }));
    expect(report.site_files).toEqual({ "robots.txt": "absent", "llms.txt": "absent", "sitemap.xml": "absent" });
    expect(report.findings.some((f) => f.rule_code === "AUX-R-003" && f.reason === "http_status")).toBe(true);
    expect(report.findings.some((f) => f.rule_code === "AUX-R-007" && f.reason === "absent")).toBe(true);
    expect(report.findings.some((f) => f.rule_code === "AUX-R-004" && f.reason === "absent")).toBe(true);
    expect(report.score).toBeLessThan(100);
  });

  it("is deterministic: the same files give the same report twice", async () => {
    const pages = [{ path: "/", html: GOOD }, { path: "/a/", html: BROKEN_JSONLD }];
    expect(JSON.stringify(await runStaticAudit(input({ pages })))).toBe(JSON.stringify(await runStaticAudit(input({ pages }))));
  });

  it("a measured zero is not a missing measurement: the findings' measured_value keeps null and 0 apart", async () => {
    const report = await runStaticAudit(input({ siteFiles: { robots: ROBOTS_OK, llms: null, llmsWellKnown: null, sitemap: SITEMAP_OK } }));
    // llms.txt was asked for (a 404 is an answer): measured 0 of 1, not null.
    const llms = report.findings.find((f) => f.rule_code === "AUX-R-004")!;
    expect(llms.measured_value).toBe(0);
    expect(llms.threshold_value).toBe(1);
  });

  it("refuses an audit of nothing: no pages is an error, never a score", async () => {
    await expect(runStaticAudit(input({ pages: [] }))).rejects.toBeInstanceOf(StaticAuditError);
  });
});

describe("STORY-102 AC10 - the command line", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aux-static-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function site(files: Record<string, string>): Promise<void> {
    for (const [name, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), body);
    }
  }
  const CLEAN = { "index.html": GOOD, "robots.txt": ROBOTS_OK, "llms.txt": LLMS_OK, "sitemap.xml": SITEMAP_OK };

  it("prints one JSON document and exits 0 when no minimum is given", async () => {
    await site(CLEAN);
    const result = await runCli([dir, "--base-url", BASE], NOW);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as { score: number; passed: boolean | null; min_score: number | null; pages_audited: number };
    expect(report.score).toBe(100);
    expect(report.passed).toBeNull();
    expect(report.min_score).toBeNull();
    expect(report.pages_audited).toBe(1);
    expect(result.stderr).toBe("");
  });

  it("exits 0 at or above --min-score and 1 below it (the boundary is inclusive)", async () => {
    await site(CLEAN);
    expect((await runCli([dir, "--min-score", "100", "--base-url", BASE], NOW)).exitCode).toBe(0);
    await site({ "pricing/index.html": BROKEN_JSONLD });
    const below = await runCli([dir, "--min-score=100", "--base-url", BASE], NOW);
    expect(below.exitCode).toBe(1);
    const report = JSON.parse(below.stdout) as { passed: boolean; score: number; findings: Array<{ rule_code: string; url: string }> };
    expect(report.passed).toBe(false);
    expect(report.findings.some((f) => f.rule_code === "AUX-R-008" && f.url === "https://example.com/pricing/")).toBe(true);
    expect((await runCli([dir, "--min-score", String(report.score), "--base-url", BASE], NOW)).exitCode).toBe(0);
  });

  it("exits 2 with a JSON error on stderr and nothing on stdout when it cannot audit: missing directory, no HTML, bad arguments", async () => {
    const missing = await runCli([join(dir, "nope")], NOW);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toBe("");
    expect(JSON.parse(missing.stderr)).toHaveProperty("error");

    expect((await runCli([dir], NOW)).exitCode).toBe(2);
    expect((await runCli([], NOW)).exitCode).toBe(2);
    expect((await runCli([dir, "--min-score", "abc"], NOW)).exitCode).toBe(2);
    expect((await runCli([dir, "--min-score", "101"], NOW)).exitCode).toBe(2);
    expect((await runCli([dir, "--nope"], NOW)).exitCode).toBe(2);
  });

  it("serves index.html as its directory, skips the host's 404 page, and never follows a symbolic link", async () => {
    await site({ ...CLEAN, "about/index.html": GOOD, "docs/page.html": GOOD, "404.html": BROKEN_JSONLD });
    const outside = await mkdtemp(join(tmpdir(), "aux-static-outside-"));
    try {
      await writeFile(join(outside, "secret.html"), BROKEN_JSONLD);
      await symlink(join(outside, "secret.html"), join(dir, "linked.html"));
      const result = await runCli([dir, "--base-url", BASE], NOW);
      const report = JSON.parse(result.stdout) as { pages_audited: number; target: { pages_skipped: Array<{ file: string; reason: string }> }; findings: Array<{ url: string }> };
      expect(report.pages_audited).toBe(3);
      expect(report.target.pages_skipped).toEqual(expect.arrayContaining([{ file: "404.html", reason: "error_page" }, { file: "linked.html", reason: "symlink" }]));
      expect(report.findings.some((f) => f.url.includes("secret") || f.url.includes("linked") || f.url.includes("404"))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("urlPathOf and parseArgs", () => {
    expect(urlPathOf("index.html")).toBe("/");
    expect(urlPathOf("about/index.html")).toBe("/about/");
    expect(urlPathOf("docs/page.html")).toBe("/docs/page.html");
    expect(parseArgs(["out", "--min-score=90"])).toEqual({ dir: "out", minScore: 90, baseUrl: "https://site.invalid" });
    expect(() => parseArgs(["a", "b"])).toThrow(UsageError);
    expect(() => parseArgs(["a", "--base-url", "ftp://x"])).toThrow(UsageError);
  });

  it("the real invocation (pnpm --silent aux:audit-static): stdout is ONLY the JSON report, the exit code follows --min-score", async () => {
    await site({ ...CLEAN, "pricing/index.html": BROKEN_JSONLD });
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const run = (min: string) =>
      spawnSync("pnpm", ["--silent", "aux:audit-static", dir, "--min-score", min, "--base-url", BASE], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } });
    const below = run("100");
    expect(below.status, below.stderr).toBe(1);
    // The WHOLE of stdout parses as one JSON document: no pnpm banner (--silent), no metric or log line from the engine.
    expect((JSON.parse(below.stdout) as { passed: boolean }).passed).toBe(false);
    expect(below.stdout).not.toMatch(/"metric"/);
    const ok = run("0");
    expect(ok.status, ok.stderr).toBe(0);
    expect((JSON.parse(ok.stdout) as { passed: boolean }).passed).toBe(true);
  }, 120_000);
});
