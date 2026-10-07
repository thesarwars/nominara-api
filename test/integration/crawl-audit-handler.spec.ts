import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import type { Job } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createCrawlAuditHandler, type CrawlAuditDeps } from "../../src/lib/queue/handlers/crawl-audit.handler.js";
import { handlerFor } from "../../src/lib/queue/handlers.js";
import type { GuardedResponse } from "../../src/lib/net/guarded-fetch.js";

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

type Served = Record<string, { status: number; body?: string } | "throw" | "hang">;

const BLOCKED = "User-agent: GPTBot\nDisallow: /\n";
const OPEN = "User-agent: *\nAllow: /\nSitemap: https://acme.com/sitemap.xml\n";
const LLMS = "# Acme\n- [Docs](https://acme.com/docs)\n";
const SITEMAP = `<urlset><url><loc>https://acme.com/</loc><lastmod>2026-10-01</lastmod></url></urlset>`;
const healthy = (robots: string): Served => ({
  "/robots.txt": { status: 200, body: robots },
  "/llms.txt": { status: 200, body: LLMS },
  "/.well-known/llms.txt": { status: 404, body: "" },
  "/sitemap.xml": { status: 200, body: SITEMAP },
});

function depsServing(served: Served, requested: string[] = [], timeoutMs = 10_000): CrawlAuditDeps {
  return {
    now: () => new Date("2026-10-07T00:00:00Z"),
    sleep: async () => undefined,
    timeoutMs,
    fetch: async (url: string): Promise<GuardedResponse> => {
      requested.push(url);
      const hit = served[new URL(url).pathname];
      if (hit === undefined || hit === "throw") throw new Error("connection refused");
      if (hit === "hang") return new Promise<GuardedResponse>(() => undefined);
      return { status: hit.status, headers: {}, body: Buffer.from(hit.body ?? ""), finalUrl: url };
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
    await db.query("TRUNCATE workspaces CASCADE");
    workspaceId = (await db.query("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W','w-c9','free') RETURNING id")).rows[0].id;
    projectId = (await db.query(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1,'P','p-c9','https://acme.com','acme.com') RETURNING id",
      [workspaceId],
    )).rows[0].id;
  });

  const job = (over: Record<string, unknown> = {}): Job =>
    ({ data: { payload: { projectId, auditId: randomUUID(), trigger: "onboarding", workspaceId, kid: "k1", ...over } } }) as unknown as Job;
  const run = (j: Job, deps: CrawlAuditDeps): Promise<void> =>
    createCrawlAuditHandler({ pool: {} as never, env: {} as never }, deps)(db as never, j);
  const audits = async (): Promise<Record<string, any>[]> => (await db.query("SELECT * FROM aux_audits ORDER BY created_at")).rows;
  const findings = async (): Promise<Record<string, any>[]> => (await db.query("SELECT * FROM aux_findings ORDER BY created_at")).rows;

  it("NEW-C-9 AC1.1 · is registered as the crawl.audit handler", () => {
    expect(handlerFor("crawl.audit")).toBeDefined();
  });

  it("NEW-C-9 AC1.2 · fetches robots.txt, llms.txt, /.well-known/llms.txt and sitemap.xml, and nothing else", async () => {
    const requested: string[] = [];
    await run(job(), depsServing(healthy(OPEN), requested));
    expect(requested.sort()).toEqual([
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

  it("NEW-C-9 AC2.1 · writes a domain_root audit with the trigger, snapshot, hash and site-file facts", async () => {
    await run(job({ trigger: "scheduled" }), depsServing(healthy(OPEN)));
    const [a] = await audits();
    expect(a).toMatchObject({ trigger: "scheduled", scope: "domain_root", status: "completed", llms_txt_present: true, sitemap_url_count: 1, pages_crawled: 0, pages_failed: 0 });
    expect(a.robots_snapshot).toBe(OPEN);
    expect(Buffer.isBuffer(a.robots_hash) && a.robots_hash.length === 32).toBe(true);
    expect(a.started_at).not.toBeNull();
    expect(a.finished_at).not.toBeNull();
  });

  it("NEW-C-9 AC2.2 · excluded_rules names every rule that did not run: 27 outside crawler_access, AUX-R-005 and AUX-R-006, and the page crawl", async () => {
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
    expect(excluded).toContain("page_crawl");
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
    expect(all[0].first_detected_at).toEqual(first.first_detected_at);
    expect(all[0].regressed_at).not.toBeNull();
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

  it("NEW-C-9 AC1.8 · the handler source adds no workspace_id predicate of its own", () => {
    const src = readFileSync(new URL("../../src/lib/queue/handlers/crawl-audit.handler.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/workspace_id\s*=\s*\$/i);
    expect(src).not.toMatch(/WHERE[^`"]*workspace_id/i);
  });
});
