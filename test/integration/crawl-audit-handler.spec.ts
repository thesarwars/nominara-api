import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import { Client, Pool } from "pg";
import type { ClientBase } from "pg";
import type { Job } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { TenantObjectStore } from "../../src/lib/storage/tenant-object-store.js";
import type { ObjectStoragePort } from "../../src/lib/storage/storage.port.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { gunzipSync } from "node:zlib";
import { createCrawlAuditHandler, type CrawlAuditDeps } from "../../src/lib/queue/handlers/crawl-audit.handler.js";
import { NOMINARA_USER_AGENT } from "../../src/lib/aux/page-crawl.js";
import { unavailableRenderer } from "../../src/lib/aux/renderer.js";
import { cl100kTokenizer } from "../../src/lib/aux/tokenizer-cl100k.js";
import { tokenizerLabel } from "../../src/lib/aux/tokenizer.js";
import { createHash } from "node:crypto";
import { crawlManifestSchema, type AuxFinding, type AuxPatch } from "../../contracts/aux/index.js";
import { AuxService } from "../../src/modules/aux/aux.service.js";
import { handlerFor } from "../../src/lib/queue/handlers.js";
import { phasesOf } from "../../src/lib/queue/worker-factory.js";
import type { GuardedFetchInit, GuardedResponse } from "../../src/lib/net/guarded-fetch.js";

// NEW-C-9 — the crawl.audit handler, site-file stage, against a real Postgres.
// The handler is handed a plain client as `tx` (as withTenantJob would hand it
// one already inside the tenant context); the fetcher is injected, so no
// network is touched.

const counters: { name: string; labels: Record<string, string> }[] = [];
vi.mock("../../src/lib/telemetry/metrics.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/telemetry/metrics.js")>("../../src/lib/telemetry/metrics.js");
  return {
    ...actual,
    incrementCounter: (name: string, labels: Record<string, string> = {}) => {
      counters.push({ name, labels });
      actual.incrementCounter(name, labels);
    },
  };
});

type Served = Record<string, { status: number; body?: string; location?: string } | "throw" | "hang">;

