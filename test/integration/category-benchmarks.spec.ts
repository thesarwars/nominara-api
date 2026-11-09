import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { MIN_BENCHMARK_WORKSPACES, readProjectBenchmark } from "../../src/lib/rollup/category-benchmarks.js";
import { asTenantJob } from "../support/tenant-job.js";

// STORY-176 · NFR-SEC-05 option A (owner decision 91). `platform_metrics` is filled by `app.refresh_platform_metrics`, a SECURITY DEFINER
// function that reads only the named columns of metric_daily, projects, project_source_index and source_domains, and publishes a group only
// when at least 20 DISTINCT WORKSPACES contribute (decision 88(d)). One workspace contributes ONE value per group, however many projects it has.

const DAY = "2026-11-01";
const ENGINE = "chatgpt";

describe("STORY-176 · category-relative benchmarks", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  const exporter = new InMemorySpanExporter();

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
  beforeEach(async () => {
    await db.query("TRUNCATE platform_metrics, project_source_index, source_domains, metric_daily, projects, workspaces, engines CASCADE");
    for (const key of [ENGINE, "perplexity"]) {
      await db.query(
        `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key, status)
         VALUES ($1,$1,'v','api','1.0.0',86400,'medium','free','active')`,
        [key],
      );
    }
  });

  interface Seeded {
    workspaceId: string;
    projectId: string;
  }

  /** One project in its own workspace (or in `workspaceId` when given), with a brand metric row for `score` on DAY. */
  async function seed(category: string | null, score: number | null, opts: { workspaceId?: string; aux?: number | null; engine?: string; date?: string; deleted?: boolean } = {}): Promise<Seeded> {
    const workspaceId = opts.workspaceId ?? randomUUID();
    if (opts.workspaceId === undefined) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    }
    const projectId = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, category_slug, aux_score_current, deleted_at)
       VALUES ($1,$2,'P',$3,'https://p.example','p.example',$4,$5,$6)`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`, category, opts.aux === undefined ? 50 : opts.aux, opts.deleted === true ? new Date() : null],
    );
    if (score !== null) await metric(projectId, workspaceId, score, opts.engine ?? ENGINE, opts.date ?? DAY);
    return { workspaceId, projectId };
  }

  async function metric(projectId: string, workspaceId: string, score: number, engine = ENGINE, date = DAY, version = "v1", entityType = "brand"): Promise<void> {
    await db.query(
      `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, visibility_score, scoring_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [workspaceId, projectId, engine, entityType, projectId, date, score, version],
    );
  }

  /** `n` workspaces, one project each, visibility 1..n. */
  async function seedCategory(category: string, n: number, opts: { aux?: number | null } = {}): Promise<Seeded[]> {
    const rows: Seeded[] = [];
    for (let i = 1; i <= n; i++) rows.push(await seed(category, i, opts));
    return rows;
  }

  async function refresh(categories: string[], from = DAY, to = DAY): Promise<{ written: number; removed: number }> {
    const r = await db.query<{ groups_written: number; groups_removed: number }>("SELECT * FROM app.refresh_platform_metrics($1::date, $2::date, $3::text[])", [from, to, categories]);
    return { written: r.rows[0]!.groups_written, removed: r.rows[0]!.groups_removed };
  }

  const rows = async (category: string) =>
    (await db.query("SELECT metric_date::text, category_slug, engine_key, sample_size, median_visibility::float8, p25_visibility::float8, p75_visibility::float8, median_aux_score::float8, top_source_domains FROM platform_metrics WHERE category_slug = $1 ORDER BY metric_date, engine_key", [category])).rows;

  it("names the minimum as a constant: 20 distinct workspaces", () => {
    expect(MIN_BENCHMARK_WORKSPACES).toBe(20);
  });

  it("scenario 1 — rollup over projects in one category writes platform_metrics rows carrying that category_slug, with the exact percentiles", async () => {
    await seedCategory("crm", 20);
    await seedCategory("banks", 3);
    expect(await refresh(["crm"])).toEqual({ written: 1, removed: 0 });
    const [row, ...rest] = await rows("crm");
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ metric_date: DAY, category_slug: "crm", engine_key: ENGINE, sample_size: 20 });
    // Twenty values 1..20: percentile_cont gives 10.5, 5.75 and 15.25.
    expect(row.median_visibility).toBeCloseTo(10.5, 3);
    expect(row.p25_visibility).toBeCloseTo(5.75, 3);
    expect(row.p75_visibility).toBeCloseTo(15.25, 3);
    expect(row.median_aux_score).toBeCloseTo(50, 3);
    // Nothing was written for the category that was not asked for.
    expect(await rows("banks")).toEqual([]);
  });

  it("only the categories asked for are touched: a recompute of one category neither publishes nor removes another's rows", async () => {
    await seedCategory("crm", 20);
    await seedCategory("banks", 20);
    await refresh(["banks"]);
    expect(await rows("crm")).toEqual([]);
    expect(await rows("banks")).toHaveLength(1);
    await refresh(["crm"]);
    await db.query("DELETE FROM metric_daily WHERE project_id IN (SELECT id FROM projects WHERE category_slug = 'crm')");
    await refresh(["crm"]);
    expect(await rows("crm")).toEqual([]);
    expect(await rows("banks")).toHaveLength(1); // banks was not part of that recompute, so it is untouched
  });

  it("scenario 2 — a category below the minimum has NO row (null at the read path), not a row of zeros: 19 workspaces publish nothing, 20 publish", async () => {
    await seedCategory("crm", 19);
    expect(await refresh(["crm"])).toEqual({ written: 0, removed: 0 });
    expect(await rows("crm")).toEqual([]);
    expect(await db.query("SELECT count(*)::int AS n FROM platform_metrics")).toMatchObject({ rows: [{ n: 0 }] });
    await seed("crm", 20);
    expect(await refresh(["crm"])).toMatchObject({ written: 1 });
    expect((await rows("crm"))[0]).toMatchObject({ sample_size: 20 });
  });

  it("decision 88(d) — the minimum counts DISTINCT WORKSPACES, not projects: 40 projects in 19 workspaces publish nothing", async () => {
    const workspaces = await seedCategory("crm", 19);
    for (const w of workspaces) await seed("crm", 5, { workspaceId: w.workspaceId });
    for (const w of workspaces.slice(0, 2)) await seed("crm", 7, { workspaceId: w.workspaceId });
    expect((await db.query("SELECT count(*)::int AS n FROM projects WHERE category_slug = 'crm'")).rows[0].n).toBe(40);
    expect(await refresh(["crm"])).toEqual({ written: 0, removed: 0 });
  });

  it("one workspace contributes ONE value, the median of its own projects, so a large agency cannot dominate a category's median", async () => {
    const workspaces = await seedCategory("crm", 19); // visibility 1..19, one each
    const agency = await seed("crm", 100);
    for (let i = 0; i < 30; i++) await seed("crm", 100, { workspaceId: agency.workspaceId });
    await refresh(["crm"]);
    const [row] = await rows("crm");
    expect(row.sample_size).toBe(20);
    // Twenty workspace values: 1..19 and 100. Thirty-one projects at 100 would otherwise drag the median to 100.
    expect(row.median_visibility).toBeCloseTo(10.5, 3);
    expect(workspaces).toHaveLength(19);
  });

  it("the median of a workspace's own projects is used (not the mean, the max or the first)", async () => {
    await seedCategory("crm", 19);
    const w = await seed("crm", 10);
    await seed("crm", 20, { workspaceId: w.workspaceId });
    await seed("crm", 90, { workspaceId: w.workspaceId });
    await refresh(["crm"]);
    // Its value is median(10, 20, 90) = 20, so the twenty values are 1..19 and 20: median 10.5, p75 15.25.
    const [row] = await rows("crm");
    expect(row.p75_visibility).toBeCloseTo(15.25, 3);
    expect(row.median_visibility).toBeCloseTo(10.5, 3);
  });

  it("the aux figure needs its own 20 workspaces: 20 contribute visibility but only 19 have an AUX score, so nothing is published", async () => {
    await seedCategory("crm", 19);
    await seed("crm", 20, { aux: null });
    expect(await refresh(["crm"])).toEqual({ written: 0, removed: 0 });
  });

  it("scenario 3 — a project with no category rolls up on its own and adds nothing to any category", async () => {
    await seedCategory("crm", 19);
    await seed(null, 99);
    expect(await refresh(["crm"])).toMatchObject({ written: 0 });
    expect(await db.query("SELECT count(*)::int AS n FROM metric_daily WHERE visibility_score = 99")).toMatchObject({ rows: [{ n: 1 }] });
    expect(await db.query("SELECT count(*)::int AS n FROM platform_metrics")).toMatchObject({ rows: [{ n: 0 }] });
  });

  it("a deleted project, a competitor row and an unknown engine contribute nothing", async () => {
    await seedCategory("crm", 19);
    await seed("crm", 20, { deleted: true });
    const competitorOnly = await seed("crm", null);
    await metric(competitorOnly.projectId, competitorOnly.workspaceId, 20, ENGINE, DAY, "v1", "competitor");
    const unknown = await seed("crm", null);
    await metric(unknown.projectId, unknown.workspaceId, 20, "all");
    expect(await refresh(["crm"])).toMatchObject({ written: 0 });
  });

  it("engines are separate groups and a day with a different date is a separate group", async () => {
    for (let i = 1; i <= 20; i++) {
      const { workspaceId, projectId } = await seed("crm", i);
      await metric(projectId, workspaceId, i * 2, "perplexity");
      await metric(projectId, workspaceId, i, ENGINE, "2026-11-02");
    }
    expect(await refresh(["crm"], DAY, "2026-11-02")).toMatchObject({ written: 3 });
    const all = await rows("crm");
    expect(all.map((r) => `${r.metric_date}/${r.engine_key}`)).toEqual([`${DAY}/${ENGINE}`, `${DAY}/perplexity`, `2026-11-02/${ENGINE}`]);
    expect(all.find((r) => r.engine_key === "perplexity")!.median_visibility).toBeCloseTo(21, 3);
  });

  it("when two scoring versions exist for a day, the newer one is the one that counts", async () => {
    const all = await seedCategory("crm", 20);
    for (const w of all) await metric(w.projectId, w.workspaceId, 77, ENGINE, DAY, "v2");
    await refresh(["crm"]);
    expect((await rows("crm"))[0]!.median_visibility).toBeCloseTo(77, 3);
  });

  it("top_source_domains lists a domain only when 20 distinct workspaces cite it, with no workspace id anywhere", async () => {
    const all = await seedCategory("crm", 20);
    let i = 0;
    for (const w of all) {
      i++;
      const shared = randomUUID();
      const rare = randomUUID();
      await db.query("INSERT INTO source_domains (id, workspace_id, domain) VALUES ($1,$2,'g2.com'), ($3,$2,'rare.example')", [shared, w.workspaceId, rare]);
      const psi = (domainId: string, weight: number) =>
        db.query(
          `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, context_weight)
           VALUES ($1,$2,$3,$4,'2026-10-01',90,$5)`,
          [w.workspaceId, w.projectId, domainId, ENGINE, weight],
        );
      await psi(shared, 0.2);
      // Cited by 19 workspaces only: the twentieth does not.
      if (i < 20) await psi(rare, 0.1);
    }
    await refresh(["crm"]);
    const [row] = await rows("crm");
    expect(row.top_source_domains).toEqual([{ domain: "g2.com", context_weight: 0.2 }]);
    expect(JSON.stringify(row)).not.toMatch(/workspace/);
  });

  it("scenario 4 · override — the project leaves the old slug's contribution and joins the new one; both are asserted", async () => {
    const crm = await seedCategory("crm", 20); // exactly 20: losing one drops it below the minimum
    await seedCategory("banks", 19); // 19: gaining one lifts it to the minimum
    await refresh(["crm", "banks"]);
    expect(await rows("crm")).toHaveLength(1);
    expect(await rows("banks")).toHaveLength(0);

    await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [crm[0]!.projectId]);
    expect(await refresh(["crm", "banks"])).toEqual({ written: 1, removed: 1 });

    expect(await rows("crm")).toEqual([]); // gone from the old slug: no stale value remains
    const [banks] = await rows("banks");
    expect(banks).toMatchObject({ category_slug: "banks", sample_size: 20 });
  });

  it("scenario 5 — the same recompute delivered twice leaves the same state", async () => {
    await seedCategory("crm", 20);
    await refresh(["crm"]);
    const once = await rows("crm");
    expect(await refresh(["crm"])).toEqual({ written: 1, removed: 0 });
    expect(await rows("crm")).toEqual(once);
  });

  it("a range with no contributors removes what was published for it", async () => {
    await seedCategory("crm", 20);
    await refresh(["crm"]);
    await db.query("DELETE FROM metric_daily");
    expect(await refresh(["crm"])).toEqual({ written: 0, removed: 1 });
    expect(await rows("crm")).toEqual([]);
  });

  it("refuses a nonsense request rather than guessing: a missing argument, a reversed range, an unbounded range or too many categories", async () => {
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics(NULL, $1::date, ARRAY['crm'])", [DAY])).rejects.toThrow(/refresh_platform_metrics/);
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics($1::date, $2::date, NULL)", [DAY, DAY])).rejects.toThrow(/refresh_platform_metrics/);
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics('2026-11-02'::date, '2026-11-01'::date, ARRAY['crm'])")).rejects.toThrow(/refresh_platform_metrics/);
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics('2020-01-01'::date, '2026-11-01'::date, ARRAY['crm'])")).rejects.toThrow(/refresh_platform_metrics/);
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics($1::date, $1::date, ARRAY(SELECT 'c' || g FROM generate_series(1, 300) g))", [DAY])).rejects.toThrow(/refresh_platform_metrics/);
  });

  it("an empty category list does nothing", async () => {
    await seedCategory("crm", 20);
    expect(await refresh([])).toEqual({ written: 0, removed: 0 });
  });

  describe("scenario 6 — the read path and the tenant boundary", () => {
    it("a tenant (nominara_app, one workspace's context) reads the published aggregate, and no row or column of it names a workspace", async () => {
      const all = await seedCategory("crm", 20);
      await refresh(["crm"]);
      await db.query("SET ROLE nominara_app");
      try {
        await db.query("BEGIN");
        await db.query("SELECT set_config('app.current_workspace_id', $1, true)", [all[0]!.workspaceId]);
        const read = await db.query("SELECT * FROM platform_metrics WHERE category_slug = 'crm'");
        expect(read.rowCount).toBe(1);
        expect(Object.keys(read.rows[0])).not.toContain("workspace_id");
        // Meanwhile the tenant still sees only its own project rows: the function is the one path across the boundary.
        expect((await db.query("SELECT count(*)::int AS n FROM projects")).rows[0].n).toBe(1);
        expect((await db.query("SELECT count(*)::int AS n FROM metric_daily")).rows[0].n).toBe(1);
        await db.query("COMMIT");
      } finally {
        await db.query("RESET ROLE");
      }
    });

    it("the function returns counts only, and the runtime roles may run it while PUBLIC may not", async () => {
      const cols = await db.query<{ column_name: string }>(
        `SELECT unnest(p.proargnames[p.pronargs + 1:]) AS column_name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'refresh_platform_metrics'`,
      );
      expect(cols.rows.map((c) => c.column_name)).toEqual(["groups_written", "groups_removed"]);
      const acl = await db.query<{ grantee: string }>(
        `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
           FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'refresh_platform_metrics' AND a.privilege_type = 'EXECUTE'`,
      );
      expect(acl.rows.map((r) => r.grantee).sort()).toEqual(["nominara_app", "nominara_owner", "nominara_platform_agg", "nominara_worker"]);
      for (const role of ["nominara_report", "nominara_portal"]) {
        await db.query(`SET ROLE ${role}`);
        try {
          await expect(db.query("SELECT * FROM app.refresh_platform_metrics($1::date, $1::date, ARRAY['crm'])", [DAY])).rejects.toMatchObject({ code: "42501" });
        } finally {
          await db.query("RESET ROLE");
        }
      }
    });

    it("the definer role reads only the named columns: no content column of projects, no table-level grant anywhere", async () => {
      const grants = await db.query<{ table_name: string; column_name: string; privilege_type: string }>(
        `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges WHERE grantee = 'nominara_platform_agg' AND table_schema = 'public' ORDER BY table_name, column_name`,
      );
      const byTable = new Map<string, string[]>();
      for (const g of grants.rows) byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.column_name]);
      expect(byTable.get("projects")!.sort()).toEqual(["aux_score_current", "category_slug", "deleted_at", "id", "workspace_id"]);
      expect(byTable.get("metric_daily")!.sort()).toEqual(["engine_key", "entity_type", "metric_date", "project_id", "scoring_version", "visibility_score", "workspace_id"]);
      expect(byTable.get("project_source_index")!.sort()).toEqual(["context_weight", "engine_key", "project_id", "source_domain_id", "window_days", "window_start", "workspace_id"]);
      expect(byTable.get("source_domains")!.sort()).toEqual(["domain", "id", "workspace_id"]);
      const tableLevel = await db.query(`SELECT 1 FROM information_schema.table_privileges WHERE grantee = 'nominara_platform_agg' AND table_schema = 'public' AND table_name NOT IN ('platform_metrics', 'projects', 'metric_daily', 'project_source_index', 'source_domains', 'engines')`);
      expect(tableLevel.rowCount).toBe(0);
    });

    it("readProjectBenchmark answers null engines — not [] and not zeros — when there is no aggregate, and for a project with no category", async () => {
      const [first] = await seedCategory("crm", 19);
      const none = await seed(null, 5);
      const read = (id: string, workspaceId: string) => asTenantJob(db, workspaceId, () => readProjectBenchmark(db, id));
      expect(await read(first!.projectId, first!.workspaceId)).toEqual({ project_id: first!.projectId, category_slug: "crm", engines: null });
      expect(await read(none.projectId, none.workspaceId)).toEqual({ project_id: none.projectId, category_slug: null, engines: null });
    });

    it("readProjectBenchmark returns each engine's newest aggregate for the project's category once it is published", async () => {
      const all = await seedCategory("crm", 20);
      await refresh(["crm"]);
      const read = await asTenantJob(db, all[0]!.workspaceId, () => readProjectBenchmark(db, all[0]!.projectId));
      expect(read).toMatchObject({ project_id: all[0]!.projectId, category_slug: "crm" });
      expect(read!.engines).toHaveLength(1);
      expect(read!.engines![0]).toMatchObject({ engine_key: ENGINE, metric_date: DAY, sample_size: 20, median_visibility: 10.5, top_source_domains: [] });
    });

    it("readProjectBenchmark of another workspace's project answers nothing (undefined), never that project's category", async () => {
      const all = await seedCategory("crm", 20);
      await refresh(["crm"]);
      const stranger = await seed("banks", 1);
      expect(await asTenantJob(db, stranger.workspaceId, () => readProjectBenchmark(db, all[0]!.projectId))).toBeUndefined();
    });
  });

  describe("the rollup.metric_daily handler wiring (AC1, AC4, AC5)", () => {
    const context = { pool: {} as never, env: {} as never } satisfies QueueHandlerContext;
    const handler = () => createRollupMetricDailyHandler(context, { enqueueVerifyPresence: async () => undefined, enqueueTaskGenerate: async () => undefined });
    const job = (workspaceId: string, payload: Record<string, unknown>): Job => ({ data: { payload: { workspaceId, kid: "k", ...payload } } }) as unknown as Job;

    it("AC1 — a rollup of one project recomputes its category's aggregate for the day it rolled up", async () => {
      const all = await seedCategory("crm", 20);
      await asTenantJob(db, all[0]!.workspaceId, () => handler()(db, job(all[0]!.workspaceId, { projectId: all[0]!.projectId, metricDate: DAY })));
      expect(await rows("crm")).toHaveLength(1);
    });

    it("AC4/AC5 — a category override moves the project's contribution from the old slug to the new, and a redelivery changes nothing", async () => {
      const crm = await seedCategory("crm", 20);
      await seedCategory("banks", 19);
      await refresh(["crm", "banks"]);
      const moved = crm[3]!;
      await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [moved.projectId]);

      const run = () => asTenantJob(db, moved.workspaceId, () => handler()(db, job(moved.workspaceId, { projectId: moved.projectId, reason: "category_override", previousCategorySlug: "crm" })));
      await run();
      expect(await rows("crm")).toEqual([]);
      expect(await rows("banks")).toHaveLength(1);
      const after = [await rows("crm"), await rows("banks")];
      await run();
      expect([await rows("crm"), await rows("banks")]).toEqual(after);
    });

    it("AC4 — an override recomputes the project's WHOLE history, even a span wider than the function's 400-day limit", async () => {
      const OLD = "2025-06-01"; // 518 days before DAY
      const crm: Seeded[] = [];
      for (let i = 1; i <= 20; i++) {
        const w = await seed("crm", i);
        await metric(w.projectId, w.workspaceId, i, ENGINE, OLD);
        crm.push(w);
      }
      await refresh(["crm"], OLD, OLD);
      await refresh(["crm"], DAY, DAY);
      expect((await db.query("SELECT metric_date::text FROM platform_metrics WHERE category_slug = 'crm' ORDER BY 1")).rows.map((r) => r.metric_date)).toEqual([OLD, DAY]);

      const moved = crm[0]!;
      await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [moved.projectId]);
      await asTenantJob(db, moved.workspaceId, () => handler()(db, job(moved.workspaceId, { projectId: moved.projectId, reason: "category_override", previousCategorySlug: "crm" })));
      expect(await rows("crm")).toEqual([]); // both days, at both ends of the span
    });

    it("AC6 — a project with no category still rolls up and publishes nothing", async () => {
      const lone = await seed(null, 5);
      await asTenantJob(db, lone.workspaceId, () => handler()(db, job(lone.workspaceId, { projectId: lone.projectId, metricDate: DAY })));
      expect((await db.query("SELECT count(*)::int AS n FROM platform_metrics")).rows[0].n).toBe(0);
    });

    it("observability — one span, one metric and one redacted log line per recompute: the workspace id only, no slug, score or domain", async () => {
      const all = await seedCategory("crm", 20);
      exporter.reset();
      const lines: string[] = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(typeof m === "string" ? m : JSON.stringify(m)));
      try {
        await asTenantJob(db, all[0]!.workspaceId, () => handler()(db, job(all[0]!.workspaceId, { projectId: all[0]!.projectId, metricDate: DAY, reason: "run_parsed" })));
      } finally {
        vi.restoreAllMocks();
      }
      const span = exporter.getFinishedSpans().find((x) => x.name === "rollup.category_recompute");
      expect(span).toBeDefined();
      expect(span!.attributes).toMatchObject({ "nominara.rollup.categories": 1, "nominara.rollup.groups_written": 1, "nominara.rollup.groups_removed": 0 });
      expect(lines.some((l) => l.includes('"metric":"nominara_rollup_category_recompute_total"') && l.includes('"reason":"run_parsed"'))).toBe(true);
      const log = lines.find((l) => l.includes("rollup.category_recompute") && l.includes('"event"'))!;
      expect(log).toContain(all[0]!.workspaceId);
      expect(log).not.toMatch(/crm|visibility|median|domain/);
    });

    it("the payload names the previous slug as a string and nothing else is accepted in its place", async () => {
      const lone = await seed("crm", 5);
      await expect(asTenantJob(db, lone.workspaceId, () => handler()(db, job(lone.workspaceId, { projectId: lone.projectId, previousCategorySlug: 7 })))).rejects.toThrow();
    });
  });
});
