import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { geoAnalysisSchema, geoStructureDetailSchema } from "../../contracts/analytics/index.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { refreshProjectGeo } from "../../src/lib/rollup/refresh-project-geo.js";
import { GeoService } from "../../src/modules/geo/geo.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-060 — A3 answer structure over stored mention_facts, against a real
// database. The window is anchored by `asOf`, so every date here is fixed.

const AS_OF = new Date("2026-10-01T12:00:00Z"); // 30d window = 2026-09-02 .. 2026-10-01 inclusive
const IN_WINDOW = "2026-09-20T10:00:00Z";
const PRIOR_WINDOW = "2026-08-20T10:00:00Z"; // 2026-08-03 .. 2026-09-01
const OUTSIDE = "2026-06-01T10:00:00Z";

describe("STORY-060 · A3 answer structure (persisted, read)", () => {
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
    await db.query("TRUNCATE geo_analyses, answer_captures, mention_facts, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = await makeProject(workspaceId, true);
  });

  async function makeProject(ws: string, createWorkspace: boolean): Promise<string> {
    if (createWorkspace) {
      await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [
        ws,
        `w-${randomUUID().slice(0, 8)}`,
      ]);
    }
    const id = randomUUID();
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain)
       VALUES ($1,$2,'P',$3,'https://acme.com','acme.com')`,
      [id, ws, `p-${randomUUID().slice(0, 8)}`],
    );
    return id;
  }

  interface Answer {
    engine?: string;
    at?: string;
    form?: string | null;
    brand?: string | null; // the brand's position_class, or null for a competitor-only answer
    demo?: boolean;
    project?: string;
    ws?: string;
  }
  async function answer(a: Answer = {}): Promise<void> {
    const id = randomUUID();
    const at = a.at ?? IN_WINDOW;
    const engine = a.engine ?? "gemini";
    const project = a.project ?? projectId;
    const ws = a.ws ?? workspaceId;
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'api','v1',$8,'\\x00','parsed')`,
      [id, ws, project, randomUUID(), randomUUID(), engine, at, a.demo === true ? "demo-seed" : "v1"],
    );
    const mention = (type: string, cls: string) =>
      db.query(
        `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
           occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,
           position_class,answer_form)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'x','x',0,0,1,0,0.5,'neutral',0,0.5,'lexicon',$8,$9)`,
        [ws, project, id, randomUUID(), engine, at, type, cls, a.form === undefined ? "narrative" : a.form],
      );
    if (a.brand !== undefined && a.brand !== null) await mention("brand", a.brand);
    else await mention("competitor", "neutral_list");
  }
  const many = async (n: number, a: Answer) => {
    for (let i = 0; i < n; i++) await answer(a);
  };

  const ctx = <T>(fn: (s: GeoService) => Promise<T>) =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => fn(new GeoService())) as Promise<T>;
  const refresh = () => withTenantContext(db, { workspaceId, actorId: randomUUID() }, (tx) => refreshProjectGeo(tx, projectId, { asOf: AS_OF }));
  const rows = async () => (await db.query("SELECT * FROM geo_analyses WHERE analysis = 'structure'")).rows;

  it("#7 · over 30 answers the dominant form is identified and the row is persisted sufficient", async () => {
    await many(20, { form: "comparison_table", brand: "recommendation" });
    await many(12, { form: "narrative", brand: "ranked" });
    await refresh();
    const [r] = await rows();
    expect(r.sufficient).toBe(true);
    expect(r.score).toBeNull();
    expect(r.evidence_cells).toBe(32);
    expect(r.window_days).toBe(30);
    const a = await ctx((s) => s.analysis(projectId, "structure", { timeframe: "30d" }));
    expect(geoAnalysisSchema.safeParse(a).success).toBe(true);
    const detail = geoStructureDetailSchema.parse(a.detail);
    expect(detail.dominant_form).toBe("comparison_table");
    expect(detail.total).toBe(32);
    expect(a.summary.status).toBe("ready");
    expect(a.summary.verdict).toBe("no_action");
  });

  it("#8 · no page crawl: page_forms [], template null, no task, no fabricated gap", async () => {
    await many(30, { form: "comparison_table" });
    await refresh();
    const a = await ctx((s) => s.analysis(projectId, "structure", { timeframe: "30d" }));
    const detail = geoStructureDetailSchema.parse(a.detail);
    expect(detail.page_forms).toEqual([]);
    expect(detail.template).toBeNull();
    expect(a.actions).toEqual([]);
    expect((await rows())[0].findings.every((x: { task_rule_code?: string }) => x.task_rule_code === undefined)).toBe(true);
  });

  it("#9 · position-class movement is trended against the prior window", async () => {
    await many(30, { form: "narrative", brand: "also_consider" });
    await many(4, { form: "narrative", brand: "recommendation" });
    await many(10, { form: "narrative", brand: "recommendation", at: PRIOR_WINDOW });
    await refresh();
    const detail = geoStructureDetailSchema.parse((await ctx((s) => s.analysis(projectId, "structure", { timeframe: "30d" }))).detail);
    const rec = detail.position.find((p) => p.cls === "recommendation")!;
    expect(rec.prior).toBe(1);
    expect(rec.share).toBeCloseTo(4 / 34, 3);
    expect(detail.brand_answers).toBe(34);
    expect(detail.prior_brand_answers).toBe(10);
  });

  it("#10 · below the minimum it persists a suppressed row with a reason and the read shows no detail", async () => {
    await many(29, { form: "narrative", brand: "ranked" });
    await refresh();
    const [r] = await rows();
    expect(r.sufficient).toBe(false);
    expect(r.suppression_reason).toMatch(/29/);
    expect(r.findings).toEqual([]);
    const a = await ctx((s) => s.analysis(projectId, "structure", { timeframe: "30d" }));
    expect(a.summary.status).toBe("insufficient");
    expect(a.detail).toBeNull();
  });

  it("an empty project suppresses with 0 cells rather than failing", async () => {
    await refresh();
    const [r] = await rows();
    expect(r.sufficient).toBe(false);
    expect(r.evidence_cells).toBe(0);
  });

  it("answers outside the window, with no answer_form, or on another project do not count", async () => {
    await many(29, { form: "narrative" });
    await many(5, { form: "narrative", at: OUTSIDE });
    await many(5, { form: null });
    const other = await makeProject(workspaceId, false);
    await many(5, { form: "narrative", project: other });
    await refresh();
    const [r] = await rows();
    expect(r.evidence_cells).toBe(29);
    expect(r.sufficient).toBe(false);
  });

  it("two mentions in one answer count as one answer", async () => {
    await many(29, { form: "narrative" });
    const id = (await db.query("SELECT result_id FROM mention_facts LIMIT 1")).rows[0].result_id;
    await db.query(
      `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
         occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,position_class,answer_form)
       SELECT workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,'competitor','y','y',1,5,6,1,0.5,'neutral',0,0.5,'lexicon','neutral_list',answer_form
         FROM mention_facts WHERE result_id = $1`,
      [id],
    );
    await refresh();
    expect((await rows())[0].evidence_cells).toBe(29);
  });

  it("the brand's FIRST mention in an answer decides its position class, not a later one", async () => {
    await many(29, { form: "narrative", brand: "recommendation" });
    await answer({ form: "narrative", brand: "recommendation" });
    await db.query(
      `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
         occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,position_class,answer_form)
       SELECT workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,'brand','x','x',1,50,51,9,0.5,'neutral',0,0.5,'lexicon','caveat',answer_form
         FROM mention_facts WHERE entity_type = 'brand'`,
    );
    await refresh();
    const detail = geoStructureDetailSchema.parse((await ctx((s) => s.analysis(projectId, "structure", { timeframe: "30d" }))).detail);
    expect(detail.brand_answers).toBe(30);
    expect(detail.position.find((p) => p.cls === "recommendation")!.share).toBe(1);
    expect(detail.position.find((p) => p.cls === "caveat")!.share).toBe(0);
  });

  it("every engine carries a data_source: demo-seeded captures are demo, others live", async () => {
    await many(30, { form: "comparison_table", engine: "gemini" });
    await many(5, { form: "narrative", engine: "claude", demo: true });
    await refresh();
    const detail = geoStructureDetailSchema.parse((await ctx((s) => s.analysis(projectId, "structure", { timeframe: "30d" }))).detail);
    expect(Object.fromEntries(detail.engines.map((e) => [e.engine, e.data_source]))).toEqual({ claude: "demo", gemini: "live" });
  });

  it("a recompute of the same window replaces rather than accumulates", async () => {
    await many(30, { form: "narrative" });
    await refresh();
    await many(2, { form: "narrative" });
    await refresh();
    const rs = await rows();
    expect(rs).toHaveLength(1);
    expect(rs[0].evidence_cells).toBe(32);
  });

  it("#11 · free and unmetered: no credit ledger entry, no wallet movement", async () => {
    await many(30, { form: "narrative" });
    await refresh();
    await ctx((s) => s.analysis(projectId, "structure", { timeframe: "30d" }));
    expect(Number((await db.query("SELECT count(*) FROM credit_ledger")).rows[0].count)).toBe(0);
  });

  it("a project that does not exist is a not_found, not a silent no-op", async () => {
    await expect(
      withTenantContext(db, { workspaceId, actorId: randomUUID() }, (tx) => refreshProjectGeo(tx, randomUUID(), { asOf: AS_OF })),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
