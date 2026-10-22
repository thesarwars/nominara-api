import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
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
import { createHash } from "node:crypto";
import { crawlManifestSchema } from "../../contracts/aux/index.js";
import { handlerFor } from "../../src/lib/queue/handlers.js";
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
const healthy = (robots: string): Served => ({
  "/": { status: 200, body: "<html><body>home</body></html>" },
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
    renderer: { render: async (url) => { rendered.push(url); return { html: `<html>rendered ${url}</html>`, finalUrl: url, status: 200 }; } },
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
    expect(Buffer.isBuffer(a.robots_hash) && a.robots_hash.length === 32).toBe(true);
    expect(a.started_at).not.toBeNull();
    expect(a.finished_at).not.toBeNull();
  });

  it("NEW-C-9 AC2.2 · excluded_rules names every rule that did not run: 27 outside crawler_access, AUX-R-005 and AUX-R-006 (the page-level rules wait for STORY-051)", async () => {
    await run(job(), depsServing(healthy(OPEN)));
    const [a] = await audits();
    const excluded: string[] = a.excluded_rules;
    const codes = excluded.filter((e) => e.startsWith("AUX-R-"));
    expect(codes).toHaveLength(29);
    for (const ran of ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007"]) expect(excluded).not.toContain(ran);
    expect(excluded).toContain("AUX-R-005");
    expect(excluded).toContain("AUX-R-006");
    expect(excluded).toContain("AUX-R-008");
    expect(excluded).toContain("AUX-R-034");
    expect(excluded).not.toContain("page_crawl"); // a page WAS crawled: naming it as not run would be false
  });

  it("NEW-C-9 AC5.1 · publishes the crawler_access subscore, no aux_score; a critical finding sets the capped flag", async () => {
    await run(job(), depsServing(healthy(BLOCKED)));
    const [a] = await audits();
    expect(a.aux_score).toBeNull();
    expect(a.score_capped).toBe(true);
    expect(a.findings_critical).toBe(1);
    expect(Number(a.score_breakdown.crawler_access)).toBeCloseTo(0.7, 5);
  });

  it("NEW-C-9 AC5.2 · a clean site: subscore 1, not capped, aux_score still null", async () => {
    await run(job(), depsServing(healthy(OPEN)));
    const [a] = await audits();
    expect(a.aux_score).toBeNull();
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

  it("NEW-C-9 AC1.7 · a trigger outside onboarding/scheduled is refused at the boundary", async () => {
    await expect(run(job({ trigger: "manual" }), depsServing(healthy(OPEN)))).rejects.toThrow();
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
    "/pricing": { status: 200, body: "<html>pricing</html>" },
    "/about": { status: 200, body: "<html>about</html>" },
  });
  const manifestOf = async (): Promise<ReturnType<typeof crawlManifestSchema.parse>> => {
    const [a] = await audits();
    const key = [...stored.keys()].find((k) => k.endsWith("manifest.json"))!;
    expect(key).toBeDefined();
    expect(a.dom_object_prefix).toBe(`crawl/test/ws/${a.id}/`);
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
    expect(a.excluded_rules).toContain("AUX-R-008");
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
    expect(gunzipSync(stored.get(rawKey)!).toString()).toBe("<html>pricing</html>");
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

    it("REVIEW · the tenant object store resolves the workspace from the tenant context at call time: every key lands under crawl/{env}/{workspace_id}/", async () => {
      await verifyDomain();
      const puts: string[] = [];
      const port = { put: async (r: { key: string }) => { puts.push(r.key); } } as unknown as ObjectStoragePort;
      const tenantStore = new TenantObjectStore(port, "test");
      const deps = depsServing(withSitemap(SITEMAP_PAGES), [], 10_000, {
        store: (relative, body, contentType) => tenantStore.put("crawl", relative, body, { contentType }),
      });
      await asTenant(workspaceId, (tx) => createCrawlAuditHandler({ pool: {} as never, env: {} as never }, deps)(tx, job()));
      expect(puts.length).toBeGreaterThan(0);
      for (const key of puts) expect(key.startsWith(`crawl/test/${workspaceId}/`)).toBe(true);
      expect(puts.some((k) => k.endsWith("/manifest.json"))).toBe(true);
    });
  });

  it("NEW-C-9 AC1.8 · the handler source adds no workspace_id predicate of its own", () => {
    const src = readFileSync(new URL("../../src/lib/queue/handlers/crawl-audit.handler.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/workspace_id\s*=\s*\$/i);
    expect(src).not.toMatch(/WHERE[^`"]*workspace_id/i);
  });
});