const BLOCKED = "User-agent: GPTBot\nDisallow: /\n";
const OPEN = "User-agent: *\nAllow: /\nSitemap: https://acme.com/sitemap.xml\n";
const LLMS = "# Acme\n- [Docs](https://acme.com/docs)\n";
const SITEMAP = `<urlset><url><loc>https://acme.com/</loc><lastmod>2026-10-01</lastmod></url></urlset>`;
// STORY-051 AC13: pages are now judged by the page rules, so a "healthy" site needs a page no rule fires on. (The old fixture,
// `<html><body>home</body></html>`, has no title, no structured data and no heading, and rightly draws findings.)
const LD = JSON.stringify([
  { "@context": "https://schema.org", "@type": "Organization", name: "Acme", url: "https://acme.com", logo: "https://acme.com/logo.png", sameAs: ["https://www.linkedin.com/company/acme"], description: "Acme makes widgets." },
  { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Acme Widgets", featureList: ["Pipeline analytics", "Workflow automation"], offers: { "@type": "Offer", price: "47.00", priceCurrency: "USD" }, aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: "120" }, dateModified: "2026-10-01" },
]);
const pageWith = (extraHead: string): string =>
  `<!doctype html><html lang="en"><head><title>Acme Widgets</title><meta name="description" content="Acme Widgets pipeline analytics."><link rel="canonical" href="https://acme.com/"><meta property="article:modified_time" content="2026-10-01"><script type="application/ld+json">${LD}</script>${extraHead}</head><body><main><h1>Acme Widgets</h1><p>Acme Widgets starts at $47 per month. Rated 4.6/5 from 120 reviews.</p><h2>Pipeline analytics</h2><p>See every deal.</p><h2>Workflow automation</h2><p>Automate follow-ups.</p><p>Last updated: 2026-10-01</p></main></body></html>`;
const HEALTHY_PAGE = pageWith("");
// A second JSON-LD block that is not JSON: AUX-R-008, critical, in structured_data - and nothing else fires, because the first block is sound.
const BROKEN_PAGE = pageWith('<script type="application/ld+json">{ "@context": "https://schema.org", "@type": }</script>');
const healthy = (robots: string): Served => ({
  "/": { status: 200, body: HEALTHY_PAGE },
  "/robots.txt": { status: 200, body: robots },
  "/llms.txt": { status: 200, body: LLMS },
  "/.well-known/llms.txt": { status: 404, body: "" },
  "/sitemap.xml": { status: 200, body: SITEMAP },
});

// What the crawl stored (relative key -> bytes) and what it asked the renderer for. Reset per test.
const stored = new Map<string, Buffer>();
const rendered: string[] = [];
const sleeps: number[] = [];
let clockMs = 0;
const requestedUas: { url: string; ua: string | undefined }[] = [];

function depsServing(served: Served, requested: string[] = [], timeoutMs = 10_000, extra: Partial<CrawlAuditDeps> = {}): CrawlAuditDeps {
  return {
    now: () => new Date("2026-10-07T00:00:00Z"),
    // A virtual clock the politeness budget reads, advanced by the sleeps it asks for: no real waiting, and the spacing is exact.
    nowMs: () => clockMs,
    sleep: async (ms: number) => { sleeps.push(ms); clockMs += ms; },
    timeoutMs,
    // The renderer returns what the site serves for that path (a page that renders to itself): STORY-051 AC13 judges the rendered copy against the
    // plain one, and a stub that renders to something else would make every "healthy" site look like a client-side-rendered one.
    renderer: { render: async (url) => { rendered.push(url); const hit = served[new URL(url).pathname]; const html = hit === undefined || hit === "throw" || hit === "hang" ? `<html>rendered ${url}</html>` : (hit.body ?? ""); return { html, finalUrl: url, status: 200 }; } },
    store: async (relative, body) => { stored.set(relative, body); return `crawl/test/ws/${relative}`; },
    ...extra,
    // Behaves like guardedFetch for redirects: a 3xx is followed (and the next request recorded) unless the caller's
    // `followRedirect` refuses it, in which case the 3xx itself is returned.
    fetch: async function stub(url: string, init?: GuardedFetchInit): Promise<GuardedResponse> {
      requested.push(url);
      requestedUas.push({ url, ua: init?.headers?.["user-agent"] });
      const hit = served[new URL(url).pathname];
      if (hit === undefined || hit === "throw") throw new Error("connection refused");
      if (hit === "hang") return new Promise<GuardedResponse>(() => undefined);
      if (hit.location !== undefined) {
        const next = new URL(hit.location, url).toString();
        if (init?.followRedirect === undefined || init.followRedirect(next)) return stub(next, init);
      }
      return { status: hit.status, headers: hit.location === undefined ? {} : { location: hit.location }, body: Buffer.from(hit.body ?? ""), finalUrl: url };
    },
  };
}

describe("NEW-C-9 · crawl.audit handler (site-file stage)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);
  afterAll(async () => { await db.end(); await container.stop(); });

  beforeEach(async () => {
    counters.length = 0;
    stored.clear();
    rendered.length = 0;
    sleeps.length = 0;
    clockMs = 0;
    requestedUas.length = 0;
    await db.query("TRUNCATE workspaces CASCADE");
    workspaceId = (await db.query("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W','w-c9','free') RETURNING id")).rows[0].id;
    projectId = (await db.query(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1,'P','p-c9','https://acme.com','acme.com') RETURNING id",
      [workspaceId],
    )).rows[0].id;
  });

  const verifyDomain = async (): Promise<void> => {
    await db.query(
      `INSERT INTO domain_verifications (id, workspace_id, project_id, domain, method, nonce, verified_at, last_checked_at)
       VALUES ($1,$2,$3,'acme.com','dns_txt','nonce-c9',now(),now())`,
      [randomUUID(), workspaceId, projectId],
    );
  };
  const job = (over: Record<string, unknown> = {}): Job =>
    ({ data: { payload: { projectId, auditId: randomUUID(), trigger: "onboarding", workspaceId, kid: "k1", ...over } } }) as unknown as Job;
  const run = async (j: Job, deps: CrawlAuditDeps): Promise<void> => {
    await createCrawlAuditHandler({ pool: {} as never, env: {} as never }, deps)(db as never, j);
  };
  // Rows are asserted by column name; a per-column interface would restate the schema.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  // OWNER DECISIONS 52 and 55: a category's max_penalty is the sum of the DECIDED rules' weights. These are worked by hand from the catalog (0070 and 0148), NOT read
  // back from the audit's own `excluded_rules`, so a wrongly excluded rule cannot make the expectation agree with the bug.
  //   crawler_access: 001 .30 + 002 .08 + 003 .12 + 004 .06 + 005 .24 + 006 .12 + 007 .08 = 1.00; 005 is never decided; 006 is a page rule
  //   structured_data: 008 .14 + 009 .10 + 010 .12 + 011 .07 + 012 .09 + 013 .11 + 014 .09 + 015 .06 + 016 .06 + 017 .08 + 018 .08 = 1.00; 013 runs again since STORY-187 (the hold is released), so structured_data is fully decided
  //   render_mode: 026 .34 + 027 .28 + 028 .22 + 029 .16 = 1.00
  const DECIDED = {
    crawlerAccessWithPages: 0.76, // 001 .30 + 002 .08 + 003 .12 + 004 .06 + 006 .12 + 007 .08
    crawlerAccessSiteFilesOnly: 0.64, // the same without the page rule 006
    structuredData: 1.0, // every rule decided: 013 is evaluated again (STORY-187)
    renderMode029Only: 0.16, // 026, 027 and 028 undecided with no renderer
  } as const;
  const audits = async (): Promise<any[]> => (await db.query("SELECT * FROM aux_audits ORDER BY created_at")).rows;
  const findings = async (): Promise<any[]> => (await db.query("SELECT * FROM aux_findings ORDER BY created_at")).rows;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it("review r3 · a site file or sitemap that redirects OFF the verified site is never requested from the third party", async () => {
    const requested: string[] = [];
    const served: Served = {
      ...healthy(OPEN),
      "/robots.txt": { status: 302, location: "https://thirdparty.example/stolen-robots.txt" },
      "/llms.txt": { status: 302, location: "https://thirdparty.example/stolen-llms.txt" },
      "/sitemap.xml": { status: 302, location: "https://thirdparty.example/stolen-sitemap.xml" },
      "/stolen-robots.txt": { status: 200, body: OPEN },
      "/stolen-llms.txt": { status: 200, body: LLMS },
      "/stolen-sitemap.xml": { status: 200, body: SITEMAP },
    };
    await run(job(), depsServing(served, requested));
    expect(requested.filter((u) => !u.startsWith("https://acme.com/"))).toEqual([]);
  });

  it("NEW-C-9 AC1.1 · is registered as the crawl.audit handler", () => {
    expect(handlerFor("crawl.audit")).toBeDefined();
  });

  it("NEW-C-9 AC1.2 · an unverified domain: the four site files and the supplied URL, and nothing else", async () => {
    const requested: string[] = [];
    await run(job(), depsServing(healthy(OPEN), requested));
    expect(requested.sort()).toEqual([
      "https://acme.com/",
      "https://acme.com/.well-known/llms.txt",
      "https://acme.com/llms.txt",
      "https://acme.com/robots.txt",
      "https://acme.com/sitemap.xml",
    ]);
  });

  it("NEW-C-9 AC1.3 · the default fetcher is the SSRF-guarded one: an unresolvable demo domain fails the audit, it does not throw", async () => {
    await db.query("UPDATE projects SET root_domain = 'demo-brand.example' WHERE id = $1", [projectId]);
    const sleep = async (): Promise<void> => undefined;
    await expect(createCrawlAuditHandler({ pool: {} as never, env: {} as never }, { sleep })(db as never, job())).resolves.toBeUndefined();
    const [a] = await audits();
    expect(a.status).toBe("failed");
    expect(await findings()).toHaveLength(0);
  });

  it("NEW-C-9 AC2.1 · writes a public_surface audit (unverified) with the trigger, snapshot, hash, site-file facts and the one page", async () => {
    await run(job({ trigger: "scheduled" }), depsServing(healthy(OPEN)));
    const [a] = await audits();
    expect(a).toMatchObject({ trigger: "scheduled", scope: "public_surface", status: "completed", llms_txt_present: true, sitemap_url_count: 1, pages_crawled: 1, pages_failed: 0 });
    expect(a.robots_snapshot).toBe(OPEN);
    // STORY-050 #5 — the audit records the tokenizer its token-count thresholds are measured with, never a placeholder.
    expect(a.tokenizer).toBe(tokenizerLabel(cl100kTokenizer.identity));
    expect(Buffer.isBuffer(a.robots_hash) && a.robots_hash.length === 32).toBe(true);
    expect(a.started_at).not.toBeNull();
    expect(a.finished_at).not.toBeNull();
  });

  it("NEW-C-9 AC2.2 · excluded_rules names every rule that did not run: AUX-R-005, 028, 031-034 and, with no measured timing, AUX-R-029 (the page rules that ran are no longer named: STORY-051 AC13)", async () => {
    await run(job(), depsServing(healthy(OPEN)));
    const [a] = await audits();
    const excluded: string[] = a.excluded_rules;
    const codes = excluded.filter((e) => e.startsWith("AUX-R-"));
    expect(codes).toHaveLength(7);
    for (const ran of ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007", "AUX-R-006", "AUX-R-008"]) expect(excluded).not.toContain(ran);
    expect(excluded).toContain("AUX-R-005");
    expect(excluded).not.toContain("AUX-R-013"); // STORY-187: evaluated again
    expect(excluded).toContain("AUX-R-029");
    expect(excluded).toContain("AUX-R-034");
    expect(excluded).not.toContain("page_crawl"); // a page WAS crawled: naming it as not run would be false
  });

  it("NEW-C-9 AC5.1 · publishes the crawler_access subscore and, with the pages judged, a PARTIAL headline score (owner decision 38); a critical finding sets the capped flag and caps it at 72", async () => {
    await run(job(), depsServing(healthy(BLOCKED)));
    const [a] = await audits();
    // the headline is high (four clean categories) and is capped to 72 by the critical crawler_access finding
    expect(Number(a.aux_score)).toBe(72);
    expect(a.score_capped).toBe(true);
    expect(a.findings_critical).toBe(1);
    // Decision 52: the critical AUX-R-001 (weight 0.30) takes its weight off crawler_access's DECIDED rules (AUX-R-005, 0.24, is never decided): 1 - 0.30/0.76. Decision 55
    // does not move this figure: every decided rule here ran in this audit.
    expect(Number(a.score_breakdown.crawler_access)).toBeCloseTo(0.6052631578947368, 12);
  });

  it("NEW-C-9 AC5.2 · a clean site: subscore 1, not capped, a partial headline of 100 (renormalised over the five measured categories)", async () => {
    await run(job(), depsServing(healthy(OPEN)));
    const [a] = await audits();
    expect(Number(a.aux_score)).toBe(100);
    expect(a.score_capped).toBe(false);
    expect(Number(a.score_breakdown.crawler_access)).toBe(1);
    expect(await findings()).toHaveLength(0);
  });

  it("NEW-C-9 AC3.17 · the same defect in two audits is one finding with occurrence_count 2", async () => {
    await run(job(), depsServing(healthy(BLOCKED)));
    await run(job(), depsServing(healthy(BLOCKED)));
    const f = await findings();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule_code: "AUX-R-001", status: "open", occurrence_count: 2, severity: "critical" });
  });

  it("NEW-C-9 AC3.18 · a later audit that does not reproduce the finding resolves it, recording the time", async () => {
    await run(job(), depsServing(healthy(BLOCKED)));
    await run(job(), depsServing(healthy(OPEN)));
    const [f] = await findings();
    expect(f.status).toBe("resolved");
    expect(f.resolved_at).not.toBeNull();
  });

  it("NEW-C-9 AC3.19 · a defect returning after resolution regresses: original date kept, severity one band higher", async () => {
    // AUX-R-004 (llms.txt absent, low) is the finding that can rise a band.
    const noLlms: Served = { ...healthy(OPEN), "/llms.txt": { status: 404 }, "/.well-known/llms.txt": { status: 404 } };
    await run(job(), depsServing(noLlms));
    const [first] = await findings();
    expect(first.severity).toBe("low");
    await run(job(), depsServing(healthy(OPEN)));
    await run(job(), depsServing(noLlms));
    const all = await findings();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "regressed", severity: "medium" });
    expect(all[0]!.first_detected_at).toEqual(first.first_detected_at);
    expect(all[0]!.regressed_at).not.toBeNull();
  });

  it("NEW-C-9 AC3.20 · an unreachable robots.txt (our fetch failed) is partial and resolves nothing", async () => {
    await run(job(), depsServing(healthy(BLOCKED)));
    await run(job(), depsServing({ ...healthy(OPEN), "/robots.txt": "throw" }));
    const a = await audits();
    expect(a[1]!.status).toBe("partial");
    expect(a[1]!.pages_failed).toBe(1);
    const [f] = await findings();
    expect(f.status).toBe("open");
    expect(await findings()).toHaveLength(1);
  });

  it("NEW-C-9 AC1.4 · a fetch that exceeds the timeout counts as failed rather than hanging the job", async () => {
    await run(job(), depsServing({ ...healthy(OPEN), "/sitemap.xml": "hang" }, [], 50));
    const [a] = await audits();
    expect(a.status).toBe("partial");
    expect(a.sitemap_url_count).toBeNull();
  });

  it("NEW-C-9 AC1.5 · every fetch failing is a failed audit with no findings, not an exception", async () => {
    await run(job(), depsServing({}));
    const [a] = await audits();
    expect(a.status).toBe("failed");
    expect(a.error_summary).toMatchObject({ reason: "all_site_files_unreachable" });
    expect(await findings()).toHaveLength(0);
  });

  it("NEW-C-9 AC4.1 · redelivery of the same job is idempotent: one audit, no second occurrence", async () => {
    const j = job();
    await run(j, depsServing(healthy(BLOCKED)));
    await run(j, depsServing(healthy(BLOCKED)));
    expect(await audits()).toHaveLength(1);
    expect((await findings())[0]!.occurrence_count).toBe(1);
  });

  it("NEW-C-9 AC1.6 · a deleted project is skipped quietly", async () => {
    await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [projectId]);
    await run(job(), depsServing(healthy(OPEN)));
    expect(await audits()).toHaveLength(0);
  });

  it("NEW-C-9 AC1.7 · a trigger outside onboarding/scheduled/manual (post_fix is not produced yet) is refused at the boundary", async () => {
    await expect(run(job({ trigger: "post_fix" }), depsServing(healthy(OPEN)))).rejects.toThrow();
    await expect(run(job({ extra: 1 }), depsServing(healthy(OPEN)))).rejects.toThrow();
  });

  it("NEW-C-9 AC6.1 · counts the audit by status and trigger, and the log line carries ids, never the domain's file text", async () => {
    await run(job(), depsServing(healthy(BLOCKED)));
    expect(counters).toContainEqual({ name: "nominara_aux_audits_total", labels: { status: "completed", trigger: "onboarding" } });
  });

  // ------------------------------------------------------------------------------------------------------------------
  // STORY-049 — authorisation by verification state, page selection, the two fetches, politeness, failures that do not abort
  // ------------------------------------------------------------------------------------------------------------------
  const SITEMAP_PAGES = `<urlset>
    <url><loc>https://acme.com/</loc></url>
    <url><loc>https://acme.com/pricing</loc><priority>0.9</priority></url>
    <url><loc>https://acme.com/about</loc><priority>0.3</priority></url>
  </urlset>`;
  const withSitemap = (xml: string, robots = OPEN): Served => ({
    ...healthy(robots),
    "/sitemap.xml": { status: 200, body: xml },
    "/pricing": { status: 200, body: HEALTHY_PAGE },
    "/about": { status: 200, body: HEALTHY_PAGE },
  });
  const manifestOf = async (): Promise<ReturnType<typeof crawlManifestSchema.parse>> => {
    const [a] = await audits();
    const key = [...stored.keys()].find((k) => k.endsWith("manifest.json"))!;
    expect(key).toBeDefined();
    expect(a.dom_object_prefix).toMatch(new RegExp(`^crawl/test/ws/${a.id}/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/$`)); // {audit}/{run}/ (ADR-0003, R1)
    return crawlManifestSchema.parse(JSON.parse(stored.get(key)!.toString("utf8")));
  };

  it("STORY-049 scenario 10 · an unverified domain is public_surface: the supplied URL and the site files, the pages of the sitemap NOT fetched", async () => {
    const requested: string[] = [];
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES), requested));
    const [a] = await audits();
    expect(a.scope).toBe("public_surface");
    expect(requested).not.toContain("https://acme.com/pricing");
    expect(requested).not.toContain("https://acme.com/about");
    expect(a.target_urls).toContain("https://acme.com/");
    expect(a.excluded_rules).toContain("AUX-R-005");
  });

  it("STORY-049 AC8 (owner decision 2026-10-22) · an unverified domain's audit sends every request as NominaraBot and under no other crawler's name", async () => {
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES)));
    expect(requestedUas.length).toBeGreaterThan(0);
    for (const r of requestedUas) expect(r.ua).toBe(NOMINARA_USER_AGENT);
  });

  it("STORY-049 AC9 · a payload cannot escalate an unverified domain: scope key_pages is still public_surface", async () => {
    const requested: string[] = [];
    await run(job({ scope: "key_pages" }), depsServing(withSitemap(SITEMAP_PAGES), requested));
    expect((await audits())[0]!.scope).toBe("public_surface");
    expect(requested).not.toContain("https://acme.com/pricing");
  });

  it("STORY-049 AC9 · the mirror alone is not authority: projects.domain_verified_at set with no verified domain_verifications row is still public_surface", async () => {
    await db.query("UPDATE projects SET domain_verified_at = now() WHERE id = $1", [projectId]);
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES)));
    expect((await audits())[0]!.scope).toBe("public_surface");
  });

  it("STORY-049 AC9 · a verification that has lapsed (verified_at cleared) is public_surface again", async () => {
    await verifyDomain();
    await db.query("UPDATE domain_verifications SET verified_at = NULL WHERE project_id = $1", [projectId]);
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES)));
    expect((await audits())[0]!.scope).toBe("public_surface");
  });

  it("STORY-049 scenario 9 · a verified domain is key_pages: the root and the sitemap's pages, both copies of each", async () => {
    await verifyDomain();
    const requested: string[] = [];
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES), requested));
    const [a] = await audits();
    expect(a).toMatchObject({ scope: "key_pages", status: "completed", pages_crawled: 3, pages_failed: 0 });
    expect(requested).toEqual(expect.arrayContaining(["https://acme.com/", "https://acme.com/pricing", "https://acme.com/about"]));
    expect(rendered.sort()).toEqual(["https://acme.com/", "https://acme.com/about", "https://acme.com/pricing"]);
    expect([...stored.keys()].filter((k) => k.endsWith(".raw.html.gz"))).toHaveLength(3);
    expect([...stored.keys()].filter((k) => k.endsWith(".rendered.html.gz"))).toHaveLength(3);
    expect(a.target_urls).toEqual(expect.arrayContaining(["https://acme.com/pricing", "https://acme.com/robots.txt"]));
  });

  it("STORY-049 scenario 7 · the stored copies are the gunzipped bytes as fetched, and the manifest names them with their hashes", async () => {
    await verifyDomain();
    await run(job({ scope: "single_url", targetUrls: ["https://acme.com/pricing"] }), depsServing(withSitemap(SITEMAP_PAGES)));
    const m = await manifestOf();
    expect(m.scope).toBe("single_url");
    const page = m.pages.find((p) => p.url === "https://acme.com/pricing")!;
    expect(page.outcome).toBe("ok");
    const rawKey = page.raw!.object_key.replace("crawl/test/ws/", "");
    expect(gunzipSync(stored.get(rawKey)!).toString()).toBe(HEALTHY_PAGE);
    expect(m.sitemap).toMatchObject({ files_fetched: 1, total_seen: 3 });
  });

  it("STORY-049 AC8 · a verified domain sends no impersonating request: every request is NominaraBot, the page count is exactly the site files plus the pages, and the manifest has no probe", async () => {
    await verifyDomain();
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES)));
    expect(requestedUas).toHaveLength(7); // robots, llms, well-known llms, sitemap, and three pages: no probe request
    for (const r of requestedUas) expect(r.ua).toBe(NOMINARA_USER_AGENT);
    expect(await manifestOf()).not.toHaveProperty("probe");
  });

  it("STORY-049 AC8 · AI-bot access is judged from robots.txt for each AI crawler token: a named Disallow reads false, every other token reads true", async () => {
    await verifyDomain();
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES, BLOCKED)));
    const access = (await manifestOf()).ai_bot_access;
    expect(access).not.toBeNull();
    const byAgent = Object.fromEntries(access!.map((x) => [x.agent, x.allowed]));
    expect(byAgent).toEqual({
      GPTBot: false, ClaudeBot: true, PerplexityBot: true, "Google-Extended": true,
      "Applebot-Extended": true, Bytespider: true, CCBot: true, "meta-externalagent": true,
    });
  });

  it("STORY-049 AC8 · a wildcard Disallow binds a token no group names (RFC 9309 group selection), and a named Allow overrides it", async () => {
    await verifyDomain();
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES, "User-agent: *\nDisallow: /\n\nUser-agent: ClaudeBot\nAllow: /\n")));
    const byAgent = Object.fromEntries((await manifestOf()).ai_bot_access!.map((x) => [x.agent, x.allowed]));
    expect(byAgent.GPTBot).toBe(false);
    expect(byAgent.ClaudeBot).toBe(true);
  });

  it("STORY-049 AC8 · with robots.txt unreachable the AI-bot verdict is null (not judged), never 'allowed'", async () => {
    await verifyDomain();
    await run(job(), depsServing({ ...withSitemap(SITEMAP_PAGES), "/robots.txt": "throw" }));
    expect((await manifestOf()).ai_bot_access).toBeNull();
  });

  it("STORY-049 AC8 · LIMITATION pinned: a WAF that refuses an AI user agent is NOT detectable, so AUX-R-005 is named in excluded_rules and is never a finding", async () => {
    await verifyDomain();
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES)));
    const [a] = await audits();
    expect(a.excluded_rules).toContain("AUX-R-005");
    expect((await findings()).map((f) => f.rule_code)).not.toContain("AUX-R-005");
  });

  it("review r2 · robots_hash is the sha256 of the bytes as fetched, even when robots.txt is not valid UTF-8", async () => {
    const raw = Buffer.concat([Buffer.from(`${OPEN}# `), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from("\n")]);
    expect(raw.toString("utf8")).not.toBe(raw.toString("latin1")); // the bytes cannot round-trip through a utf8 string
    const deps = depsServing(healthy(OPEN));
    const inner = deps.fetch!;
    await run(job(), { ...deps, fetch: async (url, init) => (new URL(url).pathname === "/robots.txt" ? { status: 200, headers: {}, body: raw, finalUrl: url } : inner(url, init)) });
    const [a] = await audits();
    expect(Buffer.from(a.robots_hash).equals(createHash("sha256").update(raw).digest())).toBe(true);
  });

  it("review r2 · with no renderer installed the up-front shrink counts ONE request per page, so the wall-clock budget admits twice the pages", async () => {
    await verifyDomain();
    const delayRobots = "User-agent: *\nCrawl-delay: 10\nAllow: /\n";
    // 80 s: after the four site files (t = 0..30 s) five more requests start before the deadline: two pages with a renderer, three without.
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES, delayRobots), [], 10_000, { wallClockBudgetMs: 80_000 }));
    const withRenderer = (await audits())[0]!.error_summary.crawl_delay_limited.pages_skipped as number;
    await db.query("TRUNCATE aux_audits CASCADE");
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES, delayRobots), [], 10_000, { wallClockBudgetMs: 80_000, renderer: unavailableRenderer }));
    const [a] = await audits();
    expect(withRenderer).toBe(1);
    expect(a.error_summary?.crawl_delay_limited?.pages_skipped ?? 0).toBe(0);
  });

  it("STORY-049 AC7 · every request carries the identified NominaraBot user agent, the pages and the site files alike", async () => {
    await verifyDomain();
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES)));
    expect(requestedUas).toHaveLength(7);
    for (const r of requestedUas) expect(r.ua).toBe("NominaraBot/1.0 (+https://nominara.com/bot)");
  });

  it("STORY-049 scenario 8 · a declared Crawl-delay is honoured between requests, and the interval is never below 500 ms", async () => {
    await verifyDomain();
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES, "User-agent: *\nCrawl-delay: 3\nAllow: /\n")));
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(500);
    expect(sleeps).toContain(3000);
  });

  it("STORY-049 AC7 · the page cap is a hard stop: with a cap of 2, two pages are fetched and the rest are counted as over the cap", async () => {
    await verifyDomain();
    const requested: string[] = [];
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES), requested, 10_000, { pageCap: 2 }));
    const [a] = await audits();
    expect(a.pages_crawled).toBe(2);
    expect(requested).not.toContain("https://acme.com/about");
    expect(a.error_summary).toMatchObject({ pages_over_cap: 1 });
    expect((await manifestOf()).pages_over_cap).toBe(1);
  });

  it("STORY-049 AC4 · the sitemap URL comes from the robots Sitemap: line, and /sitemap.xml is not requested when one is declared", async () => {
    const requested: string[] = [];
    const served: Served = {
      ...healthy("User-agent: *\nAllow: /\nSitemap: https://acme.com/maps/main.xml\n"),
      "/maps/main.xml": { status: 200, body: SITEMAP_PAGES },
    };
    await run(job(), depsServing(served, requested));
    expect(requested).toContain("https://acme.com/maps/main.xml");
    expect(requested).not.toContain("https://acme.com/sitemap.xml");
    expect((await audits())[0]!.sitemap_url_count).toBe(3);
  });

  it("STORY-049 AC4 · a sitemap index is followed to its children, and a child on another registrable domain is not", async () => {
    const requested: string[] = [];
    const served: Served = {
      ...healthy(OPEN),
      "/sitemap.xml": { status: 200, body: `<sitemapindex><sitemap><loc>https://acme.com/s1.xml</loc></sitemap><sitemap><loc>https://rival.com/s2.xml</loc></sitemap></sitemapindex>` },
      "/s1.xml": { status: 200, body: SITEMAP_PAGES },
    };
    await run(job(), depsServing(served, requested));
    expect(requested).toContain("https://acme.com/s1.xml");
    expect(requested).not.toContain("https://rival.com/s2.xml");
    expect((await audits())[0]!.sitemap_url_count).toBe(3);
  });

  it("STORY-049 AC7 · a page robots.txt disallows for NominaraBot is skipped and recorded, and is not a failure", async () => {
    await verifyDomain();
    const robots = "User-agent: NominaraBot\nDisallow: /pricing\n";
    const requested: string[] = [];
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES, robots), requested));
    const [a] = await audits();
    expect(requested).not.toContain("https://acme.com/pricing");
    expect(a).toMatchObject({ status: "completed", pages_failed: 0, pages_crawled: 2 });
    expect(a.error_summary).toMatchObject({ skipped_pages: [{ url: "https://acme.com/pricing", reason: "robots_disallowed" }] });
  });

  it("STORY-049 AC7 · a robots.txt that errors (5xx or unreachable) means NO page is fetched, and each is recorded as skipped (RFC 9309: assume disallow)", async () => {
    await verifyDomain();
    for (const robots of [{ status: 503, body: "" }, "throw" as const]) {
      stored.clear();
      const requested: string[] = [];
      await run(job(), depsServing({ ...withSitemap(SITEMAP_PAGES), "/robots.txt": robots }, requested));
      expect(requested.filter((u) => !/robots|llms|sitemap/.test(u))).toEqual([]);
    }
    const a = (await audits()).at(-1)!;
    expect(a.error_summary.skipped_pages.map((p: { reason: string }) => p.reason)).toContain("robots_unavailable");
    // NO page was crawled, so the audit must still say the page crawl did not run (review round 2: naming it only when no
    // page was crawled is the other half of the AC2.1 assertion that it is NOT named when one was)
    expect(a.pages_crawled).toBe(0);
    expect(a.excluded_rules).toContain("page_crawl");
  });

  it("STORY-049 AC7 · a robots.txt that is simply absent (404) is not a prohibition: the pages are fetched", async () => {
    await verifyDomain();
    const requested: string[] = [];
    await run(job(), depsServing({ ...withSitemap(SITEMAP_PAGES), "/robots.txt": { status: 404, body: "" } }, requested));
    expect(requested).toContain("https://acme.com/pricing");
  });

  it("STORY-049 scenario 11 · a page returning an error is recorded as failed with its reason, the audit CONTINUES and ends partial", async () => {
    await verifyDomain();
    const served = { ...withSitemap(SITEMAP_PAGES), "/pricing": { status: 500, body: "boom" } } as Served;
    await run(job(), depsServing(served));
    const [a] = await audits();
    expect(a).toMatchObject({ status: "partial", pages_crawled: 2, pages_failed: 1 });
    expect(a.error_summary.failed_pages).toEqual([{ url: "https://acme.com/pricing", failures: [{ stage: "raw", reason: "http_500", http_status: 500 }] }]);
    expect(rendered).toContain("https://acme.com/about"); // the page after the failed one was still crawled
  });

  it("STORY-049 AC6 / AC12 · with no renderer installed the plain copy is kept, the page is recorded failed at the rendered stage, and the audit is partial", async () => {
    const { renderer: _installed, ...deps } = depsServing(healthy(OPEN));
    void _installed;
    await run(job(), deps);
    const [a] = await audits();
    expect(a.status).toBe("partial");
    // REVIEW FINDING: a page whose plain copy IS stored is not "failed". It is counted apart, so a deployment with no
    // renderer does not read as "every page failed".
    expect(a).toMatchObject({ pages_crawled: 1, pages_failed: 0 });
    expect(a.error_summary.pages_partial).toBe(1);
    expect(a.error_summary.failed_pages[0].failures).toEqual([{ stage: "rendered", reason: "renderer_unavailable", http_status: null }]);
    expect([...stored.keys()].some((k) => k.endsWith(".raw.html.gz"))).toBe(true);
    expect([...stored.keys()].some((k) => k.endsWith(".rendered.html.gz"))).toBe(false);
  });

  it("STORY-049 AC11 · a robots.txt with a NUL byte does not fail the audit write: the snapshot is sanitised, the hash is of the bytes as fetched", async () => {
    const hostile = "User-agent: *\u0000\nAllow: /\n";
    await run(job(), depsServing(healthy(hostile)));
    const [a] = await audits();
    expect(a.status === "completed" || a.status === "partial").toBe(true);
    expect(a.robots_snapshot).not.toContain("\u0000");
    expect(a.robots_hash.toString("hex")).toBe((await import("node:crypto")).createHash("sha256").update(hostile).digest("hex"));
  });

  it("STORY-049 AC12 · storage that is not configured fails the pages (storage_unavailable), not the audit: the site-file findings are still written", async () => {
    const { store: _configured, ...deps } = depsServing(healthy(BLOCKED));
    void _configured;
    await run(job(), deps);
    const [a] = await audits();
    expect(a.status).toBe("partial");
    expect(a.error_summary.failed_pages[0].failures.map((f: { reason: string }) => f.reason)).toContain("storage_unavailable");
    expect(await findings()).toHaveLength(1);
  });

  it("STORY-049 AC5 · key_pages puts the pages the customer's own evidence points at ahead of the sitemap: an owned citation and an open task", async () => {
    await verifyDomain();
    const promptId = randomUUID();
    const url = "https://acme.com/cited";
    await db.query(
      `INSERT INTO citation_facts (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url,
          url_hash, domain, is_owned, is_competitor, http_status, position_weight)
       VALUES ($1,$2,$3,$4,'gemini', now() - interval '3 days', 1,$5,$5,$6,'acme.com',true,false,200,1)`,
      [workspaceId, projectId, randomUUID(), promptId, url, (await import("node:crypto")).createHash("sha256").update(url).digest()],
    );
    await db.query(
      `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, affected_url)
       VALUES ($1,$2,$3,'T-c9','technical',sha256(random()::text::bytea),'t','d','todo','https://acme.com/tasked')`,
      [randomUUID(), workspaceId, projectId],
    );
    // A closed task's URL is not "named in an open task".
    await db.query(
      `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, affected_url)
       VALUES ($1,$2,$3,'T-c9b','technical',sha256(random()::text::bytea),'t','d','done','https://acme.com/finished')`,
      [randomUUID(), workspaceId, projectId],
    );
    const requested: string[] = [];
    const served: Served = { ...withSitemap(SITEMAP_PAGES), "/cited": { status: 200, body: "c" }, "/tasked": { status: 200, body: "t" }, "/finished": { status: 200, body: "f" } };
    await run(job(), depsServing(served, requested, 10_000, { pageCap: 3 }));
    const pages = requested.filter((u) => !/robots|llms|sitemap/.test(u));
    expect(pages).toContain("https://acme.com/cited");
    expect(pages).toContain("https://acme.com/tasked");
    expect(pages).not.toContain("https://acme.com/finished");
    expect(pages).not.toContain("https://acme.com/about");
  });

  it("STORY-049 AC5 · the default page cap comes from the plan (provisional constant until the entitlement key exists)", async () => {
    await verifyDomain();
    const many = `<urlset>${Array.from({ length: 40 }, (_, i) => `<url><loc>https://acme.com/p${i}</loc></url>`).join("")}</urlset>`;
    const served: Served = { ...withSitemap(many), ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`/p${i}`, { status: 200, body: "p" }])) };
    await run(job(), depsServing(served));
    expect((await audits())[0]!.pages_crawled).toBe(25);
  });

  it("STORY-049 · counts the pages crawled by outcome", async () => {
    await verifyDomain();
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES)));
    expect(counters.filter((c) => c.name === "nominara_aux_crawl_pages_total").map((c) => c.labels.outcome)).toContain("ok");
  });

  // ------------------------------------------------------------------------------------------------------------------
  // REVIEW ROUND 1 — a hostile robots.txt, the open transaction, partial vs failed, and the runtime role
  // ------------------------------------------------------------------------------------------------------------------
  // OWNER DECISION 2026-10-22: a declared Crawl-delay is honoured up to MAX_HONOURED_CRAWL_DELAY_MS (60 s) and honoured as that
  // beyond it, with the declared value reported. Pinned from the hazard: a hostile 86400 s must not cost the audit its site files.
  it.each(["86400", "1000000000"])(
    "REVIEW · a robots.txt with Crawl-delay %s is CAPPED at 60 s: llms.txt is fetched after one full 60 s wait, what the 100 s budget cannot cover is recorded as crawl_delay_budget (never as a failure), and every rule that did not run is named",
    async (delay) => {
      await verifyDomain();
      const requested: string[] = [];
      await run(job(), depsServing(withSitemap(SITEMAP_PAGES, `User-agent: *\nCrawl-delay: ${delay}\nAllow: /\n`), requested, 10_000, { wallClockBudgetMs: 100_000 }));
      const [a] = await audits();
      expect(a.status).toBe("partial");
      expect(requested).toEqual(["https://acme.com/robots.txt", "https://acme.com/llms.txt"]);
      expect(sleeps).toEqual([60_000]);
      expect(clockMs).toBe(60_000);
      // skipped is not failed: nothing in site_files_failed, and the skipped files are not counted as failed pages
      expect(a.error_summary.site_files_failed).toBeUndefined();
      expect(a.pages_failed).toBe(0);
      expect(a.error_summary.skipped_pages).toEqual([
        { url: "https://acme.com/.well-known/llms.txt", reason: "crawl_delay_budget" },
        { url: "https://acme.com/sitemap.xml", reason: "crawl_delay_budget" },
        { url: "https://acme.com/", reason: "crawl_delay_budget" },
      ]);
      expect(a.error_summary.crawl_delay_limited).toEqual({ crawl_delay_ms: 60_000, declared_crawl_delay_ms: Number(delay) * 1000, pages_skipped: 1 });
      const m = await manifestOf();
      expect(m.selection_skipped.filter((x) => x.reason === "crawl_delay_budget")).toHaveLength(1);
      expect(m.sitemap).toMatchObject({ files_fetched: 0, total_seen: 0, problems: [{ url: "https://acme.com/sitemap.xml", reason: "crawl_delay_budget" }] });
      // AUX-R-004 (needs both llms files) and AUX-R-007 (needs the sitemap) did not run, so they are named
      expect(a.excluded_rules).toEqual(expect.arrayContaining(["AUX-R-004", "AUX-R-007"]));
      expect(a.excluded_rules).not.toContain("AUX-R-001"); // robots.txt was read: these ran
      expect((await findings()).map((f) => f.rule_code)).not.toContain("AUX-R-007");
    },
  );

  it("REVIEW · with the real 10-minute budget a 86400 s Crawl-delay still fetches all four site files, each after a 60 s wait, and reports both delays", async () => {
    await verifyDomain();
    const requested: string[] = [];
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES, "User-agent: *\nCrawl-delay: 86400\nAllow: /\n"), requested));
    const [a] = await audits();
    expect(requested.slice(0, 4)).toEqual([
      "https://acme.com/robots.txt", "https://acme.com/llms.txt", "https://acme.com/.well-known/llms.txt", "https://acme.com/sitemap.xml",
    ]);
    for (const s of sleeps) expect(s).toBe(60_000);
    expect(a.error_summary?.site_files_failed).toBeUndefined();
    expect((a.error_summary?.skipped_pages ?? []).filter((x: { url: string }) => /llms|sitemap/.test(x.url))).toEqual([]);
    expect(a.error_summary.crawl_delay_limited).toMatchObject({ crawl_delay_ms: 60_000, declared_crawl_delay_ms: 86_400_000 });
    expect(a.excluded_rules).not.toContain("AUX-R-004");
    expect(a.excluded_rules).not.toContain("AUX-R-007");
  });

  it("REVIEW · an UNVERIFIED project is bounded too: robots.txt is read before any verification matters, then llms.txt after the capped wait and nothing more", async () => {
    const requested: string[] = [];
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES, "User-agent: *\nCrawl-delay: 86400\n"), requested, 10_000, { wallClockBudgetMs: 100_000 }));
    const [a] = await audits();
    expect(a.status).toBe("partial");
    expect(sleeps).toEqual([60_000]);
    expect(requested).toEqual(["https://acme.com/robots.txt", "https://acme.com/llms.txt"]);
    expect(clockMs).toBe(60_000);
  });

  it("REVIEW · a budget too short for even the site files ends the audit instead of throwing out of the handler", async () => {
    await verifyDomain();
    const requested: string[] = [];
    await run(job(), depsServing(withSitemap(SITEMAP_PAGES, "User-agent: *\nCrawl-delay: 5\n"), requested, 10_000, { wallClockBudgetMs: 6_000 }));
    const [a] = await audits();
    expect(a.status).toBe("partial");
    expect(requested).toEqual(["https://acme.com/robots.txt", "https://acme.com/llms.txt"]);
    expect(sleeps).toEqual([5_000]);
    expect(a.error_summary.site_files_failed).toBeUndefined();
    expect(a.error_summary.skipped_pages.map((x: { reason: string }) => x.reason)).toEqual(["crawl_delay_budget", "crawl_delay_budget", "crawl_delay_budget"]);
    expect(a.error_summary.crawl_delay_limited).toEqual({ crawl_delay_ms: 5_000, pages_skipped: 1 });
  });

  // The test that stood here pinned a transaction-local idle_in_transaction_session_timeout (15 min) set before the crawl, the
  // backstop for a transaction held open across the crawl. There is no such transaction any more (ADR-0003): the fetch phase holds
  // none, and the two short ones never wait on the network. test/integration/crawl-audit-kad06.spec.ts proves that directly
  // (no `idle in transaction` backend and no checked-out client during any fetch, render or object-store write), which is
  // strictly stronger than a timeout that only ends the hold.

  it("REVIEW · a page that hangs is bounded by the same timeout as the site files, recorded as a timeout, and the crawl continues", async () => {
    await verifyDomain();
    const served = { ...withSitemap(SITEMAP_PAGES), "/pricing": "hang" } as Served;
    await run(job(), depsServing(served, [], 50));
    const [a] = await audits();
    expect(a.error_summary.failed_pages).toContainEqual({ url: "https://acme.com/pricing", failures: [{ stage: "raw", reason: "timeout", http_status: null }] });
    expect(rendered).toContain("https://acme.com/about");
  });

  it("REVIEW · pages_failed counts only pages with NO stored copy; a page with a stored plain copy and no rendered one is counted apart", async () => {
    await verifyDomain();
    const served = { ...withSitemap(SITEMAP_PAGES), "/pricing": { status: 500, body: "boom" } } as Served;
    const deps = depsServing(served);
    const { renderer: _none, ...noRenderer } = deps;
    void _none;
    await run(job(), noRenderer);
    const [a] = await audits();
    // root and /about: plain copy stored, render unavailable -> partial; /pricing: 500 -> failed
    expect(a).toMatchObject({ status: "partial", pages_crawled: 2, pages_failed: 1 });
    expect(a.error_summary.pages_partial).toBe(2);
  });

  describe("under the runtime role, with RLS in force", () => {
    let pool: Pool;
    beforeAll(async () => {
      const password = resolvePassword("nominara_app", {});
      await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
      pool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password });
    });
    afterAll(async () => { await pool.end(); });

    const asTenant = async (workspace: string, fn: (tx: ClientBase) => Promise<unknown>): Promise<void> => {
      const client = await pool.connect();
      try {
        await withTenantContext(client, { workspaceId: workspace, actorId: SYSTEM_ACTOR_ID }, fn);
      } finally {
        client.release();
      }
    };

    it("REVIEW · authorisation reads domain_verifications under RLS: workspace B's verified row for the same domain does not widen A's scope", async () => {
      const wsB = (await db.query("INSERT INTO workspaces (name, slug, plan_key) VALUES ('B','w-c9-b','free') RETURNING id")).rows[0].id as string;
      const projectB = (await db.query(
        "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1,'PB','p-c9-b','https://acme.com','acme.com') RETURNING id", [wsB],
      )).rows[0].id as string;
      await db.query(
        `INSERT INTO domain_verifications (id, workspace_id, project_id, domain, method, nonce, verified_at, last_checked_at)
         VALUES ($1,$2,$3,'acme.com','dns_txt','nonce-b',now(),now())`, [randomUUID(), wsB, projectB],
      );
      const requested: string[] = [];
      const j = job();
      await asTenant(workspaceId, (tx) => createCrawlAuditHandler({ pool: {} as never, env: {} as never }, depsServing(withSitemap(SITEMAP_PAGES), requested))(tx, j));
      const [a] = await audits();
      expect(a).toMatchObject({ scope: "public_surface", workspace_id: workspaceId });
      expect(requested).not.toContain("https://acme.com/pricing");
      // and a verified A under the same role does get full scope
      await verifyDomain();
      await asTenant(workspaceId, (tx) => createCrawlAuditHandler({ pool: {} as never, env: {} as never }, depsServing(withSitemap(SITEMAP_PAGES)))(tx, job()));
      expect((await audits()).at(-1)).toMatchObject({ scope: "key_pages", pages_crawled: 3 });
    });

    it("REVIEW · the tenant object store resolves the workspace from the tenant context at call time: every key lands under {env}/{workspace_id}/crawl/", async () => {
      await verifyDomain();
      const puts: string[] = [];
      const port = { put: async (r: { key: string }) => { puts.push(r.key); } } as unknown as ObjectStoragePort;
      const tenantStore = new TenantObjectStore(port, "test");
      const deps = depsServing(withSitemap(SITEMAP_PAGES), [], 10_000, {
        store: (relative, body, contentType) => tenantStore.put("crawl", relative, body, { contentType }),
      });
      await asTenant(workspaceId, (tx) => createCrawlAuditHandler({ pool: {} as never, env: {} as never }, deps)(tx, job()));
      expect(puts.length).toBeGreaterThan(0);
      for (const key of puts) expect(key.startsWith(`test/${workspaceId}/crawl/`)).toBe(true);
      expect(puts.some((k) => k.endsWith("/manifest.json"))).toBe(true);
    });

    // ---- STORY-052 -------------------------------------------------------------------------------------------------------
    const noLlms: Served = { ...healthy(OPEN), "/llms.txt": { status: 404 }, "/.well-known/llms.txt": { status: 404 } };
    const robotsDown: Served = { ...healthy(OPEN), "/robots.txt": "throw" };
    type Enqueue = NonNullable<CrawlAuditDeps["enqueueTaskGenerate"]>;
    // The queue is never touched by default: a test that cares about the enqueue passes its own.
    const runAsTenant = async (served: Served, extra: Partial<CrawlAuditDeps> = {}): Promise<void> => {
      await asTenant(workspaceId, (tx) => createCrawlAuditHandler({ pool: {} as never, env: {} as never }, depsServing(served, [], 10_000, { enqueueTaskGenerate: async () => undefined, ...extra }))(tx, job()));
    };
    const statusOf = async (): Promise<string[]> => (await findings()).map((f) => f.status as string);
    const milestones = async (): Promise<any[]> => (await db.query("SELECT * FROM milestones ORDER BY created_at")).rows; // eslint-disable-line @typescript-eslint/no-explicit-any

    it("STORY-052 scenario 10 · a finding whose file could not be fetched in two consecutive audits is STALE, not resolved", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(robotsDown);
      expect(await statusOf()).toEqual(["open"]);
      await runAsTenant(robotsDown);
      const [f] = await findings();
      expect(f.status).toBe("stale");
      expect(f.resolved_at).toBeNull();
    });

    it("STORY-052 scenario 10 · one unobserved audit followed by an audit that CAN see the file and does not reproduce it is resolved (the history resets)", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(robotsDown);
      await runAsTenant(healthy(OPEN));
      const [f] = await findings();
      expect(f.status).toBe("resolved");
      expect(f.resolved_at).not.toBeNull();
    });

    it("STORY-052 scenario 10 · an observed audit between two unobserved ones breaks the run: not two CONSECUTIVE audits", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(robotsDown);
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(robotsDown);
      expect(await statusOf()).toEqual(["open"]);
    });

    it("STORY-052 scenario 10 · a stale finding that is seen again reopens, keeping one row", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(robotsDown);
      await runAsTenant(robotsDown);
      expect(await statusOf()).toEqual(["stale"]);
      await runAsTenant(healthy(BLOCKED));
      expect(await statusOf()).toEqual(["open"]);
    });

    it("STORY-052 AC8 · a stale finding that a later audit OBSERVED clean is RESOLVED, pins one milestone, and a return regresses it", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(robotsDown);
      await runAsTenant(robotsDown);
      expect(await statusOf()).toEqual(["stale"]);
      await runAsTenant(healthy(OPEN));
      const [f] = await findings();
      expect(f.status).toBe("resolved");
      expect(f.resolved_at).not.toBeNull();
      expect(await milestones()).toHaveLength(1);
      await runAsTenant(healthy(BLOCKED));
      const [back] = await findings();
      expect(back.status).toBe("regressed");
      expect(back.resolved_at).toBeNull();
      expect(await findings()).toHaveLength(1);
    });

    it("STORY-052 AC8 · a stale finding stays stale while the file is still unobservable", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(robotsDown);
      await runAsTenant(robotsDown);
      await runAsTenant(robotsDown);
      expect(await statusOf()).toEqual(["stale"]);
      expect(await milestones()).toHaveLength(0);
    });

    it("STORY-052 scenario 10 · a wont_fix finding is not staled by an unobserved run", async () => {
      await runAsTenant(healthy(BLOCKED));
      await db.query("UPDATE aux_findings SET status = 'wont_fix', wont_fix_reason = 'accepted'");
      await runAsTenant(robotsDown);
      await runAsTenant(robotsDown);
      expect(await statusOf()).toEqual(["wont_fix"]);
    });

    it("STORY-052 scenario 10 · a STALE finding stays in the crawler_access subscore and the cap: stale must not score like a fix", async () => {
      await runAsTenant(healthy(BLOCKED));
      const before = (await audits()).at(-1);
      expect(before.score_capped).toBe(true);
      await runAsTenant(robotsDown);
      await runAsTenant(robotsDown);
      expect(await statusOf()).toEqual(["stale"]);
      const a = (await audits()).at(-1);
      expect(a.score_capped).toBe(true);
      // Decision 55 changes this (it refines 52): robots.txt being down leaves AUX-R-001/002/003 undecided in this audit, so the stale AUX-R-001 is neither in the penalty
      // nor in the denominator. crawler_access is scored on the decided rules alone (004 and 007: no finding), i.e. 1; the finding stays listed as stale, and the
      // cap and the flag still follow the open critical finding. (Under decision 52 this was 1 - w001/(decided + w001), < 1.)
      expect(Number(a.score_breakdown.crawler_access)).toBe(1);
      expect(a.aux_score).toBeNull(); // robots.txt down: no page was judged, so no headline (the subscore is published)
      expect(Number(before.score_breakdown.crawler_access)).toBeLessThan(1);
    });

    const r001Status = async (): Promise<string[]> => (await findings()).filter((f) => f.rule_code === "AUX-R-001").map((f) => f.status as string);
    const robots503: Served = { ...healthy(OPEN), "/robots.txt": { status: 503, body: "" } };
    it("STORY-052 AC8 · a robots.txt that answers 503 is not an observation: a critical AUX-R-001 is not resolved, pins no milestone, and stays capped", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(robots503);
      expect(await r001Status()).toEqual(["open"]);
      expect(await milestones()).toHaveLength(0);
      expect((await audits()).at(-1).score_capped).toBe(true);
    });

    it("STORY-052 AC8 · two 503 robots.txt audits in a row make the critical finding stale, still capped, still no milestone", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(robots503);
      await runAsTenant(robots503);
      expect(await r001Status()).toEqual(["stale"]);
      expect(await milestones()).toHaveLength(0);
      expect((await audits()).at(-1).score_capped).toBe(true);
    });

    it("round 7 (decision 56) · the 72 cap holds on its only live path: AUX-R-001 undecided (robots.txt 403) while its critical finding is open, pages judged -> headline 72, flag true, finding not resolved, crawler_access scored without 001", async () => {
      await runAsTenant(healthy(BLOCKED));
      expect((await r001Status())).toEqual(["open"]);
      await runAsTenant({ ...healthy(OPEN), "/robots.txt": { status: 403, body: "" } });
      const a = (await audits()).at(-1);
      expect(a.pages_crawled).toBeGreaterThan(0); // a 403 is a 4xx: RFC 9309 treats it as no robots file, so the page was crawled and judged
      expect(await r001Status()).toEqual(["open"]);
      expect(Number(a.aux_score)).toBe(72);
      expect(a.score_capped).toBe(true);
      // Worked by hand (decision 55): 001 (.30) and 002 (.08) are undecided, 005 is never decided, so the decided rules are 003 .12 + 004 .06 + 006 .12 + 007 .08 = .38. The only
      // penalty is the high AUX-R-003 (a 403 robots.txt, severity factor .6): 1 - .12 * .6 / .38. The open critical 001 weighs nothing, so it is neither in the penalty nor the denominator.
      expect(Number(a.score_breakdown.crawler_access)).toBeCloseTo(1 - (0.12 * 0.6) / 0.38, 12);
    });

    it("round 7 (decision 57) · every site file but llms.txt timing out: nothing in crawler_access was decided, so the flag is false and the headline null though a critical AUX-R-001 is still open", async () => {
      await runAsTenant(healthy(BLOCKED));
      const hung: Served = { ...healthy(OPEN), "/robots.txt": "hang", "/sitemap.xml": "hang", "/.well-known/llms.txt": "hang" };
      await runAsTenant(hung, { timeoutMs: 50 });
      const a = (await audits()).at(-1);
      expect(await r001Status()).toEqual(["open"]);
      expect(a.score_capped).toBe(false);
      expect(a.aux_score).toBeNull();
      expect(a.score_breakdown.crawler_access).toBeUndefined();
    });

    it("STORY-052 AC8 · a robots.txt that is definitively absent (404) still lets an open AUX-R-001 resolve", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant({ ...healthy(OPEN), "/robots.txt": { status: 404, body: "" } });
      const rows = await findings();
      expect(rows.find((f) => f.rule_code === "AUX-R-001")!.status).toBe("resolved");
    });

    it("STORY-052 scenario 11 · a new finding at or above its rule's task threshold enqueues task.generate AFTER commit, narrowed to aux_finding", async () => {
      const calls: { workspace: string; payload: unknown; key: string; visibleAtEnqueue: number }[] = [];
      const enqueueTaskGenerate: Enqueue = async (workspace, payload, key) => {
        // A separate connection: it sees the finding only if the audit's transaction has COMMITTED.
        const seen = await db.query("SELECT count(*)::int AS n FROM aux_findings");
        calls.push({ workspace, payload, key, visibleAtEnqueue: seen.rows[0].n });
      };
      await runAsTenant(healthy(BLOCKED), { enqueueTaskGenerate });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({ workspace: workspaceId, payload: { projectId, triggerKinds: ["aux_finding"] }, visibleAtEnqueue: 1 });
      const [f] = await findings();
      // The reference topology row: taskgen:{project}:{rule}:{fingerprint}.
      expect(calls[0]!.key).toBe(`taskgen:${projectId}:${f.rule_code}:${Buffer.from(f.fingerprint).toString("hex")}`);
    });

    it("STORY-052 AC10 (AUXLIVE-2) · a NEW page finding at or above its rule's task threshold enqueues task.generate after commit, keyed by rule and fingerprint; a re-detection enqueues nothing", async () => {
      const enqueued: { key: string; payload: unknown }[] = [];
      const enqueueTaskGenerate: Enqueue = async (_workspace, payload, key) => { enqueued.push({ key, payload }); };
      const broken: Served = { ...healthy(OPEN), "/": { status: 200, body: BROKEN_PAGE } };
      await runAsTenant(broken, { enqueueTaskGenerate });
      await new Promise((r) => setTimeout(r, 20));
      const [f] = (await findings()).filter((x) => x.rule_code === "AUX-R-008");
      expect(enqueued).toEqual([{ key: `taskgen:${projectId}:AUX-R-008:${(f.fingerprint as Buffer).toString("hex")}`, payload: { projectId, triggerKinds: ["aux_finding"] } }]);
      await runAsTenant(broken, { enqueueTaskGenerate });
      await new Promise((r) => setTimeout(r, 20));
      expect(enqueued).toHaveLength(1);
    });

    it("STORY-052 scenario 11 · a finding BELOW its rule's task threshold enqueues nothing (AUX-R-004 absent is low, its threshold is medium)", async () => {
      const enqueueTaskGenerate = vi.fn<Enqueue>(async () => undefined);
      await runAsTenant(noLlms, { enqueueTaskGenerate });
      expect((await findings())[0]).toMatchObject({ rule_code: "AUX-R-004", severity: "low" });
      await new Promise((r) => setTimeout(r, 20));
      expect(enqueueTaskGenerate).not.toHaveBeenCalled();
    });

    it("STORY-052 scenario 11 · a re-detection of a finding already known enqueues nothing more", async () => {
      const enqueueTaskGenerate = vi.fn<Enqueue>(async () => undefined);
      await runAsTenant(healthy(BLOCKED), { enqueueTaskGenerate });
      await vi.waitFor(() => expect(enqueueTaskGenerate).toHaveBeenCalledTimes(1));
      await runAsTenant(healthy(BLOCKED), { enqueueTaskGenerate });
      await new Promise((r) => setTimeout(r, 20));
      expect(enqueueTaskGenerate).toHaveBeenCalledTimes(1);
    });

    it("STORY-052 scenario 11 · a regression that RAISES the finding to its threshold enqueues (low becomes medium, threshold medium)", async () => {
      const enqueueTaskGenerate = vi.fn<Enqueue>(async () => undefined);
      await runAsTenant(noLlms, { enqueueTaskGenerate });
      await runAsTenant(healthy(OPEN), { enqueueTaskGenerate });
      await runAsTenant(noLlms, { enqueueTaskGenerate });
      expect((await findings())[0]).toMatchObject({ status: "regressed", severity: "medium" });
      await vi.waitFor(() => expect(enqueueTaskGenerate).toHaveBeenCalledTimes(1));
    });

    it("STORY-052 scenario 11 · a failed enqueue is counted and logged, and never fails the audit (the findings are durable)", async () => {
      const enqueueTaskGenerate: Enqueue = async () => { throw new Error("valkey down"); };
      await runAsTenant(healthy(BLOCKED), { enqueueTaskGenerate });
      expect((await audits())[0]!.status).toBe("completed");
      expect(await findings()).toHaveLength(1);
      await vi.waitFor(() => expect(counters.some((c) => c.name === "nominara_aux_taskgen_request_failed_total")).toBe(true));
    });

    it("STORY-052 scenario 12 · closing a critical finding pins an aux_status_change milestone sourced to the finding", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(healthy(OPEN));
      const [f] = await findings();
      const pins = await milestones();
      expect(pins).toHaveLength(1);
      expect(pins[0]).toMatchObject({ kind: "aux_status_change", source_type: "aux_finding", source_id: f.id, severity: "positive", project_id: projectId, workspace_id: workspaceId });
      expect(pins[0].occurred_at).toEqual(f.resolved_at);
    });

    it("STORY-052 scenario 12 · closing a LOW finding pins nothing", async () => {
      await runAsTenant(noLlms);
      await runAsTenant(healthy(OPEN));
      expect(await statusOf()).toEqual(["resolved"]);
      expect(await milestones()).toHaveLength(0);
    });

    it("STORY-052 scenario 12 · a stale finding is not a closure: no milestone", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(robotsDown);
      await runAsTenant(robotsDown);
      expect(await milestones()).toHaveLength(0);
    });

    it("STORY-052 scenario 12 · resolve, regress, resolve again keeps ONE pin per finding (ux_milestones_source), and does not fail the audit", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(healthy(OPEN));
      await runAsTenant(healthy(BLOCKED));
      expect(await statusOf()).toEqual(["regressed"]);
      await runAsTenant(healthy(OPEN));
      expect(await statusOf()).toEqual(["resolved"]);
      expect(await milestones()).toHaveLength(1);
      expect((await audits()).at(-1)!.status).toBe("completed");
    });

    // ---- STORY-053 -------------------------------------------------------------------------------------------------------
    const BLOCKED_TWO = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n";
    const patchRows = async (): Promise<any[]> => (await db.query("SELECT * FROM patches ORDER BY created_at, id")).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    const sha = (s: string): Buffer => createHash("sha256").update(s).digest();
    const service = new AuxService();
    const readPatch = async (id: string): Promise<AuxPatch> => {
      const client = await pool.connect();
      try {
        let out!: AuxPatch;
        await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async () => { out = await service.getPatch(id); });
        return out;
      } finally {
        client.release();
      }
    };
    const readFindings = async (): Promise<AuxFinding[]> => {
      const client = await pool.connect();
      try {
        let out: AuxFinding[] = [];
        await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async () => { out = [...(await service.listProjectFindings(projectId, { limit: 50 })).items]; });
        return out;
      } finally {
        client.release();
      }
    };

    it("STORY-053 scenario 1 · a blocked robots.txt gets a robots patch: written by the audit, with its provenance, reversal and the hash of the file it was made from", async () => {
      await runAsTenant(healthy(BLOCKED));
      const [f] = await findings();
      const rows = await patchRows();
      expect(rows).toHaveLength(1);
      const [patch] = rows;
      expect(patch).toMatchObject({
        workspace_id: workspaceId, project_id: projectId, finding_id: f.id, rule_code: "AUX-R-001", kind: "robots", target_url: "https://acme.com/robots.txt",
        requires_human_review: false, review_reason: null, created_by: null,
      });
      expect(patch.content_after).toBe(`${BLOCKED}\nUser-agent: GPTBot\nAllow: /\n`);
      expect(patch.reversal).toEqual({ operation: "remove_block", content: "\nUser-agent: GPTBot\nAllow: /\n" });
      expect(patch.derivation.length).toBeGreaterThan(10);
      expect(patch.explanation.length).toBeGreaterThan(10);
      const [a] = await audits();
      expect(patch.content_before_hash.equals(a.robots_hash)).toBe(true);
      expect(patch.preconditions).toEqual([{ kind: "file_hash", value: `sha256:${a.robots_hash.toString("hex")}` }]);
      expect(patch.unified_diff).toContain("+User-agent: GPTBot");
    });

    it("STORY-053 scenario 1 · an /llms.txt that answers with an error status other than 404 or 410 gets NO patch (a file may exist behind it)", async () => {
      await runAsTenant({ ...healthy(OPEN), "/llms.txt": { status: 403 }, "/.well-known/llms.txt": { status: 404 } });
      expect((await findings()).map((f) => f.rule_code)).toContain("AUX-R-004");
      expect(await patchRows()).toHaveLength(0);
    });

    it("STORY-053 scenario 1 · an /llms.txt that is absent while an invalid one sits at /.well-known/llms.txt gets NO 'there is no /llms.txt' patch", async () => {
      await runAsTenant({ ...healthy(OPEN), "/llms.txt": { status: 404 }, "/.well-known/llms.txt": { status: 200, body: "not the llms format" } });
      expect((await findings()).map((f) => f.rule_code)).toContain("AUX-R-004");
      expect(await patchRows()).toHaveLength(0);
    });

    it("STORY-053 scenario 1 · the patch is on the finding, free, and the page still matches", async () => {
      await runAsTenant(healthy(BLOCKED));
      const [f] = await readFindings();
      expect(f!.patch).toMatchObject({ kind: "robots", free: true, credits_charged: 0, page_matches: true, earlier_patch_ids: [] });
      expect(f!.guidance).toBeNull();
      expect((await readPatch(f!.patch!.patch_id)).content_after).toContain("Allow: /");
    });

    it("STORY-053 scenario 11 · generating a patch charges nothing: the audit writes no credit ledger row", async () => {
      const before = (await db.query("SELECT count(*)::int AS n FROM credit_ledger")).rows[0].n;
      await runAsTenant(healthy(BLOCKED));
      expect(await patchRows()).toHaveLength(1);
      expect((await db.query("SELECT count(*)::int AS n FROM credit_ledger")).rows[0].n).toBe(before);
    });

    it("STORY-053 scenario 8 · the same defect in the next audit writes NO second patch, and a changed file writes a NEW one that leaves the first untouched", async () => {
      await runAsTenant(healthy(BLOCKED));
      await runAsTenant(healthy(BLOCKED));
      expect(await patchRows()).toHaveLength(1);
      const [first] = await patchRows();
      await runAsTenant(healthy(BLOCKED_TWO));
      const rows = await patchRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(first);
      expect(rows[1].content_after).toContain("User-agent: ClaudeBot\nAllow: /\n");
      const [f] = await readFindings();
      expect(f!.patch).toMatchObject({ patch_id: rows[1].id, earlier_patch_ids: [first.id] });
      expect((await readPatch(first.id)).content_after).toBe(first.content_after);
    });

    it("STORY-053 scenario 9 · after the customer changes robots.txt the old patch reads page_matches false, and an unreadable robots.txt reads null", async () => {
      await runAsTenant(healthy(BLOCKED));
      const [first] = await patchRows();
      expect((await readPatch(first.id)).page_matches).toBe(true);
      await runAsTenant(healthy(BLOCKED_TWO));
      expect((await readPatch(first.id)).page_matches).toBe(false);
      await runAsTenant(robotsDown);
      expect((await readPatch(first.id)).page_matches).toBeNull();
    });

    it("STORY-053 scenario 4 · a generator whose output would not do what it says is REJECTED, recorded, and does not abort the audit or its findings", async () => {
      // `Disallow: /*` outranks an `Allow: /`, so opening GPTBot with an Allow block cannot work: the gate refuses rather than offering it.
      await runAsTenant(healthy("User-agent: GPTBot\nDisallow: /*\n"));
      expect((await audits())[0]!.status).toBe("completed");
      expect(await findings()).toHaveLength(1);
      expect(await patchRows()).toHaveLength(0);
      expect(counters.some((c) => c.name === "nominara_aux_patch_rejected_total" && c.labels.reason === "ineffective")).toBe(true);
    });

    it("STORY-053 scenario 10 · AUX-R-003 (robots.txt malformed) has no patch: the finding carries guidance and an alignment link instead", async () => {
      await runAsTenant(healthy("User-agent: *\nAllow: /\nthis line is not a directive\n"));
      const [f] = await findings();
      expect(f.rule_code).toBe("AUX-R-003");
      expect(await patchRows()).toHaveLength(0);
      const [read] = await readFindings();
      expect(read!.patch).toBeNull();
      expect(read!.guidance!.steps.length).toBeGreaterThan(0);
      expect(read!.guidance!.alignment_link).toEqual({ path: "/geo/alignment", target_url: "https://acme.com/robots.txt" });
    });

    it("STORY-053 scenario 1 · a missing llms.txt gets a markdown patch built from the site's own sitemap, valid by the rule's own check", async () => {
      await runAsTenant(noLlms);
      const rows = await patchRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "markdown", rule_code: "AUX-R-004", target_url: "https://acme.com/llms.txt", preconditions: [{ kind: "file_absent", value: null }] });
      expect(rows[0].reversal).toEqual({ operation: "delete_file", content: null });
      expect(rows[0].content_before_hash.equals(sha(""))).toBe(true);
      expect(rows[0].content_after).toContain("# P");
      expect(rows[0].content_after).toContain("(https://acme.com/)");
      expect((await readPatch(rows[0].id)).page_matches).toBe(true);
      // The audit that finds the file now present says the precondition no longer holds.
      await runAsTenant(healthy(OPEN));
      expect((await readPatch(rows[0].id)).page_matches).toBe(false);
    });

    it("STORY-053 · a finding the customer set to will-not-fix is not worked on: no new patch for it", async () => {
      await runAsTenant(healthy(BLOCKED));
      await db.query("UPDATE aux_findings SET status = 'wont_fix', wont_fix_reason = 'accepted'");
      await runAsTenant(healthy(BLOCKED_TWO));
      expect(await patchRows()).toHaveLength(1);
    });

    it("STORY-053 · the patch is written in the job's tenant context: another workspace cannot see it", async () => {
      await runAsTenant(healthy(BLOCKED));
      const [patch] = await patchRows();
      const wsB = (await db.query("INSERT INTO workspaces (name, slug, plan_key) VALUES ('B','w-c9-b53','free') RETURNING id")).rows[0].id as string;
      const client = await pool.connect();
      try {
        await withTenantContext(client, { workspaceId: wsB, actorId: SYSTEM_ACTOR_ID }, async () => {
          expect((await client.query("SELECT id FROM patches WHERE id = $1", [patch.id])).rows).toHaveLength(0);
        });
      } finally {
        client.release();
      }
    });

    // STORY-053 AC1 end to end: a page-level finding (AUX-R-014) produces a stored, immutable, copy-ready patch.
    const NO_FEATURES_PAGE = HEALTHY_PAGE.replace('"featureList":["Pipeline analytics","Workflow automation"],', "");
    it("STORY-053 AC1 · a crawled page whose AUX-R-014 fires gets a jsonld patch written in the tenant transaction, linked to its finding, free and with a page_hash precondition", async () => {
      expect(NO_FEATURES_PAGE).not.toContain("featureList");
      await runAsTenant({ ...healthy(OPEN), "/": { status: 200, body: NO_FEATURES_PAGE } });
      const finding = (await findings()).find((f) => f.rule_code === "AUX-R-014");
      expect(finding).toBeDefined();
      const rows = (await patchRows()).filter((p) => p.rule_code === "AUX-R-014");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "jsonld", finding_id: finding.id, target_url: "https://acme.com/", requires_human_review: false });
      expect(rows[0].content_before_hash.equals(sha(NO_FEATURES_PAGE))).toBe(true);
      expect(rows[0].preconditions).toEqual([{ kind: "page_hash", value: `sha256:${sha(NO_FEATURES_PAGE).toString("hex")}` }]);
      expect(rows[0].jsonld_blocks[0].featureList).toEqual(["Pipeline analytics", "Workflow automation"]);
      expect(counters).toContainEqual({ name: "nominara_aux_patches_generated_total", labels: { kind: "jsonld", rule_code: "AUX-R-014" } });
      expect((await db.query("SELECT count(*)::int AS n FROM credit_ledger")).rows[0].n).toBe(0);
    });

    it("STORY-053 AC8 · re-detecting the same finding on the same page writes no second patch; a changed page writes a new one and keeps the first", async () => {
      const served = { ...healthy(OPEN), "/": { status: 200, body: NO_FEATURES_PAGE } };
      await runAsTenant(served);
      await runAsTenant(served);
      expect((await patchRows()).filter((p) => p.rule_code === "AUX-R-014")).toHaveLength(1);
      await runAsTenant({ ...served, "/": { status: 200, body: NO_FEATURES_PAGE.replace("See every deal.", "See every deal today.") } });
      const rows = (await patchRows()).filter((p) => p.rule_code === "AUX-R-014");
      expect(rows).toHaveLength(2);
      expect(rows[0].id).not.toBe(rows[1].id);
    });

    it("STORY-053 AC5 · a page generator that refuses its own output is counted and offers no patch, and the finding and the audit stand", async () => {
      const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${String(i)} is about widgets.`).join(" ");
      const bare = HEALTHY_PAGE.replace(/<h1>[\s\S]*<\/main>/, `<p>${sentences}</p></main>`);
      await runAsTenant({ ...healthy(OPEN), "/": { status: 200, body: bare } });
      expect((await findings()).some((f) => f.rule_code === "AUX-R-023")).toBe(true);
      expect((await patchRows()).filter((p) => p.rule_code === "AUX-R-023")).toHaveLength(0);
      expect(counters).toContainEqual({ name: "nominara_aux_patch_rejected_total", labels: { reason: "no_heading" } });
      expect((await audits())[0]).toMatchObject({ status: "completed" });
    });

    it("STORY-053 · generation makes no network call and holds no I/O: the patch modules import nothing that can fetch", () => {
      const dir = new URL("../../src/lib/aux/patches/", import.meta.url);
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
        const src = readFileSync(new URL(file, dir), "utf8");
        expect(src, file).not.toMatch(/guarded-fetch|node:http|node:https|node:net|node:dns|\bfetch\(|storage|\bpg\b/);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  // STORY-051 AC13 / STORY-052 AC1, AC9 (owner decision 34, item 2) - the page rules run inside crawl.audit
  // ------------------------------------------------------------------------------------------------------------------
  describe("AUXLIVE-2 · the page rule engine is wired into crawl.audit", () => {
    const NOT_EVALUATED = ["AUX-R-005", "AUX-R-028", "AUX-R-031", "AUX-R-032", "AUX-R-033", "AUX-R-034"];
    const SITE_RULES = ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007"];
    const weightOf = async (code: string): Promise<number> => Number((await db.query("SELECT weight FROM aux_rule_catalog WHERE code = $1", [code])).rows[0].weight);
    const withPages = (pages: Record<string, string>): Served => ({
      ...healthy(OPEN),
      "/sitemap.xml": { status: 200, body: `<urlset>${Object.keys(pages).map((p) => `<url><loc>https://acme.com${p}</loc></url>`).join("")}</urlset>` },
      ...Object.fromEntries(Object.entries(pages).map(([path, body]) => [path, { status: 200, body }])),
    });

    it("STORY-051 AC13 · a crawled page produces a page-rule finding: AUX-R-008 on a broken JSON-LD block, with the URL, the evidence shape and the catalog rule version", async () => {
      await run(job(), depsServing({ ...healthy(OPEN), "/": { status: 200, body: BROKEN_PAGE } }));
      const f = (await findings()).filter((x) => x.rule_code === "AUX-R-008");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ url: "https://acme.com/", severity: "critical", status: "open", occurrence_count: 1 });
      expect(Object.keys(f[0].evidence).sort()).toEqual(["locator", "reason", "snippet"]);
      const version = (await db.query("SELECT rule_version, title FROM aux_rule_catalog WHERE code = 'AUX-R-008'")).rows[0];
      expect(f[0].rule_version).toBe(version.rule_version);
      expect(f[0].title).toBe(version.title);
      expect(f[0].fingerprint).toHaveLength(32);
      const [a] = await audits();
      expect(a).toMatchObject({ status: "completed", findings_critical: 1 });
    });

    it("STORY-051 AC13 · a healthy page produces no finding from any rule, and the audit completes", async () => {
      await run(job(), depsServing(healthy(OPEN)));
      expect(await findings()).toEqual([]);
      expect((await audits())[0]).toMatchObject({ status: "completed", pages_crawled: 1 });
    });

    it("STORY-051 AC13 · excluded_rules drops the page rules that ran, and keeps AUX-R-029 (no measured timing) and every not-evaluated code", async () => {
      await run(job(), depsServing(healthy(OPEN)));
      const excluded: string[] = (await audits())[0].excluded_rules;
      expect([...excluded].sort()).toEqual([...NOT_EVALUATED, "AUX-R-029"].sort());
      for (const ran of [...SITE_RULES, "AUX-R-006", "AUX-R-008", "AUX-R-026", "AUX-R-027"]) expect(excluded, ran).not.toContain(ran);
      expect(excluded).not.toContain("page_crawl");
    });

    it("STORY-051 AC13 · with no renderer installed (no rendered copy) AUX-R-026 and AUX-R-027 stay excluded as well", async () => {
      await run(job(), depsServing(healthy(OPEN), [], 10_000, { renderer: unavailableRenderer }));
      const excluded: string[] = (await audits())[0].excluded_rules;
      expect([...excluded].sort()).toEqual([...NOT_EVALUATED, "AUX-R-026", "AUX-R-027", "AUX-R-029"].sort());
    });

    it("STORY-051 AC13 · a measured response time brings AUX-R-029 back into the evaluated rules", async () => {
      const timed = depsServing(healthy(OPEN));
      const inner = timed.fetch!;
      await run(job(), { ...timed, fetch: async (url, init) => ({ ...(await inner(url, init)), ttfbMs: 40, loadMs: 90 }) });
      const excluded: string[] = (await audits())[0].excluded_rules;
      expect(excluded).not.toContain("AUX-R-029");
      expect([...excluded].sort()).toEqual([...NOT_EVALUATED].sort());
    });

    it("STORY-051 AC13 · AUX_RULES_PARTIAL is surfaced as its own annotation: error_summary.rules_partial names the partly-checked rules that ran, not the ones that were excluded", async () => {
      await run(job(), depsServing(healthy(OPEN)));
      const partial: string[] = (await audits())[0].error_summary.rules_partial;
      expect(partial).toEqual(expect.arrayContaining(["AUX-R-006", "AUX-R-013", "AUX-R-016", "AUX-R-017", "AUX-R-018", "AUX-R-019", "AUX-R-020", "AUX-R-023", "AUX-R-025", "AUX-R-026", "AUX-R-027"]));
      expect(partial).not.toContain("AUX-R-029"); // no timing: it did not run, so it is excluded, not partial
            expect(partial).toEqual([...partial].sort());
      expect(new Set(partial).size).toBe(partial.length);
    });

    it("STORY-051 AC13 · a site-files-only audit (the page was never fetched) names every page rule as excluded and carries no rules_partial", async () => {
      await run(job(), depsServing({ ...healthy(OPEN), "/": "throw" }));
      const [a] = await audits();
      expect(a.pages_crawled).toBe(0);
      expect(a.excluded_rules).toEqual(expect.arrayContaining(["AUX-R-008", "AUX-R-006", "AUX-R-026", "AUX-R-029", "page_crawl", ...NOT_EVALUATED]));
      expect(a.excluded_rules).not.toContain("AUX-R-001");
      expect(a.error_summary?.rules_partial).toBeUndefined();
      expect(a.aux_score).toBeNull();
    });

    it("STORY-052 AC1 · a clean site publishes a subscore of 1 for each category that ran - five; entity_clarity, with no evaluated rule, is absent rather than a made-up 1 - and a partial headline", async () => {
      await run(job(), depsServing(healthy(OPEN)));
      const [a] = await audits();
      expect(Object.keys(a.score_breakdown).sort()).toEqual(["context_fitness", "crawler_access", "freshness", "render_mode", "structured_data"]);
      for (const v of Object.values(a.score_breakdown)) expect(Number(v)).toBe(1);
      expect(Number(a.aux_score)).toBe(100); // decision 38: over the five measured categories, renormalised; the API labels it partial
      expect(a.score_capped).toBe(false);
    });

    it("STORY-052 AC1 · render_mode is published only when a render-mode rule could be decided: with no renderer and no timing, none could, so it is absent", async () => {
      await run(job(), depsServing(healthy(OPEN), [], 10_000, { renderer: unavailableRenderer }));
      const [a] = await audits();
      expect(Object.keys(a.score_breakdown).sort()).toEqual(["context_fitness", "crawler_access", "freshness", "structured_data"]);
    });

    it("STORY-052 AC1 · the subscore is scoring-models.md section 7: the AUX-R-008 critical finding takes its catalog weight off structured_data; no other category moves", async () => {
      await run(job(), depsServing({ ...healthy(OPEN), "/": { status: 200, body: BROKEN_PAGE } }));
      const [a] = await audits();
      const w = await weightOf("AUX-R-008");
      // decision 52: over structured_data's DECIDED rules (every structured_data rule is decided since STORY-187)
      const decided = DECIDED.structuredData;
      expect(Number(a.score_breakdown.structured_data)).toBeCloseTo(1 - w / decided, 5);
      for (const c of ["crawler_access", "context_fitness", "freshness", "render_mode"]) expect(Number(a.score_breakdown[c]), c).toBe(1);
      expect(a.score_capped).toBe(false); // the cap is for a critical crawler_access finding only
    });

    it("STORY-052 AC9 · affected page counts feed the scope factor: one broken page of three weighs 1/3, two of three weigh 2/3", async () => {
      await verifyDomain();
      const w = await weightOf("AUX-R-008");
      await run(job(), depsServing(withPages({ "/": BROKEN_PAGE, "/pricing": HEALTHY_PAGE, "/about": HEALTHY_PAGE })));
      let [a] = await audits();
      expect(a.pages_crawled).toBe(3);
      const decided = DECIDED.structuredData; // decision 52
      expect(Number(a.score_breakdown.structured_data)).toBeCloseTo(1 - (w * (1 / 3)) / decided, 5);

      await db.query("TRUNCATE aux_audits CASCADE");
      stored.clear();
      await run(job(), depsServing(withPages({ "/": BROKEN_PAGE, "/pricing": BROKEN_PAGE, "/about": HEALTHY_PAGE })));
      [a] = await audits();
      expect(Number(a.score_breakdown.structured_data)).toBeCloseTo(1 - (w * (2 / 3)) / decided, 5);
    });

    it("STORY-052 AC9 · the scope factor is floored at 0.25: one broken page of ten is not diluted below it", async () => {
      await verifyDomain();
      const w = await weightOf("AUX-R-008");
      const pages: Record<string, string> = { "/": BROKEN_PAGE };
      for (let i = 1; i < 10; i += 1) pages[`/p${i}`] = HEALTHY_PAGE;
      await run(job(), depsServing(withPages(pages), [], 10_000, { pageCap: 25 }));
      const [a] = await audits();
      expect(a.pages_crawled).toBe(10);
      expect(Number(a.score_breakdown.structured_data)).toBeCloseTo(1 - (w * 0.25) / DECIDED.structuredData, 5); // decision 52
    });

    it("STORY-052 AC4 · the same page defect in two audits is ONE finding with occurrence_count 2; fixing the page resolves it (with a milestone), and it regresses if it returns", async () => {
      const broken: Served = { ...healthy(OPEN), "/": { status: 200, body: BROKEN_PAGE } };
      await run(job(), depsServing(broken));
      await run(job(), depsServing(broken));
      let f = (await findings()).filter((x) => x.rule_code === "AUX-R-008");
      expect(f).toHaveLength(1);
      expect(f[0].occurrence_count).toBe(2);

      await run(job(), depsServing(healthy(OPEN)));
      f = (await findings()).filter((x) => x.rule_code === "AUX-R-008");
      expect(f[0]).toMatchObject({ status: "resolved" });
      expect(f[0].resolved_at).not.toBeNull();
      const pinned = await db.query("SELECT kind FROM milestones WHERE source_type = 'aux_finding' AND source_id = $1", [f[0].id]);
      expect(pinned.rows).toEqual([{ kind: "schema_fixed" }]);

      await run(job(), depsServing(broken));
      f = (await findings()).filter((x) => x.rule_code === "AUX-R-008");
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ status: "regressed", severity: "critical" });
      expect(f[0].regressed_at).not.toBeNull();
    });

    it("STORY-052 AC5 · a page the audit could not fetch resolves nothing: its earlier finding stays open", async () => {
      await run(job(), depsServing({ ...healthy(OPEN), "/": { status: 200, body: BROKEN_PAGE } }));
      await run(job(), depsServing({ ...healthy(OPEN), "/": { status: 500, body: "" } }));
      const f = (await findings()).filter((x) => x.rule_code === "AUX-R-008");
      expect(f).toHaveLength(1);
      expect(f[0].status).toBe("open");
      expect(f[0].resolved_at).toBeNull();
    });

    it("STORY-052 AC5 · a finding on a rule the page could not decide (AUX-R-026/027 with no rendered copy) is neither resolved nor opened by an audit that could not look", async () => {
      // Seed an open AUX-R-026 finding on the page, then audit with no renderer: the rule was undecidable, so the finding must survive.
      await run(job(), depsServing(healthy(OPEN)));
      await db.query(
        `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, url, severity, fingerprint, title, evidence, rule_version, first_detected_at, last_detected_at)
         SELECT workspace_id, project_id, id, 'AUX-R-026', 'https://acme.com/', 'high', sha256('seed'::bytea), 't', '{"reason":"seed","snippet":null,"locator":"x"}'::jsonb, '2026.10.2', now(), now() FROM aux_audits LIMIT 1`,
      );
      await run(job(), depsServing(healthy(OPEN), [], 10_000, { renderer: unavailableRenderer }));
      const seeded = (await findings()).find((x) => x.rule_code === "AUX-R-026")!;
      expect(seeded.status).toBe("open");
    });

    it("STORY-049 scenario 10 / STORY-048 · an unverified domain is audited at public-surface scope: only the supplied URL is judged, the sitemap's other pages are not, and the excluded rules are named", async () => {
      const served = withPages({ "/": HEALTHY_PAGE, "/pricing": BROKEN_PAGE });
      await run(job(), depsServing(served));
      const [a] = await audits();
      expect(a.scope).toBe("public_surface");
      expect(a.pages_crawled).toBe(1);
      expect((await findings()).filter((x) => x.rule_code === "AUX-R-008")).toEqual([]);
      expect(a.excluded_rules).toEqual(expect.arrayContaining(NOT_EVALUATED));
    });

    it("STORY-049 scenario 10 / STORY-048 · a verified domain is judged page by page: the broken sibling page is found at its own URL", async () => {
      await verifyDomain();
      await run(job(), depsServing(withPages({ "/": HEALTHY_PAGE, "/pricing": BROKEN_PAGE })));
      const f = (await findings()).filter((x) => x.rule_code === "AUX-R-008");
      expect(f.map((x) => x.url)).toEqual(["https://acme.com/pricing"]);
    });

    it("STORY-051 AC13 · observability: the audit log line counts the page findings and the pages evaluated, carries the workspace id, and no page text", async () => {
      const lines: unknown[] = [];
      const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => { lines.push(m); });
      try {
        await run(job(), depsServing({ ...healthy(OPEN), "/": { status: 200, body: BROKEN_PAGE } }));
      } finally {
        spy.mockRestore();
      }
      const line = lines.find((l) => (l as { span?: string }).span === "crawl.audit") as Record<string, unknown>;
      expect(line).toMatchObject({ workspace_id: workspaceId, pages_evaluated: 1, page_findings: expect.any(Number) });
      expect(line.page_findings as number).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(lines)).not.toContain("Pipeline analytics");
      // review round 1: ONE observation per audit carrying the count (not one counter line per page)
      const observed = lines.filter((l) => (l as { metric?: string }).metric === "nominara_aux_pages_evaluated_count");
      expect(observed).toEqual([{ metric: "nominara_aux_pages_evaluated_count", value: 1, trigger: "onboarding" }]);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  // AUXLIVE-3 (STORY-194) - a manual audit was charged by its producer: a failed audit gives the charge back, a partial one keeps it
  // ------------------------------------------------------------------------------------------------------------------
  describe("AUXLIVE-3 · crawl.audit and the manual audit's charge", () => {
    const wallet = async () => {
      const r = (await db.query("SELECT included_balance, purchased_balance, reserved FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
      return { included: Number(r.included_balance), purchased: Number(r.purchased_balance), reserved: Number(r.reserved) };
    };
    const refunds = async () => (await db.query("SELECT credits::int AS credits, reference_type, reference_id FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'refund'", [workspaceId])).rows;

    /** What POST /projects/{id}/aux-audits leaves behind: a charged 10 credits and a queued row. */
    async function chargedManualAudit(): Promise<string> {
      await db.query(
        `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
         VALUES ($1,100,(now() AT TIME ZONE 'UTC')::date,(now() AT TIME ZONE 'UTC')::date + 30)`,
        [workspaceId],
      );
      const auditId = randomUUID();
      const { debitInTransaction } = await import("../../src/lib/credits/debit.js");
      // The debit and the refund use savepoints, which need a transaction: the producer's request and the job's tenant context are both one.
      await db.query("BEGIN");
      await debitInTransaction(db as never, {
        workspaceId, actorId: null, actorType: "system", actionCode: "aux_manual", credits: 10, idempotencyKey: ["aux_audit", auditId].join(":"),
        projectId, referenceType: "aux_audit", referenceId: auditId, includedGrant: 0,
      });
      await db.query("COMMIT");
      await db.query(
        `INSERT INTO aux_audits (id, workspace_id, project_id, trigger, scope, target_urls, rule_version, tokenizer, status)
         VALUES ($1,$2,$3,'manual','key_pages','{}','2026.10.1','cl100k','queued')`,
        [auditId, workspaceId, projectId],
      );
      return auditId;
    }
    const manualJob = (auditId: string): Job => job({ trigger: "manual", auditId, scope: "key_pages" });
    /** The job runs in a tenant transaction in production (withTenantJob); the harness hands the handler a bare client, so wrap the run in one. */
    // Production runs every phase inside withTenantJob, i.e. with the job's workspace set for the transaction; the write that fails an audit is confined to it.
    const inTenant = (): Promise<unknown> => db.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const runTx = async (j: Job, deps: CrawlAuditDeps): Promise<void> => {
      await db.query("BEGIN");
      await inTenant();
      try {
        await run(j, deps);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    };

    it("AUXLIVE-3 · a manual audit takes over the queued row its producer made: same id, now completed, and the charge STANDS", async () => {
      const auditId = await chargedManualAudit();
      await runTx(manualJob(auditId), depsServing(healthy(OPEN)));
      const all = await audits();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: auditId, trigger: "manual", status: "completed" });
      expect(await refunds()).toEqual([]);
      expect(await wallet()).toMatchObject({ included: 90 });
    });

    it("AUXLIVE-3 · a manual audit where NO site file can be reached ends failed and the charge is refunded in full, naming the audit", async () => {
      const auditId = await chargedManualAudit();
      await runTx(manualJob(auditId), depsServing({}));
      const [a] = await audits();
      expect(a).toMatchObject({ id: auditId, status: "failed" });
      expect(await refunds()).toEqual([{ credits: 10, reference_type: "aux_audit", reference_id: auditId }]);
      expect(await wallet()).toMatchObject({ included: 100, reserved: 0 });
    });

    it("AUXLIVE-3 · redelivering the failed job refunds nothing more", async () => {
      const auditId = await chargedManualAudit();
      await runTx(manualJob(auditId), depsServing({}));
      await runTx(manualJob(auditId), depsServing({}));
      expect(await refunds()).toHaveLength(1);
      expect(await wallet()).toMatchObject({ included: 100 });
    });

    it("AUXLIVE-3 · a PARTIAL manual audit (a page failed, the site files answered) is charged in full: no refund", async () => {
      const auditId = await chargedManualAudit();
      await verifyDomain();
      await runTx(manualJob(auditId), depsServing({ ...withSitemap(SITEMAP_PAGES), "/pricing": { status: 500, body: "" } }));
      const [a] = await audits();
      expect(a.status).toBe("partial");
      expect(await refunds()).toEqual([]);
      expect(await wallet()).toMatchObject({ included: 90 });
    });

    it("AUXLIVE-3 · an ONBOARDING audit that fails touches no ledger at all: it was never charged", async () => {
      await db.query(
        `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
         VALUES ($1,100,(now() AT TIME ZONE 'UTC')::date,(now() AT TIME ZONE 'UTC')::date + 30)`,
        [workspaceId],
      );
      await runTx(job({ trigger: "onboarding" }), depsServing({}));
      expect((await audits())[0].status).toBe("failed");
      expect((await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [workspaceId])).rowCount).toBe(0);
    });

    it("AUXLIVE-3 · a manual audit whose project was deleted before it ran is failed and refunded, and nothing is fetched", async () => {
      const auditId = await chargedManualAudit();
      await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [projectId]);
      const requested: string[] = [];
      await runTx(manualJob(auditId), depsServing(healthy(OPEN), requested));
      expect(requested).toEqual([]);
      expect((await audits())[0]).toMatchObject({ id: auditId, status: "failed" });
      expect((await audits())[0].error_summary).toEqual({ reason: "project_deleted" });
      expect(await refunds()).toHaveLength(1);
      expect(await wallet()).toMatchObject({ included: 100 });
    });

    it("AUXLIVE-3 · the audit counter carries the manual trigger", async () => {
      const auditId = await chargedManualAudit();
      await runTx(manualJob(auditId), depsServing(healthy(OPEN)));
      expect(counters).toContainEqual({ name: "nominara_aux_audits_total", labels: { status: "completed", trigger: "manual" } });
    });
  });


  // ------------------------------------------------------------------------------------------------------------------
  // AUXLIVE review round 1 - staleness per page, the partial headline (decision 38), a manual audit that must not be refunded twice
  // ------------------------------------------------------------------------------------------------------------------
  describe("AUXLIVE review round 1", () => {
    const withPages = (pages: Record<string, string>): Served => ({
      ...healthy(OPEN),
      "/sitemap.xml": { status: 200, body: `<urlset>${Object.keys(pages).map((p) => `<url><loc>https://acme.com${p}</loc></url>`).join("")}</urlset>` },
      ...Object.fromEntries(Object.entries(pages).map(([path, body]) => [path, { status: 200, body }])),
    });
    const weightOf = async (code: string): Promise<number> => Number((await db.query("SELECT weight FROM aux_rule_catalog WHERE code = $1", [code])).rows[0].weight);
    const r008 = async () => (await findings()).filter((f) => f.rule_code === "AUX-R-008");
    const milestoneCount = async (): Promise<number> => (await db.query("SELECT count(*)::int AS n FROM milestones")).rows[0].n;
    const PAGES = { "/": HEALTHY_PAGE, "/pricing": BROKEN_PAGE };

    it("STORY-052 AC8 · a page finding whose page FAILS to fetch is still open after one audit, and STALE after two - not resolved, not open for ever - and it keeps scoring", async () => {
      await verifyDomain();
      await run(job(), depsServing(withPages(PAGES)));
      expect((await r008()).map((f) => f.status)).toEqual(["open"]);
      const scored = Number((await audits()).at(-1).score_breakdown.structured_data);
      const down = { ...withPages(PAGES), "/pricing": { status: 500, body: "" } } satisfies Served;
      await run(job(), depsServing(down));
      expect((await r008()).map((f) => f.status)).toEqual(["open"]);
      await run(job(), depsServing(down));
      const [f] = await r008();
      expect(f.status).toBe("stale");
      expect(f.resolved_at).toBeNull();
      expect(await milestoneCount()).toBe(0);
      // stale is not fixed: the subscore still carries the penalty (at the floor scope, since the page was not looked at in this audit)
      expect(Number((await audits()).at(-1).score_breakdown.structured_data)).toBeLessThan(1);
      expect(scored).toBeLessThan(1);
    });

    it("STORY-052 AC8 · a page finding whose page is no longer SELECTED (gone from the sitemap) goes stale after two audits, not resolved", async () => {
      await verifyDomain();
      await run(job(), depsServing(withPages(PAGES)));
      const without = withPages({ "/": HEALTHY_PAGE });
      await run(job(), depsServing(without));
      await run(job(), depsServing(without));
      expect((await r008()).map((f) => f.status)).toEqual(["stale"]);
    });

    it("STORY-052 AC8 · one audit that did not see the page between two that did does NOT make it stale (two CONSECUTIVE audits are required)", async () => {
      await verifyDomain();
      const down = { ...withPages(PAGES), "/pricing": { status: 500, body: "" } } satisfies Served;
      await run(job(), depsServing(withPages(PAGES)));
      await run(job(), depsServing(down));
      await run(job(), depsServing(withPages(PAGES)));
      const [f] = await r008();
      expect(f.status).toBe("open");
      expect(f.occurrence_count).toBe(2);
    });

    it("STORY-052 AC8 · a stale page finding that its page then shows fixed is RESOLVED; one that it shows broken again is reopened on the same row", async () => {
      await verifyDomain();
      const down = { ...withPages(PAGES), "/pricing": { status: 500, body: "" } } satisfies Served;
      await run(job(), depsServing(withPages(PAGES)));
      await run(job(), depsServing(down));
      await run(job(), depsServing(down));
      await run(job(), depsServing(withPages(PAGES)));
      expect((await r008()).map((f) => f.status)).toEqual(["open"]);
      expect(await r008()).toHaveLength(1);
      await run(job(), depsServing(down));
      await run(job(), depsServing(down));
      await run(job(), depsServing(withPages({ "/": HEALTHY_PAGE, "/pricing": HEALTHY_PAGE })));
      expect((await r008()).map((f) => f.status)).toEqual(["resolved"]);
    });

    it("STORY-052 AC8 · the pages an audit modelled are recorded (error_summary.pages_modelled), and a site-files-only audit records none", async () => {
      await verifyDomain();
      await run(job(), depsServing(withPages(PAGES)));
      expect([...(await audits()).at(-1).error_summary.pages_modelled].sort()).toEqual(["https://acme.com/", "https://acme.com/pricing"]);
      await run(job(), depsServing({ ...healthy(OPEN), "/": "throw" }));
      expect((await audits()).at(-1).error_summary?.pages_modelled).toBeUndefined();
    });

    it("STORY-052 AC9 · affected_pages is written on each page-finding row: the distinct pages the rule is open on", async () => {
      await verifyDomain();
      await run(job(), depsServing(withPages({ "/": BROKEN_PAGE, "/pricing": BROKEN_PAGE, "/about": HEALTHY_PAGE })));
      const rows = await r008();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.affected_pages)).toEqual([2, 2]);
    });

    it("STORY-052 AC9 · the scope counts only pages THIS audit modelled: an open finding on a page not crawled now weighs the 0.25 floor, not a full page", async () => {
      await verifyDomain();
      const w = await weightOf("AUX-R-008");
      await run(job(), depsServing(withPages({ "/": HEALTHY_PAGE, "/pricing": BROKEN_PAGE })));
      await run(job(), depsServing(withPages({ "/": HEALTHY_PAGE })));
      const last = (await audits()).at(-1);
      expect(Number(last.score_breakdown.structured_data)).toBeCloseTo(1 - (w * 0.25) / DECIDED.structuredData, 5); // decision 52
    });

    it("AUXLIVE-5 · decisions 38 and 52: the headline is renormalised over the measured categories, each scored on its decided rules - one broken page of one: (0.28 + 0.22*sub + 0.20 + 0.15 + 0.06) / 0.91 * 100", async () => {
      const w = await weightOf("AUX-R-008");
      await run(job(), depsServing({ ...healthy(OPEN), "/": { status: 200, body: BROKEN_PAGE } }));
      const [a] = await audits();
      // decision 52: each category is scored on its decided rules; only structured_data has a finding here
      const sub = 1 - w / DECIDED.structuredData;
      const expected = Number((((0.28 + 0.22 * sub + 0.2 + 0.15 + 0.06) / 0.91) * 100).toFixed(1));
      expect(Number(a.aux_score)).toBe(expected);
      expect(Object.keys(a.score_breakdown).sort()).toEqual(["context_fitness", "crawler_access", "freshness", "render_mode", "structured_data"]);
    });

    it("AUXLIVE-5 · the API payload labels it partial and names the unmeasured category; each published category lists the rules that did not run in it", async () => {
      await run(job(), depsServing(healthy(OPEN)));
      const audit = await asTenantAudit();
      expect(audit).toMatchObject({ aux_score: 100, score_partial: true, unmeasured_categories: ["entity_clarity"] });
      const cats = Object.fromEntries(audit.categories.map((c) => [c.category, c.rules_not_evaluated]));
      expect(Object.keys(cats).sort()).toEqual(["context_fitness", "crawler_access", "freshness", "render_mode", "structured_data"]);
      expect(cats.crawler_access).toEqual(["AUX-R-005"]);
      // render_mode has AUX-R-028 held and (no timing) AUX-R-029 undecided: its 1.0 is NOT a full measurement, and the payload says so
      expect(cats.render_mode).toEqual(expect.arrayContaining(["AUX-R-028", "AUX-R-029"]));
      expect(cats.freshness).toEqual(["AUX-R-031"]);
      expect(cats.structured_data).toEqual([]); // AUX-R-013 is evaluated again (STORY-187)
    });

    it("AUXLIVE-5 · an audit with no score (nothing measured: a failed one) is not partial and lists every category as unmeasured", async () => {
      await run(job(), depsServing({}));
      const audit = await asTenantAudit();
      expect(audit).toMatchObject({ aux_score: null, score_partial: false, status: "failed" });
      expect(audit.unmeasured_categories).toHaveLength(6);
    });

    it("AUXLIVE-5 · a stored audit in which all six categories ran has a full score: partial false, nothing unmeasured", async () => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO aux_audits (id, workspace_id, project_id, trigger, scope, target_urls, rule_version, tokenizer, status, aux_score, score_breakdown, finished_at)
         VALUES ($1,$2,$3,'scheduled','key_pages','{}','2026.10.1','cl100k','completed',88.5,$4::jsonb,now())`,
        [id, workspaceId, projectId, JSON.stringify({ crawler_access: 1, structured_data: 1, context_fitness: 1, render_mode: 1, entity_clarity: 0.5, freshness: 1 })],
      );
      const audit = await asTenantAudit(id);
      expect(audit).toMatchObject({ aux_score: 88.5, score_partial: false, unmeasured_categories: [] });
    });

    // OWNER DECISION 52 - a category is scored on the rules that were DECIDED; the headline is partial whenever any rule went unmeasured.
    const SEVERITY_FACTOR: Record<string, number> = { critical: 1, high: 0.6, medium: 0.3, low: 0.1, info: 0 };
    const slow = (deps: CrawlAuditDeps): CrawlAuditDeps => {
      const inner = deps.fetch!;
      return { ...deps, fetch: async (url, init) => ({ ...(await inner(url, init)), ttfbMs: 9_000, loadMs: 9_500 }) };
    };

    it("D52 · with the production unavailableRenderer and a measured timing, AUX-R-026/027 are unmeasured and render_mode is NOT scored as if they had passed: it is scored on AUX-R-029 alone", async () => {
      await run(job(), slow(depsServing(healthy(OPEN), [], 10_000, { renderer: unavailableRenderer })));
      const [a] = await audits();
      const f = (await findings()).filter((x) => x.rule_code === "AUX-R-029");
      expect(f).toHaveLength(1);
      const w029 = await weightOf("AUX-R-029");
      const decided = DECIDED.renderMode029Only;
      expect(decided).toBeCloseTo(w029, 12); // 026, 027 and 028 are excluded, so 029 is the only decided rule
      const expected = 1 - (w029 * SEVERITY_FACTOR[f[0].severity]!) / decided;
      expect(Number(a.score_breakdown.render_mode)).toBeCloseTo(expected, 5);
      // the old denominator (1.000) would have said 1 - w029 * factor, i.e. nearly 1
      expect(Number(a.score_breakdown.render_mode)).toBeLessThan(1 - w029 * SEVERITY_FACTOR[f[0].severity]! - 0.01);
      expect(a.excluded_rules).toEqual(expect.arrayContaining(["AUX-R-026", "AUX-R-027", "AUX-R-028"]));
    });

    it("D52 · the headline is the decided-rule subscores renormalised over the categories that have one, and the API labels it partial and lists the unmeasured rules per category", async () => {
      await run(job(), slow(depsServing(healthy(OPEN), [], 10_000, { renderer: unavailableRenderer })));
      const [a] = await audits();
      const weights: Record<string, number> = { crawler_access: 0.28, structured_data: 0.22, context_fitness: 0.2, render_mode: 0.15, entity_clarity: 0.09, freshness: 0.06 };
      const present = Object.keys(a.score_breakdown);
      const expected = Number(((100 * present.reduce((t, c) => t + weights[c]! * Number(a.score_breakdown[c]), 0)) / present.reduce((t, c) => t + weights[c]!, 0)).toFixed(1));
      expect(Number(a.aux_score)).toBe(expected);
      const audit = await asTenantAudit();
      expect(audit.score_partial).toBe(true);
      const cats = Object.fromEntries(audit.categories.map((c) => [c.category, c.rules_not_evaluated]));
      expect(cats.render_mode).toEqual(expect.arrayContaining(["AUX-R-026", "AUX-R-027", "AUX-R-028"]));
    });

    it("D52 / STORY-187 · AUX-R-013 is decided again, so it is in the structured_data denominator: one critical AUX-R-008 weighs w008 / Σ structured_data weights (1.00)", async () => {
      await run(job(), depsServing({ ...healthy(OPEN), "/": { status: 200, body: BROKEN_PAGE } }));
      const [a] = await audits();
      expect(a.excluded_rules).not.toContain("AUX-R-013");
      expect(DECIDED.structuredData).toBe(1);
      expect(Number(a.score_breakdown.structured_data)).toBeCloseTo(1 - (await weightOf("AUX-R-008")), 5);
    });

    it("D52 · a fully measured category scores as before: context_fitness lists no unmeasured rule, its decided weights sum to 1, and a clean page is 1", async () => {
      await run(job(), depsServing(healthy(OPEN)));
      const [a] = await audits();
      expect(Number(a.score_breakdown.context_fitness)).toBe(1);
      const audit = await asTenantAudit();
      expect(audit.categories.find((c) => c.category === "context_fitness")?.rules_not_evaluated).toEqual([]);
    });

    it("D52 · a category with no decided rule is dropped (render_mode with no renderer and no timing), and the headline is still partial", async () => {
      await run(job(), depsServing(healthy(OPEN), [], 10_000, { renderer: unavailableRenderer }));
      const [a] = await audits();
      expect(Object.keys(a.score_breakdown)).not.toContain("render_mode");
      const audit = await asTenantAudit();
      expect(audit.score_partial).toBe(true);
      expect(audit.unmeasured_categories).toEqual(expect.arrayContaining(["render_mode", "entity_clarity"]));
    });

    // OWNER DECISION 55 (refines 52): a finding whose rule was NOT decided in this audit costs nothing and weighs nothing. It stays listed (stale / open, not re-checked).
    const seedFinding = async (rule: string, status: string, url: string): Promise<void> => {
      await db.query(
        `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, url, severity, status, fingerprint, title, evidence, rule_version, first_detected_at, last_detected_at)
         SELECT workspace_id, project_id, id, $1, $2, 'high', $3, sha256(($1 || $2)::bytea), 't', '{"reason":"seed","snippet":null,"locator":"x"}'::jsonb, '2026.10.2', now(), now() FROM aux_audits ORDER BY created_at LIMIT 1`,
        [rule, url, status],
      );
    };
    const NOAI_PAGE = pageWith('<meta name="robots" content="noai">');

    it("D55 (a) · an audit where every page fetch fails decides only the site-file rules: an open AUX-R-006 page finding is not in the crawler_access penalty or its denominator", async () => {
      await run(job(), depsServing({ ...healthy(OPEN), "/": { status: 200, body: NOAI_PAGE } }));
      expect((await findings()).filter((x) => x.rule_code === "AUX-R-006")).toHaveLength(1);
      await run(job(), depsServing({ ...healthy(OPEN), "/llms.txt": { status: 404 }, "/.well-known/llms.txt": { status: 404 }, "/": { status: 500, body: "" } }));
      const a = (await audits()).at(-1);
      const f006 = (await findings()).find((x) => x.rule_code === "AUX-R-006")!;
      expect(f006.status).toBe("open"); // still listed, not re-checked
      expect(a.aux_score).toBeNull(); // no page was judged
      // decided: 001 .30 + 002 .08 + 003 .12 + 004 .06 + 007 .08 = 0.64 (hand-worked). The only penalty: 004 absent, low (0.1) x 0.06, over the whole crawl (scope 1).
      expect(Number(a.score_breakdown.crawler_access)).toBeCloseTo(1 - (0.06 * 0.1) / DECIDED.crawlerAccessSiteFilesOnly, 12);
      // had the open 006 (high, .12 x .6) counted, the figure would be far lower
      expect(Number(a.score_breakdown.crawler_access)).toBeGreaterThan(0.99);
    });

    it("D55 (b) · no renderer, a stale AUX-R-026 on 1 of 4 pages and AUX-R-029 decided with a medium finding: render_mode = 1 - 0.048/0.16 = 0.70 (the stale rule is out of both the penalty and the basis)", async () => {
      await verifyDomain();
      const four = withPages({ "/": HEALTHY_PAGE, "/a": HEALTHY_PAGE, "/b": HEALTHY_PAGE, "/c": HEALTHY_PAGE });
      await run(job(), depsServing(four));
      await seedFinding("AUX-R-026", "stale", "https://acme.com/a");
      await run(job(), slow(depsServing(four, [], 10_000, { renderer: unavailableRenderer })));
      const a = (await audits()).at(-1);
      const f029 = (await findings()).filter((x) => x.rule_code === "AUX-R-029");
      expect(f029.length).toBeGreaterThan(0);
      expect(f029[0].severity).toBe("medium");
      expect((await findings()).find((x) => x.rule_code === "AUX-R-026")!.status).toBe("stale");
      // 029 weight 0.16, medium 0.3, all 4 pages slow (scope 1): penalty 0.048 over the decided 0.16 - 029 alone
      expect(Number(a.score_breakdown.render_mode)).toBeCloseTo(1 - 0.048 / DECIDED.renderMode029Only, 12);
      expect(Number(a.score_breakdown.render_mode)).toBeCloseTo(0.7, 12);
    });

    it("D55 (c) · no renderer and no timing, with only a stale AUX-R-026: render_mode is dropped and the headline is partial", async () => {
      await run(job(), depsServing(healthy(OPEN)));
      await seedFinding("AUX-R-026", "stale", "https://acme.com/");
      await run(job(), depsServing(healthy(OPEN), [], 10_000, { renderer: unavailableRenderer }));
      const [, a] = await audits();
      expect(Object.keys(a.score_breakdown)).not.toContain("render_mode");
      expect((await findings()).find((x) => x.rule_code === "AUX-R-026")!.status).toBe("stale");
      const audit = await asTenantAudit(a.id);
      expect(audit.score_partial).toBe(true);
      expect(audit.unmeasured_categories).toEqual(expect.arrayContaining(["render_mode"]));
    });

    it("D52 · the audit's rule_version is the bumped one (the formula changed)", async () => {
      await run(job(), depsServing(healthy(OPEN)));
      expect((await audits())[0].rule_version).toBe("2026.11.1");
    });

    async function asTenantAudit(id?: string) {
      const c = new Client({ connectionString: container.getConnectionUri() });
      await c.connect();
      try {
        const target = id ?? (await audits()).at(-1).id;
        return await withTenantContext(c as never, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => new AuxService().getAudit(target));
      } finally {
        await c.end();
      }
    }
  });

  describe("AUXLIVE review round 1 · a manual audit's charge and its job's fate", () => {
    const wallet = async () => {
      const r = (await db.query("SELECT included_balance FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0];
      return Number(r.included_balance);
    };
    const refunds = async () => (await db.query("SELECT credits::int AS credits FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'refund'", [workspaceId])).rows;
    async function charged(): Promise<string> {
      await db.query(
        `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
         VALUES ($1,100,(now() AT TIME ZONE 'UTC')::date,(now() AT TIME ZONE 'UTC')::date + 30)`,
        [workspaceId],
      );
      const auditId = randomUUID();
      const { debitInTransaction } = await import("../../src/lib/credits/debit.js");
      await db.query("BEGIN");
      await debitInTransaction(db as never, {
        workspaceId, actorId: null, actorType: "system", actionCode: "aux_manual", credits: 10, idempotencyKey: ["aux_audit", auditId].join(":"),
        projectId, referenceType: "aux_audit", referenceId: auditId, includedGrant: 0,
      });
      await db.query("COMMIT");
      await db.query(
        `INSERT INTO aux_audits (id, workspace_id, project_id, trigger, scope, target_urls, rule_version, tokenizer, status)
         VALUES ($1,$2,$3,'manual','key_pages','{}','2026.10.1','cl100k','queued')`,
        [auditId, workspaceId, projectId],
      );
      return auditId;
    }
    const manualJob = (auditId: string): Job => job({ trigger: "manual", auditId, scope: "key_pages" });
    // Production runs every phase inside withTenantJob, i.e. with the job's workspace set for the transaction; the write that fails an audit is confined to it.
    const inTenant = (): Promise<unknown> => db.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const runTx = async (j: Job, deps: CrawlAuditDeps): Promise<void> => {
      await db.query("BEGIN");
      await inTenant();
      try {
        await run(j, deps);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    };
    const recoverTx = async (auditId: string, attemptsMade: number, trigger = "manual"): Promise<boolean> => {
      const processor = createCrawlAuditHandler({ pool: {} as never, env: {} as never }, depsServing(healthy(OPEN)));
      const phases = phasesOf(processor)!;
      const j = { data: { payload: { projectId, auditId, trigger, workspaceId, kid: "k1", scope: "key_pages" } }, attemptsMade, opts: { attempts: 5 } } as unknown as Job;
      await db.query("BEGIN");
      await inTenant();
      try {
        const settled = await phases.recover!(db as never, j, { phase: "run", error: new Error("boom") });
        await db.query("COMMIT");
        return settled;
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    };

    it("AUXLIVE-3 review · a COMPLETED, charged manual audit redelivered after its project is deleted is NOT refunded: the work was delivered", async () => {
      const auditId = await charged();
      await runTx(manualJob(auditId), depsServing(healthy(OPEN)));
      expect((await audits())[0].status).toBe("completed");
      await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [projectId]);
      await runTx(manualJob(auditId), depsServing(healthy(OPEN)));
      expect((await audits())[0].status).toBe("completed");
      expect(await refunds()).toEqual([]);
      expect(await wallet()).toBe(90);
    });

    it("AUXLIVE-3 review · a queued manual audit whose project was deleted is still failed and refunded (the row did move)", async () => {
      const auditId = await charged();
      await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [projectId]);
      await runTx(manualJob(auditId), depsServing(healthy(OPEN)));
      expect((await audits())[0].status).toBe("failed");
      expect(await refunds()).toHaveLength(1);
    });

    it("AUXLIVE-3 review · the job's LAST attempt failing settles a manual audit still queued: failed (job_failed), refunded in full, and the job ends instead of dead-lettering", async () => {
      const auditId = await charged();
      expect(await recoverTx(auditId, 4)).toBe(true);
      const [a] = await audits();
      expect(a).toMatchObject({ id: auditId, status: "failed" });
      expect(a.error_summary).toEqual({ reason: "job_failed" });
      expect(a.finished_at).not.toBeNull();
      expect(await refunds()).toEqual([{ credits: 10 }]);
      expect(await wallet()).toBe(100);
    });

    it("AUXLIVE-3 review · an earlier attempt failing settles nothing: the retry ladder still has a chance, and the credits stay taken", async () => {
      const auditId = await charged();
      expect(await recoverTx(auditId, 1)).toBe(false);
      expect((await audits())[0].status).toBe("queued");
      expect(await refunds()).toEqual([]);
    });

    it("AUXLIVE-3 review · a last-attempt failure after the audit was already delivered refunds nothing and leaves the job to the queue", async () => {
      const auditId = await charged();
      await runTx(manualJob(auditId), depsServing(healthy(OPEN)));
      expect(await recoverTx(auditId, 4)).toBe(false);
      expect((await audits())[0].status).toBe("completed");
      expect(await refunds()).toEqual([]);
    });

    const recoverWith = async (auditId: string, job: Record<string, unknown>, error: Error): Promise<boolean> => {
      const processor = createCrawlAuditHandler({ pool: {} as never, env: {} as never }, depsServing(healthy(OPEN)));
      const phases = phasesOf(processor)!;
      const j = { data: { payload: { projectId, auditId, trigger: "manual", workspaceId, kid: "k1", scope: "key_pages" } }, ...job } as unknown as Job;
      await db.query("BEGIN");
      await inTenant();
      try {
        const settled = await phases.recover!(db as never, j, { phase: "run", error });
        await db.query("COMMIT");
        return settled;
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    };

    it("R5 nit · a manual job whose payload no longer PARSES still refunds through the audit id when one can be read safely (a uuid audit, a uuid workspace, trigger manual)", async () => {
      const auditId = await charged();
      const processor = createCrawlAuditHandler({ pool: {} as never, env: {} as never }, depsServing(healthy(OPEN)));
      const phases = phasesOf(processor)!;
      const j = { data: { payload: { projectId, auditId, trigger: "manual", workspaceId, kid: "k1", scope: "key_pages", surprise: "a field this build does not know" } }, attemptsMade: 4, opts: { attempts: 5 } } as unknown as Job;
      await db.query("BEGIN");
      await inTenant();
      const settled = await phases.recover!(db as never, j, { phase: "prepare", error: new Error("boom") });
      await db.query("COMMIT");
      expect(settled).toBe(true);
      expect((await audits())[0].status).toBe("failed");
      expect(await refunds()).toEqual([{ credits: 10 }]);
    });

    it("R5 nit · a payload with no readable audit id settles nothing and does not throw: the reaper is the backstop", async () => {
      const processor = createCrawlAuditHandler({ pool: {} as never, env: {} as never }, depsServing(healthy(OPEN)));
      const phases = phasesOf(processor)!;
      const j = { data: { payload: { trigger: "manual", auditId: "not-a-uuid", workspaceId } }, attemptsMade: 4, opts: { attempts: 5 } } as unknown as Job;
      await db.query("BEGIN");
      await inTenant();
      expect(await phases.recover!(db as never, j, { phase: "prepare", error: new Error("boom") })).toBe(false);
      await db.query("COMMIT");
    });

    it("AUXLIVE-3 review round 2 · an UnrecoverableError on an EARLY attempt settles the manual audit at once: BullMQ will not retry it, so the refund is not left to the 60-minute reaper", async () => {
      const auditId = await charged();
      const unrecoverable = Object.assign(new Error("tampered"), { name: "UnrecoverableError" });
      expect(await recoverWith(auditId, { attemptsMade: 0, opts: { attempts: 5 } }, unrecoverable)).toBe(true);
      expect((await audits())[0].status).toBe("failed");
      expect(await refunds()).toEqual([{ credits: 10 }]);
    });

    it("AUXLIVE-3 review round 2 · a job enqueued with no opts.attempts has no retry ladder: its first failure is final and settles the audit", async () => {
      const auditId = await charged();
      expect(await recoverWith(auditId, { attemptsMade: 0, opts: {} }, new Error("boom"))).toBe(true);
      expect((await audits())[0].status).toBe("failed");
      expect(await refunds()).toEqual([{ credits: 10 }]);
    });

    it("AUXLIVE-3 review round 2 · an ordinary error on an early attempt of a job WITH a ladder still settles nothing", async () => {
      const auditId = await charged();
      expect(await recoverWith(auditId, { attemptsMade: 1, opts: { attempts: 5 } }, new Error("boom"))).toBe(false);
      expect((await audits())[0].status).toBe("queued");
    });

    it("AUXLIVE-3 review · an ONBOARDING job failing on its last attempt has no charge and no row to settle: the failure goes to the queue", async () => {
      expect(await recoverTx(randomUUID(), 4, "onboarding")).toBe(false);
    });

    it("AUXLIVE-3 review · recovering twice refunds once", async () => {
      const auditId = await charged();
      await recoverTx(auditId, 4);
      await recoverTx(auditId, 4);
      expect(await refunds()).toHaveLength(1);
    });
  });

  // OWNER DECISION 47 - a Free project's onboarding audit is the free SITE-FILES-ONLY check (robots.txt, llms.txt, sitemap): no page is selected, fetched
  // or judged, whatever the verification state. plans-and-entitlements.md: "Site-file AUX checks ... are free and unlimited" (Free); the page audit is paid.
  describe("owner decision 47 · the site-files-only onboarding audit (Free)", () => {
    const SITE_FILES = [
      "https://acme.com/.well-known/llms.txt",
      "https://acme.com/llms.txt",
      "https://acme.com/robots.txt",
      "https://acme.com/sitemap.xml",
    ];
    const siteFilesJob = (over: Record<string, unknown> = {}): Job => job({ trigger: "onboarding", siteFilesOnly: true, ...over });
    const asReader = async <T>(fn: () => Promise<T>): Promise<T> => {
      const c = new Client({ connectionString: container.getConnectionUri() });
      await c.connect();
      try {
        let out!: T;
        await withTenantContext(c as never, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async () => { out = await fn(); });
        return out;
      } finally {
        await c.end();
      }
    };

    it("D47 · asks for the site files and the sitemap and for NO page - not the supplied URL, not a sitemap page - and records an audit with no page crawled", async () => {
      const requested: string[] = [];
      await run(siteFilesJob(), depsServing(withSitemap(SITEMAP_PAGES), requested));
      expect(requested.sort()).toEqual(SITE_FILES);
      expect(rendered).toEqual([]);
      const [a] = await audits();
      expect(a).toMatchObject({ trigger: "onboarding", status: "completed", pages_crawled: 0, pages_failed: 0, aux_score: null, llms_txt_present: true });
      expect(a.scope).toBe("public_surface");
    });

    it("D47 · a VERIFIED domain is still site-files-only: the flag, not the verification state, holds the crawl to the site files", async () => {
      await verifyDomain();
      const requested: string[] = [];
      await run(siteFilesJob({ scope: "key_pages" }), depsServing(withSitemap(SITEMAP_PAGES), requested));
      expect(requested.sort()).toEqual(SITE_FILES);
      expect((await audits())[0]).toMatchObject({ pages_crawled: 0, aux_score: null });
    });

    it("D47 · the site-file findings are still raised, and no page-rule finding is: a blocked AI crawler is found, nothing else is invented", async () => {
      await run(siteFilesJob(), depsServing(healthy(BLOCKED)));
      const rows = await findings();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((f) => f.rule_code === "AUX-R-001")).toBe(true);
      expect(rows.every((f) => ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007"].includes(f.rule_code as string))).toBe(true);
    });

    it("D47 · the audit is free: nothing touches the credit ledger or the wallet", async () => {
      await run(siteFilesJob(), depsServing(healthy(OPEN)));
      expect((await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [workspaceId])).rowCount).toBe(0);
      expect((await db.query("SELECT 1 FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rowCount).toBe(0);
    });

    it("D47 · the AUX read endpoints show it on a Free workspace: the audit by id, the project's audit list and its findings", async () => {
      expect((await db.query("SELECT plan_key FROM workspaces WHERE id = $1", [workspaceId])).rows[0].plan_key).toBe("free");
      await run(siteFilesJob(), depsServing(healthy(BLOCKED)));
      const [stored] = await audits();
      const service = new AuxService();
      const one = await asReader(() => service.getAudit(stored.id));
      expect(one).toMatchObject({ audit_id: stored.id, trigger: "onboarding", status: "completed", pages_crawled: 0, aux_score: null, score_partial: false });
      // the one published category is the site-file one; nothing else is claimed
      expect(one.categories.map((c) => c.category)).toEqual(["crawler_access"]);
      const list = await asReader(() => service.listProjectAudits(projectId, { limit: 10 }));
      expect(list.items.map((a) => a.audit_id)).toEqual([stored.id]);
      const found = await asReader(() => service.listProjectFindings(projectId, { limit: 50 }));
      expect(found.items.length).toBeGreaterThan(0);
    });

    it("D47 · a paid plan's onboarding job WITHOUT the flag still gets the full page audit", async () => {
      await db.query("UPDATE workspaces SET plan_key = 'starter' WHERE id = $1", [workspaceId]);
      const requested: string[] = [];
      await run(job({ trigger: "onboarding" }), depsServing(healthy(OPEN), requested));
      expect(requested).toContain("https://acme.com/");
      const [a] = await audits();
      expect(a.pages_crawled).toBe(1);
      expect(Number(a.aux_score)).toBe(100);
    });

    it("D47 · a MANUAL job can never be site-files-only: it is refused at the boundary and nothing is fetched or written", async () => {
      const requested: string[] = [];
      await expect(run(job({ trigger: "manual", siteFilesOnly: true }), depsServing(healthy(OPEN), requested))).rejects.toThrow();
      expect(requested).toEqual([]);
      expect(await audits()).toHaveLength(0);
    });
  });

  it("NEW-C-9 AC1.8 · the handler source adds no workspace_id predicate of its own", () => {
    const src = readFileSync(new URL("../../src/lib/queue/handlers/crawl-audit.handler.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/workspace_id\s*=\s*\$/i);
    expect(src).not.toMatch(/WHERE[^`"]*workspace_id/i);
  });
});
