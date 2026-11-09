import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALIGNMENT_TARGETS_MAX_PAGES, alignmentTargetsResponseSchema } from "../../contracts/analytics/index.js";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { AlignmentService } from "../../src/modules/geo/alignment.service.js";
import { ProjectOutOfScopeException } from "../../src/tenancy/errors.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";

// GET /geo/alignment/targets: what an alignment session can be opened on. Hazards: another workspace's rows never appear; a scoped manager
// is refused a project outside scope; a figure not measured is null (never 0) and only a `ready` session carries any; the route reads rows only.

const sha = (s: string) => createHash("sha256").update(s).digest();

describe("GET /geo/alignment/targets", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let ws: string;
  let project: string;
  let otherWs: string;
  let otherProject: string;
  let actor: string;
  const exporter = new InMemorySpanExporter();
  const service = new AlignmentService();

  beforeAll(async () => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);
  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  async function seedWorkspace(): Promise<{ ws: string; project: string }> {
    const w = randomUUID();
    const p = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [w, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(`INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://brand.test/','brand.test')`, [p, w, `p-${randomUUID().slice(0, 8)}`]);
    return { ws: w, project: p };
  }
  beforeEach(async () => {
    await db.query("TRUNCATE geo_alignments, corpus_passages, aux_findings, aux_audits, topic_clusters, projects, workspaces CASCADE");
    await db.query("TRUNCATE users CASCADE");
    actor = (await db.query("INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id", [`a-${randomUUID()}@example.com`])).rows[0].id;
    ({ ws, project } = await seedWorkspace());
    ({ ws: otherWs, project: otherProject } = await seedWorkspace());
    exporter.reset();
  });

  const targets = (p = project, w = ws, scope?: readonly string[]) => {
    const ctx: TenantContext = { workspaceId: w, actorId: actor, ...(scope !== undefined ? { scopeProjectIds: scope } : {}) };
    return withTenantContext(db, ctx, () => service.targets({ project_id: p }));
  };
  const cluster = async (w: string, p: string, label: string, prompts = 3) =>
    (await db.query<{ id: string }>("INSERT INTO topic_clusters (workspace_id, project_id, label, prompt_count) VALUES ($1,$2,$3,$4) RETURNING id", [w, p, label, prompts])).rows[0]!.id;
  const audit = async (w: string, p: string) =>
    (await db.query<{ id: string }>(`INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer) VALUES ($1,$2,'manual','{}','v1','none') RETURNING id`, [w, p])).rows[0]!.id;
  const finding = async (w: string, p: string, a: string, url: string | null) =>
    db.query(
      `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, url, severity, fingerprint, title, evidence, rule_version)
       VALUES ($1,$2,$3,'AUX-R-001',$4,'high',$5,'T','{}'::jsonb,'v1')`,
      [w, p, a, url, sha(randomUUID())],
    );
  const session = async (w: string, p: string, url: string, cluster_id: string | null, over: { state?: string; baseline?: number | null; coverage?: number | null; percentile?: number | null; band?: [number, number]; at?: string } = {}) =>
    (await db.query<{ id: string }>(
      `INSERT INTO geo_alignments (workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, analysis_state, baseline_alignment, coverage_ratio, percentile_vs_corpus, target_band_low, target_band_high, updated_at)
       VALUES ($1,$2,$3,$4,'{}','m',$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, now())) RETURNING id`,
      [w, p, url, cluster_id, over.state ?? "ready", over.baseline ?? null, over.coverage ?? null, over.percentile ?? null, over.band?.[0] ?? null, over.band?.[1] ?? null, over.at ?? null],
    )).rows[0]!.id;
  const passage = (w: string, p: string, domain: string, expires: string) =>
    db.query(
      `INSERT INTO corpus_passages (workspace_id, project_id, citation_url_hash, url, domain, passage_index, text, token_count, content_hash, embedding_model, expires_at)
       VALUES ($1,$2,$3,$4,$5,0,'t',1,$6,'m',$7::timestamptz)`,
      [w, p, sha(randomUUID()), `https://${domain}/x`, domain, sha(randomUUID()), expires],
    );

  it("AT-1 an empty project lists its root page only, no clusters, an empty corpus, and charges nothing", async () => {
    const res = await targets();
    expect(alignmentTargetsResponseSchema.safeParse(res).success).toBe(true);
    expect(res).toEqual({ project_id: project, clusters: [], pages: [{ target_url: "https://brand.test/", sources: ["project_root"] }], sessions: [], corpus: { passages: 0, domains: [] }, credits_charged: 0 });
  });

  it("AT-2 clusters are the project's own, with their label and prompt count", async () => {
    const a = await cluster(ws, project, "crm software", 7);
    await cluster(otherWs, otherProject, "someone else's");
    const res = await targets();
    expect(res.clusters).toEqual([{ cluster_id: a, label: "crm software", prompt_count: 7 }]);
  });

  it("AT-3 pages merge the root, the audited URLs and the sessions' URLs once each, with every source named; site files and null URLs are not pages", async () => {
    const a = await audit(ws, project);
    await finding(ws, project, a, "https://brand.test/pricing");
    await finding(ws, project, a, "https://brand.test/pricing");
    await finding(ws, project, a, "https://brand.test/robots.txt");
    await finding(ws, project, a, "https://brand.test/llms.txt");
    await finding(ws, project, a, "https://brand.test/sitemap.xml");
    await finding(ws, project, a, null);
    await finding(ws, project, a, "https://brand.test/");
    await session(ws, project, "https://brand.test/pricing", null);
    await session(ws, project, "https://brand.test/about", null);
    const res = await targets();
    expect(res.pages).toEqual([
      { target_url: "https://brand.test/", sources: ["project_root", "aux_audit"] },
      { target_url: "https://brand.test/about", sources: ["alignment_session"] },
      { target_url: "https://brand.test/pricing", sources: ["alignment_session", "aux_audit"] },
    ]);
  });

  it("AT-4 another workspace's pages, sessions, clusters and corpus never appear, and its project is a 404", async () => {
    const oc = await cluster(otherWs, otherProject, "x");
    await session(otherWs, otherProject, "https://other.test/", oc, { baseline: 0.5 });
    await finding(otherWs, otherProject, await audit(otherWs, otherProject), "https://other.test/a");
    await passage(otherWs, otherProject, "other.test", "2099-01-01");
    const res = await targets();
    expect(JSON.stringify(res)).not.toContain("other.test");
    expect(res.corpus.passages).toBe(0);
    await expect(targets(otherProject, ws)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("AT-5 a missing or deleted project is a 404", async () => {
    await expect(targets(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [project]);
    await expect(targets()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("AT-6 a scoped manager is refused a project outside their scope (403 project_out_of_scope), and allowed one inside", async () => {
    await expect(targets(project, ws, [randomUUID()])).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    await expect(targets(project, ws, [project])).resolves.toBeDefined();
  });

  it("AT-7 sessions: the newest per page and cluster; a ready one carries its figures, a pending one none; a 0 stays 0 and an unmeasured figure is null", async () => {
    const c = await cluster(ws, project, "c");
    await session(ws, project, "https://brand.test/a", c, { state: "ready", baseline: 0.1, at: "2026-11-01T00:00:00Z" });
    const newest = await session(ws, project, "https://brand.test/a", c, { state: "ready", baseline: 0.612, coverage: 0, percentile: 0, band: [0.74, 0.86], at: "2026-11-05T00:00:00Z" });
    const pending = await session(ws, project, "https://brand.test/b", c, { state: "pending", baseline: 0.9, coverage: 0.9, percentile: 90, band: [0.1, 0.2], at: "2026-11-04T00:00:00Z" });
    const res = await targets();
    expect(res.sessions.map((s) => s.session_id)).toEqual([newest, pending]);
    expect(res.sessions[0]).toMatchObject({ target_url: "https://brand.test/a", cluster_id: c, status: "ready", alignment: 0.612, coverage_ratio: 0, percentile_vs_cited_docs: 0, target_band: [0.74, 0.86] });
    expect(res.sessions[1]).toMatchObject({ status: "pending", alignment: null, coverage_ratio: null, percentile_vs_cited_docs: null, target_band: null });
  });

  it("AT-8 a ready session with nothing measured reports null, never 0", async () => {
    await session(ws, project, "https://brand.test/a", null, { state: "ready" });
    const [s] = (await targets()).sessions;
    expect(s).toMatchObject({ alignment: null, coverage_ratio: null, percentile_vs_cited_docs: null, target_band: null, cluster_id: null });
  });

  it("AT-9 the corpus counts unexpired passages and names their domains; an expired one does not count", async () => {
    await passage(ws, project, "g2.com", "2099-01-01");
    await passage(ws, project, "g2.com", "2099-01-01");
    await passage(ws, project, "capterra.com", "2099-01-01");
    await passage(ws, project, "old.com", "2000-01-01");
    expect((await targets()).corpus).toEqual({ passages: 3, domains: ["capterra.com", "g2.com"] });
  });

  it("AT-10 the page list is bounded, root first, and the bound is a hard limit", async () => {
    const a = await audit(ws, project);
    for (let i = 0; i < ALIGNMENT_TARGETS_MAX_PAGES + 20; i += 1) await finding(ws, project, a, `https://brand.test/p/${String(i).padStart(3, "0")}`);
    const res = await targets();
    expect(res.pages).toHaveLength(ALIGNMENT_TARGETS_MAX_PAGES);
    expect(res.pages[0]!.target_url).toBe("https://brand.test/");
  });

  it("AT-11 emits a span, a metric and a log line carrying the workspace id and no page URL or label", async () => {
    await cluster(ws, project, "secret label");
    const logs: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(message));
    try {
      await targets();
    } finally {
      spy.mockRestore();
    }
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain("geo.alignment.http.targets");
    expect(logs).toContainEqual(expect.objectContaining({ metric: "nominara_geo_alignment_requests_total", route: "targets" }));
    const line = logs.find((l) => (l as { event?: string }).event === "geo.alignment.targets_read") as Record<string, unknown>;
    expect(line).toMatchObject({ workspace_id: ws, project_id: project });
    expect(JSON.stringify(line)).not.toContain("secret label");
    expect(JSON.stringify(line)).not.toContain("brand.test");
  });
});
