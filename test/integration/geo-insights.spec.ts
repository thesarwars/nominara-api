import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { geoAnalysisSchema, geoDigestSchema } from "../../contracts/analytics/index.js";
import { GeoService } from "../../src/modules/geo/geo.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-062 — persistence, replacement, rejection and the persisted-only read,
// against a real database.

const evidence = [{ url: "https://reddit.com/r/x", snippet: "engines cite this thread", corpus_doc_ratio: 0.4 }];
const finding = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  severity: "high",
  headline: `headline ${id}`,
  evidence,
  task_rule_code: "GEO-R-001",
  ...over,
});
const write = (analysis: string, over: Record<string, unknown> = {}) => ({
  analysis,
  window_start: "2026-09-08",
  window_days: 30,
  score: 61.5,
  score_label: analysis,
  evidence_cells: 120,
  evidence_passages: 3,
  sufficient: true,
  suppression_reason: null,
  findings: [finding(`${analysis}-1`)],
  lever_rank: null,
  ...over,
});

describe("STORY-062 · GEO insights persistence and read", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE geo_analyses, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain)
       VALUES ($1,$2,'P',$3,'https://x.com','x.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  const ctx = <T>(fn: (s: GeoService) => Promise<T>) =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => fn(new GeoService())) as Promise<T>;
  const count = async () => Number((await db.query("SELECT count(*) FROM geo_analyses")).rows[0].count);

  it("S1 · persists score, findings and evidence base", async () => {
    await ctx((s) => s.persistAnalysis(projectId, write("structure")));
    const r = (await db.query("SELECT * FROM geo_analyses")).rows[0];
    expect(Number(r.score)).toBe(61.5);
    expect(r.evidence_cells).toBe(120);
    expect(r.evidence_passages).toBe(3);
    expect(r.findings).toHaveLength(1);
    expect(r.workspace_id).toBe(workspaceId);
  });

  it("S2 · a recompute of the same window replaces rather than duplicates", async () => {
    await ctx((s) => s.persistAnalysis(projectId, write("structure", { score: 10 })));
    await ctx((s) => s.persistAnalysis(projectId, write("structure", { score: 0, findings: [finding("new")] })));
    expect(await count()).toBe(1);
    const r = (await db.query("SELECT score, findings FROM geo_analyses")).rows[0];
    expect(Number(r.score)).toBe(0);
    expect(r.findings[0].id).toBe("new");
  });

  it("S3 · the fan-out analysis cannot be written", async () => {
    await expect(ctx((s) => s.persistAnalysis(projectId, write("query_fanout")))).rejects.toMatchObject({ code: "validation_failed" });
    expect(await count()).toBe(0);
  });

  it("S6 · an evidence-free finding is rejected and nothing is persisted", async () => {
    await expect(
      ctx((s) => s.persistAnalysis(projectId, write("structure", { findings: [finding("x", { evidence: [] })] }))),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(await count()).toBe(0);
  });

  it("S7 · a finding with neither task rule nor no-action verdict is rejected", async () => {
    await expect(
      ctx((s) => s.persistAnalysis(projectId, write("structure", { findings: [finding("x", { task_rule_code: undefined })] }))),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(await count()).toBe(0);
  });

  it("S4/S5 · a suppressed analysis stores no findings and reads back its reason", async () => {
    await ctx((s) =>
      s.persistAnalysis(projectId, write("sentiment", { sufficient: false, suppression_reason: "needs 30 mentions", score: null, findings: [], evidence_cells: 4 })),
    );
    const a = await ctx((s) => s.analysis(projectId, "sentiment", { timeframe: "30d" }));
    expect(geoAnalysisSchema.safeParse(a).success).toBe(true);
    expect(a.summary.status).toBe("insufficient");
    expect(a.summary.needs).toBe("needs 30 mentions");
    expect(a.summary.score).toBeNull();
    expect(a.actions).toEqual([]);
  });

  it("S8/S9 · the digest promotes at most three levers across more than three analyses", async () => {
    for (const [i, slug] of (["structure", "divergence", "sentiment", "topics", "entity"] as const).entries()) {
      await ctx((s) => s.persistAnalysis(projectId, write(slug, { lever_rank: (i % 3) + 1 })));
    }
    const d = await ctx((s) => s.digest(projectId, { timeframe: "30d" }));
    expect(geoDigestSchema.safeParse(d).success).toBe(true);
    expect(d.levers).toHaveLength(3);
    expect(d.levers.every((l) => l.analysis_href.startsWith("geo?analysis="))).toBe(true);
    expect(d.analyses).toHaveLength(7);
    expect(d.evidence.cells).toBe(5 * 120);
  });

  it("S10/S12 · reading never writes, moves no ledger and recomputes nothing", async () => {
    await ctx((s) => s.persistAnalysis(projectId, write("structure", { lever_rank: 1 })));
    const before = (await db.query("SELECT computed_at FROM geo_analyses")).rows[0].computed_at;
    await ctx((s) => s.digest(projectId, { timeframe: "30d" }));
    await ctx((s) => s.analysis(projectId, "structure", { timeframe: "30d" }));
    expect((await db.query("SELECT computed_at FROM geo_analyses")).rows[0].computed_at).toEqual(before);
    expect(await count()).toBe(1);
  });

  it("an empty project reads as unbuilt-with-reasons, never an empty panel", async () => {
    const d = await ctx((s) => s.digest(projectId, { timeframe: "30d" }));
    expect(d.sufficient).toBe(false);
    expect(d.levers).toEqual([]);
    const byslug = Object.fromEntries(d.analyses.map((a) => [a.slug, a]));
    expect(byslug.alignment!.status).toBe("insufficient");
    expect(byslug.alignment!.needs).toContain("STORY-058");
    expect(byslug.entity!.status).toBe("insufficient");
    expect(byslug.topics!.needs).toContain("STORY-047");
    expect(byslug.freshness!.status).toBe("post_launch");
  });

  it("404s for a project that does not exist, on read and on write", async () => {
    await expect(ctx((s) => s.digest(randomUUID(), { timeframe: "30d" }))).rejects.toMatchObject({ code: "not_found" });
    await expect(ctx((s) => s.persistAnalysis(randomUUID(), write("structure")))).rejects.toMatchObject({ code: "not_found" });
  });
});
