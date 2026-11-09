import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { globalQueueLockKey, tryAdvisorySessionLock } from "../../src/lib/queue/locks.js";
import { createRollupCategoryBenchmarkHandler } from "../../src/lib/queue/handlers/rollup-category-benchmark.handler.js";
import {
  BENCHMARK_WINDOW_DAYS,
  MIN_BENCHMARK_WORKSPACES,
  applyBenchmarkMembership,
  benchmarkWindow,
  readProjectBenchmark,
  refreshCategoryBenchmark,
} from "../../src/lib/rollup/category-benchmarks.js";
import { asTenantJob } from "../support/tenant-job.js";

// STORY-176 · NFR-SEC-05 option A (owner decision 91). `platform_metrics` is filled by `app.refresh_platform_metrics`, a SECURITY DEFINER
// function that reads only the named columns of metric_daily, projects, project_source_index and source_domains, and publishes a group only
// when at least 20 DISTINCT WORKSPACES contribute (decision 88(d)). One workspace contributes ONE value per group, however many projects it has.
//
// OWNER DECISION 93 (benchmark privacy): a project counts under `benchmark_category_slug`, which moves to `category_slug` only in the nightly batch
// (`app.apply_benchmark_membership`) and at most once per 7 days; the published percentiles are whole numbers; the API shows the workspace count as the
// band "20+"; a domain carries no weight. The "hazard" test below encodes why: without them, two workspaces of one attacker could difference the aggregate.

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
  async function reset(): Promise<void> {
    await db.query("TRUNCATE platform_metrics, project_source_index, source_domains, metric_daily, projects, workspaces, engines CASCADE");
    for (const key of [ENGINE, "perplexity"]) {
      await db.query(
        `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key, status)
         VALUES ($1,$1,'v','api','1.0.0',86400,'medium','free','active')`,
        [key],
      );
    }
  }
  beforeEach(reset);

  interface Seeded {
    workspaceId: string;
    projectId: string;
  }

  /** One project in its own workspace (or in `workspaceId` when given), with a brand metric row for `score` on DAY. */
  async function seed(category: string | null, score: number | null, opts: { workspaceId?: string; aux?: number | null; engine?: string; date?: string; deleted?: boolean; benchmark?: string | null } = {}): Promise<Seeded> {
    const workspaceId = opts.workspaceId ?? randomUUID();
    if (opts.workspaceId === undefined) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    }
    const projectId = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, category_slug, aux_score_current, deleted_at, benchmark_category_slug)
       VALUES ($1,$2,'P',$3,'https://p.example','p.example',$4,$5,$6,$7)`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`, category, opts.aux === undefined ? 50 : opts.aux, opts.deleted === true ? new Date() : null, opts.benchmark === undefined ? category : opts.benchmark],
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

  async function refresh(categories: string[], from = DAY, to = DAY, version = "v1"): Promise<{ written: number; removed: number }> {
    const r = await db.query<{ groups_written: number; groups_removed: number }>("SELECT * FROM app.refresh_platform_metrics($1::date, $2::date, $3::text[], $4::text)", [from, to, categories, version]);
    return { written: r.rows[0]!.groups_written, removed: r.rows[0]!.groups_removed };
  }

  /** The nightly membership step, as the batch runs it. */
  async function applyMembership(): Promise<number> {
    return (await db.query<{ projects_moved: number }>("SELECT projects_moved FROM app.apply_benchmark_membership()")).rows[0]!.projects_moved;
  }

  const today = async (): Promise<string> => (await db.query<{ d: string }>("SELECT (now() AT TIME ZONE 'UTC')::date::text AS d")).rows[0]!.d;

  const rows = async (category: string) =>
    (await db.query("SELECT metric_date::text, category_slug, engine_key, sample_size, scoring_version, median_visibility::float8, p25_visibility::float8, p75_visibility::float8, median_aux_score::float8, top_source_domains FROM platform_metrics WHERE category_slug = $1 ORDER BY metric_date, engine_key", [category])).rows;

  it("names the minimum as a constant: 20 distinct workspaces", () => {
    expect(MIN_BENCHMARK_WORKSPACES).toBe(20);
  });

  it("scenario 1 — rollup over projects in one category writes platform_metrics rows carrying that category_slug, with percentiles rounded to whole numbers (decision 93)", async () => {
    await seedCategory("crm", 20);
    await seedCategory("banks", 3);
    expect(await refresh(["crm"])).toEqual({ written: 1, removed: 0 });
    const [row, ...rest] = await rows("crm");
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ metric_date: DAY, category_slug: "crm", engine_key: ENGINE, sample_size: 20, scoring_version: "v1" });
    // Twenty values 1..20: percentile_cont gives 10.5, 5.75 and 15.25, published as 11, 6 and 15. Never the exact figure.
    expect(row.median_visibility).toBe(11);
    expect(row.p25_visibility).toBe(6);
    expect(row.p75_visibility).toBe(15);
    expect(row.median_aux_score).toBe(50);
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
    expect(row.median_visibility).toBe(11); // 10.5, rounded
    expect(workspaces).toHaveLength(19);
  });

  it("the median of a workspace's own projects is used (not the mean, the max or the first)", async () => {
    await seedCategory("crm", 19);
    const w = await seed("crm", 10);
    await seed("crm", 20, { workspaceId: w.workspaceId });
    await seed("crm", 90, { workspaceId: w.workspaceId });
    await refresh(["crm"]);
    // Its value is median(10, 20, 90) = 20, so the twenty values are 1..19 and 20: median 10.5 and p75 15.25, published as 11 and 15.
    const [row] = await rows("crm");
    expect(row.p75_visibility).toBe(15);
    expect(row.median_visibility).toBe(11);
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
    expect(all.find((r) => r.engine_key === "perplexity")!.median_visibility).toBe(21);
  });

  it("M2 — the scoring version is an argument, never a sort: 'v10' is not older than 'v9', and the row records the version it was computed from", async () => {
    const all = await seedCategory("crm", 20);
    for (const w of all) {
      await metric(w.projectId, w.workspaceId, 20, ENGINE, DAY, "v9");
      await metric(w.projectId, w.workspaceId, 77, ENGINE, DAY, "v10");
    }
    // Text order puts 'v9' after 'v10', so `ORDER BY scoring_version DESC` would have chosen v9 here and never v10.
    await refresh(["crm"], DAY, DAY, "v10");
    expect((await rows("crm"))[0]).toMatchObject({ median_visibility: 77, scoring_version: "v10" });
    await refresh(["crm"], DAY, DAY, "v9");
    expect((await rows("crm"))[0]).toMatchObject({ median_visibility: 20, scoring_version: "v9" });
    await refresh(["crm"], DAY, DAY, "v1"); // the seeded rows
    expect((await rows("crm"))[0]).toMatchObject({ median_visibility: 11, scoring_version: "v1" });
  });

  it("M2 — during a dual-compute versions are never mixed: a project with no row at the requested version contributes nothing", async () => {
    const all = await seedCategory("crm", 20);
    // The twentieth project is only scored under v2 so far. A 'newest per project' pick would count it; the explicit version must not.
    await db.query("DELETE FROM metric_daily WHERE project_id = $1", [all[19]!.projectId]);
    await metric(all[19]!.projectId, all[19]!.workspaceId, 99, ENGINE, DAY, "v2");
    expect(await refresh(["crm"], DAY, DAY, "v1")).toEqual({ written: 0, removed: 0 });
    expect(await rows("crm")).toEqual([]);
    // Everyone scored under v2 is a complete v2 group of its own.
    for (const w of all.slice(0, 19)) await metric(w.projectId, w.workspaceId, 50, ENGINE, DAY, "v2");
    expect(await refresh(["crm"], DAY, DAY, "v2")).toEqual({ written: 1, removed: 0 });
    expect((await rows("crm"))[0]).toMatchObject({ scoring_version: "v2" });
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
    expect(row.top_source_domains).toEqual([{ domain: "g2.com" }]);
    expect(JSON.stringify(row)).not.toMatch(/workspace/);
  });

  it("decision 93 — a domain carries NO weight, only its place in the order: the most-cited first, and nothing a workspace could difference", async () => {
    const all = await seedCategory("crm", 20);
    for (const w of all) {
      const [a, b] = [randomUUID(), randomUUID()];
      await db.query("INSERT INTO source_domains (id, workspace_id, domain) VALUES ($1,$3,'smaller.example'), ($2,$3,'larger.example')", [a, b, w.workspaceId]);
      for (const [id, weight] of [[a, 0.1], [b, 0.3]] as const) {
        await db.query(
          `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, context_weight) VALUES ($1,$2,$3,$4,'2026-10-01',90,$5)`,
          [w.workspaceId, w.projectId, id, ENGINE, weight],
        );
      }
    }
    await refresh(["crm"]);
    const [row] = await rows("crm");
    expect(row.top_source_domains).toEqual([{ domain: "larger.example" }, { domain: "smaller.example" }]);
    expect(JSON.stringify(row.top_source_domains)).not.toMatch(/weight|0\.3|0\.1|share/);
  });

  describe("M3 — a recompute of a PAST day leaves its AUX median and domain list alone", () => {
    /** 20 workspaces on `date`, each citing g2.com, AUX 50; published. Then the present-day state moves on. */
    async function publishedThenDrifted(date: string): Promise<void> {
      const all: Seeded[] = [];
      for (let i = 1; i <= 20; i++) all.push(await seed("crm", i, { date }));
      for (const w of all) {
        const domain = randomUUID();
        await db.query("INSERT INTO source_domains (id, workspace_id, domain) VALUES ($1,$2,'g2.com')", [domain, w.workspaceId]);
        await db.query(
          `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, context_weight) VALUES ($1,$2,$3,$4,$5,90,0.2)`,
          [w.workspaceId, w.projectId, domain, ENGINE, date],
        );
      }
      await refresh(["crm"], date, date);
      expect((await rows("crm"))[0]).toMatchObject({ median_aux_score: 50, top_source_domains: [{ domain: "g2.com" }] });
      // Today's state: AUX scores moved, the citation windows are gone, and the visibility figures were corrected late.
      await db.query("UPDATE projects SET aux_score_current = 80");
      await db.query("DELETE FROM project_source_index");
      await db.query("UPDATE metric_daily SET visibility_score = visibility_score + 10");
    }

    it("a past day keeps the AUX median and the domains it was published with, and still takes the corrected visibility", async () => {
      await publishedThenDrifted(DAY);
      await refresh(["crm"], DAY, DAY);
      expect((await rows("crm"))[0]).toMatchObject({ median_visibility: 21, median_aux_score: 50, top_source_domains: [{ domain: "g2.com" }] });
    });

    it("the CURRENT day takes both from the present state", async () => {
      const now = await today();
      await publishedThenDrifted(now);
      await refresh(["crm"], now, now);
      expect((await rows("crm"))[0]).toMatchObject({ median_visibility: 21, median_aux_score: 80, top_source_domains: [] });
    });

    it("a past day with no row yet (never published) is computed once from the present state, since AUX is NOT NULL", async () => {
      await seedCategory("crm", 20);
      await refresh(["crm"]);
      expect((await rows("crm"))[0]).toMatchObject({ median_aux_score: 50 });
    });
  });

  it("scenario 4 · override — at the nightly batch the project leaves the old slug's contribution and joins the new one; both are asserted", async () => {
    const crm = await seedCategory("crm", 20); // exactly 20: losing one drops it below the minimum
    await seedCategory("banks", 19); // 19: gaining one lifts it to the minimum
    await refresh(["crm", "banks"]);
    expect(await rows("crm")).toHaveLength(1);
    expect(await rows("banks")).toHaveLength(0);

    await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [crm[0]!.projectId]);
    expect(await applyMembership()).toBe(1);
    expect(await refresh(["crm", "banks"])).toEqual({ written: 1, removed: 1 });

    expect(await rows("crm")).toEqual([]); // gone from the old slug: no stale value remains
    const [banks] = await rows("banks");
    expect(banks).toMatchObject({ category_slug: "banks", sample_size: 20 });
  });

  describe("M1 · decision 93 — category membership changes only at the nightly batch, and at most once per 7 days", () => {
    it("before the batch a changed category moves nothing: the project still counts under the category the last batch gave it", async () => {
      const crm = await seedCategory("crm", 20);
      await refresh(["crm"]);
      const before = await rows("crm");
      await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [crm[0]!.projectId]);
      expect(await refresh(["crm", "banks"])).toEqual({ written: 1, removed: 0 }); // recomputed, and identical
      expect(await rows("crm")).toEqual(before);
      expect(await rows("banks")).toEqual([]);
      expect((await db.query("SELECT category_slug, benchmark_category_slug FROM projects WHERE id = $1", [crm[0]!.projectId])).rows[0]).toEqual({ category_slug: "banks", benchmark_category_slug: "crm" });
    });

    it("the batch gives a changed project its new category, stamps the day, and touches nothing else about it", async () => {
      const crm = await seedCategory("crm", 20);
      await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [crm[0]!.projectId]);
      expect(await applyMembership()).toBe(1);
      const row = (await db.query("SELECT category_slug, benchmark_category_slug, benchmark_category_applied_at IS NOT NULL AS stamped FROM projects WHERE id = $1", [crm[0]!.projectId])).rows[0];
      expect(row).toEqual({ category_slug: "banks", benchmark_category_slug: "banks", stamped: true });
      expect(await applyMembership()).toBe(0); // idempotent: a second batch the same day moves nothing
    });

    it("COOLDOWN — a project that changed at the last batch keeps counting under that category for 7 days, whatever its category says; then the next batch applies it", async () => {
      const crm = await seedCategory("crm", 20);
      const p = crm[0]!.projectId;
      await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [p]);
      expect(await applyMembership()).toBe(1); // crm -> banks, stamped now
      await db.query("UPDATE projects SET category_slug = 'airlines' WHERE id = $1", [p]);
      expect(await applyMembership()).toBe(0); // the same night's next batch: cooldown
      await db.query("UPDATE projects SET benchmark_category_applied_at = now() - interval '6 days 23 hours' WHERE id = $1", [p]);
      expect(await applyMembership()).toBe(0); // one hour short of 7 days
      expect((await db.query("SELECT benchmark_category_slug AS c FROM projects WHERE id = $1", [p])).rows[0].c).toBe("banks");
      // During the cooldown the project counts under banks: crm has lost it, banks has it, airlines has not.
      await refresh(["crm", "banks", "airlines"]);
      expect(await rows("crm")).toEqual([]);
      await db.query("UPDATE projects SET benchmark_category_applied_at = now() - interval '7 days' WHERE id = $1", [p]);
      expect(await applyMembership()).toBe(1); // 7 days: free to change, and it takes the category it holds NOW (airlines), not the one in between
      expect((await db.query("SELECT benchmark_category_slug AS c FROM projects WHERE id = $1", [p])).rows[0].c).toBe("airlines");
    });

    it("a change that is reverted before the batch is no change at all: nothing is stamped, so the cooldown does not start", async () => {
      const crm = await seedCategory("crm", 20);
      await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [crm[0]!.projectId]);
      await db.query("UPDATE projects SET category_slug = 'crm' WHERE id = $1", [crm[0]!.projectId]);
      expect(await applyMembership()).toBe(0);
      expect((await db.query("SELECT benchmark_category_applied_at AS at FROM projects WHERE id = $1", [crm[0]!.projectId])).rows[0].at).toBeNull();
    });

    it("M4 — a first assignment (null to B) takes effect at the batch and brings the project's history in the window with it, not just its newest day", async () => {
      await seedCategory("banks", 19);
      const days = ["2026-10-30", "2026-10-31", DAY];
      for (const w of (await db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM projects WHERE category_slug = 'banks'")).rows) {
        for (const d of days.slice(0, 2)) await metric(w.id, w.workspace_id, 10, ENGINE, d);
      }
      const late = await seed(null, 30, { date: DAY });
      for (const d of days.slice(0, 2)) await metric(late.projectId, late.workspaceId, 30, ENGINE, d);
      await refresh(["banks"], days[0], DAY);
      expect(await rows("banks")).toEqual([]); // 19 workspaces
      await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [late.projectId]);
      expect(await applyMembership()).toBe(1); // never stamped: the first assignment is free
      expect(await refresh(["banks"], days[0], DAY)).toMatchObject({ written: 3 }); // every day of the history, not only the newest
      expect((await rows("banks")).map((r) => r.metric_date)).toEqual(["2026-10-30", "2026-10-31", DAY]);
    });

    it("a project that loses its category leaves at the batch", async () => {
      const crm = await seedCategory("crm", 20);
      await refresh(["crm"]);
      await db.query("UPDATE projects SET category_slug = NULL WHERE id = $1", [crm[0]!.projectId]);
      expect(await applyMembership()).toBe(1);
      expect(await refresh(["crm"])).toEqual({ written: 0, removed: 1 });
    });

    it("the cooldown is not an argument: the function takes none, so a caller cannot shorten it", async () => {
      const r = await db.query("SELECT pronargs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'apply_benchmark_membership'");
      expect(r.rows).toEqual([{ pronargs: 0 }]);
    });

    it("HAZARD (the differencing attack of decision 93) — one workspace's change, seen before and after one batch, does not reveal that workspace's exact value or a neighbour's", async () => {
      // An attacker with two workspaces moves a project out of the category, triggers a recompute and reads the benchmark before and after. In the
      // old design both reads carried the exact sample size and exact percentiles, so the difference solved for the mover's value (and, knowing their
      // own, a neighbour's). Two worlds that differ ONLY in a neighbour's exact value (11 or 11.4, both of which round to 11) must publish the same
      // output before AND after the change. Run twice and compared: if the figures were exact, they would differ.
      const read = async (workspaceId: string, projectId: string) => asTenantJob(db, workspaceId, () => readProjectBenchmark(db, projectId, new Date(`${DAY}T12:00:00Z`)));
      async function world(neighbour: number) {
        await reset();
        const all: Seeded[] = [];
        for (let i = 1; i <= 22; i++) all.push(await seed("crm", i === 11 ? neighbour : i));
        const attacker = all[21]!; // value 22: the top of the category
        const mine = all[0]!;
        await refresh(["crm", "banks"]);
        const before = await read(mine.workspaceId, mine.projectId);
        // The attacker overrides the category and asks for a recompute RIGHT NOW. Nothing changes: membership moves only at the batch.
        await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [attacker.projectId]);
        await refresh(["crm", "banks"]);
        const immediately = await read(mine.workspaceId, mine.projectId);
        await applyMembership();
        await refresh(["crm", "banks"]);
        const after = await read(mine.workspaceId, mine.projectId);
        return { before, immediately, after };
      }
      const a = await world(11);
      const b = await world(11.4);

      // The two worlds have different project ids by construction; what an observer reads is the category and the engine figures.
      const view = (out: Awaited<ReturnType<typeof read>>) => ({ category_slug: out!.category_slug, engines: out!.engines });
      expect(view(a.immediately)).toEqual(view(a.before));
      expect(view(a.after)).toEqual(view(b.after));
      expect(view(a.before)).toEqual(view(b.before));
      for (const out of [a.before, a.after]) {
        const engine = out!.engines![0]!;
        expect(engine.workspace_count_band).toBe("20+"); // 22 before, 21 after: the same band
        for (const v of [engine.median_visibility, engine.p25_visibility, engine.p75_visibility, engine.median_aux_score]) expect(Number.isInteger(v)).toBe(true);
        expect(JSON.stringify(out)).not.toMatch(/sample_size|context_weight|workspace_id/);
      }
      // And the mover's departure still moves the published median by a rounded step (22 values to 21), so the benchmark is not frozen.
      expect(a.before!.engines![0]!.median_visibility).toBe(12);
      expect(a.after!.engines![0]!.median_visibility).toBe(11);
    });
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
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics(NULL, $1::date, ARRAY['crm'], 'v1')", [DAY])).rejects.toThrow(/refresh_platform_metrics/);
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics($1::date, $2::date, NULL, 'v1')", [DAY, DAY])).rejects.toThrow(/refresh_platform_metrics/);
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics($1::date, $1::date, ARRAY['crm'], NULL)", [DAY])).rejects.toThrow(/refresh_platform_metrics/);
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics($1::date, $1::date, ARRAY['crm'], '')", [DAY])).rejects.toThrow(/refresh_platform_metrics/);
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics('2026-11-02'::date, '2026-11-01'::date, ARRAY['crm'], 'v1')")).rejects.toThrow(/refresh_platform_metrics/);
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics('2020-01-01'::date, '2026-11-01'::date, ARRAY['crm'], 'v1')")).rejects.toThrow(/refresh_platform_metrics/);
    await expect(db.query("SELECT * FROM app.refresh_platform_metrics($1::date, $1::date, ARRAY(SELECT 'c' || g FROM generate_series(1, 300) g), 'v1')", [DAY])).rejects.toThrow(/refresh_platform_metrics/);
  });

  it("an empty category list does nothing", async () => {
    await seedCategory("crm", 20);
    expect(await refresh([])).toEqual({ written: 0, removed: 0 });
  });

  describe("scenario 6 — the read path and the tenant boundary", () => {
    const NOW = new Date(`${DAY}T12:00:00Z`);

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

    it("the runtime roles can READ platform_metrics and cannot write it: the definer is the only writer", async () => {
      await seedCategory("crm", 20);
      await refresh(["crm"]);
      for (const role of ["nominara_app", "nominara_worker", "nominara_report", "nominara_portal"]) {
        await db.query(`SET ROLE ${role}`);
        try {
          expect((await db.query("SELECT count(*)::int AS n FROM platform_metrics")).rows[0].n).toBe(1);
          await expect(db.query("UPDATE platform_metrics SET sample_size = 20")).rejects.toMatchObject({ code: "42501" });
          await expect(db.query("DELETE FROM platform_metrics")).rejects.toMatchObject({ code: "42501" });
          await expect(
            db.query(`INSERT INTO platform_metrics (metric_date, category_slug, engine_key, sample_size, median_visibility, p25_visibility, p75_visibility, median_aux_score, top_source_domains) VALUES ('2026-01-01', 'x', '${ENGINE}', 20, 1, 1, 1, 1, '[]')`),
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await db.query("RESET ROLE");
        }
      }
    });

    it("the functions return counts only, and the runtime roles may run them while PUBLIC, the report role and the portal role may not", async () => {
      const cols = async (name: string) =>
        (await db.query<{ column_name: string }>(
          `SELECT unnest(p.proargnames[p.pronargs + 1:]) AS column_name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = $1`,
          [name],
        )).rows.map((c) => c.column_name);
      expect(await cols("refresh_platform_metrics")).toEqual(["groups_written", "groups_removed"]);
      expect(await cols("apply_benchmark_membership")).toEqual(["projects_moved"]);
      for (const fn of ["refresh_platform_metrics", "apply_benchmark_membership"]) {
        const acl = await db.query<{ grantee: string }>(
          `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
             FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = $1 AND a.privilege_type = 'EXECUTE'`,
          [fn],
        );
        expect(acl.rows.map((r) => r.grantee).sort(), fn).toEqual(["nominara_app", "nominara_owner", "nominara_platform_agg", "nominara_worker"]);
      }
      for (const role of ["nominara_report", "nominara_portal"]) {
        await db.query(`SET ROLE ${role}`);
        try {
          await expect(db.query("SELECT * FROM app.refresh_platform_metrics($1::date, $1::date, ARRAY['crm'], 'v1')", [DAY])).rejects.toMatchObject({ code: "42501" });
          await expect(db.query("SELECT * FROM app.apply_benchmark_membership()")).rejects.toMatchObject({ code: "42501" });
        } finally {
          await db.query("RESET ROLE");
        }
      }
    });

    it("the definer role reads only the named columns, writes only the two membership columns of projects, and has no table-level grant", async () => {
      const grants = await db.query<{ table_name: string; column_name: string; privilege_type: string }>(
        `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges WHERE grantee = 'nominara_platform_agg' AND table_schema = 'public' ORDER BY table_name, column_name`,
      );
      const colsOf = (table: string, privilege: string) => grants.rows.filter((g) => g.table_name === table && g.privilege_type === privilege).map((g) => g.column_name).sort();
      expect(colsOf("projects", "SELECT")).toEqual(["aux_score_current", "benchmark_category_applied_at", "benchmark_category_slug", "category_slug", "deleted_at", "id", "workspace_id"]);
      expect(colsOf("projects", "UPDATE")).toEqual(["benchmark_category_applied_at", "benchmark_category_slug"]);
      expect(colsOf("projects", "INSERT")).toEqual([]);
      expect(colsOf("metric_daily", "SELECT")).toEqual(["engine_key", "entity_type", "metric_date", "project_id", "scoring_version", "visibility_score", "workspace_id"]);
      expect(colsOf("project_source_index", "SELECT")).toEqual(["context_weight", "engine_key", "project_id", "source_domain_id", "window_days", "window_start", "workspace_id"]);
      expect(colsOf("source_domains", "SELECT")).toEqual(["domain", "id", "workspace_id"]);
      for (const table of ["metric_daily", "project_source_index", "source_domains"]) {
        for (const privilege of ["INSERT", "UPDATE"]) expect(colsOf(table, privilege), `${table} ${privilege}`).toEqual([]);
      }
      const tableLevel = await db.query(`SELECT 1 FROM information_schema.table_privileges WHERE grantee = 'nominara_platform_agg' AND table_schema = 'public' AND table_name NOT IN ('platform_metrics', 'projects', 'metric_daily', 'project_source_index', 'source_domains', 'engines')`);
      expect(tableLevel.rowCount).toBe(0);
    });

    it("readProjectBenchmark answers null engines — not [] and not zeros — when there is no aggregate, and for a project with no category", async () => {
      const [first] = await seedCategory("crm", 19);
      const none = await seed(null, 5);
      const read = (id: string, workspaceId: string) => asTenantJob(db, workspaceId, () => readProjectBenchmark(db, id, NOW));
      expect(await read(first!.projectId, first!.workspaceId)).toEqual({ project_id: first!.projectId, category_slug: "crm", engines: null });
      expect(await read(none.projectId, none.workspaceId)).toEqual({ project_id: none.projectId, category_slug: null, engines: null });
    });

    it("readProjectBenchmark returns each engine's newest aggregate for the project's category once it is published, as whole numbers and the band", async () => {
      const all = await seedCategory("crm", 20);
      await refresh(["crm"]);
      const read = await asTenantJob(db, all[0]!.workspaceId, () => readProjectBenchmark(db, all[0]!.projectId, NOW));
      expect(read).toMatchObject({ project_id: all[0]!.projectId, category_slug: "crm" });
      expect(read!.engines).toHaveLength(1);
      expect(read!.engines![0]).toEqual({ engine_key: ENGINE, metric_date: DAY, workspace_count_band: "20+", median_visibility: 11, p25_visibility: 6, p75_visibility: 15, median_aux_score: 50, top_source_domains: [] });
    });

    it("STALE — a row older than the batch window is not served: a category that has since fallen below 20 answers null, not old figures", async () => {
      const all = await seedCategory("crm", 20);
      await refresh(["crm"]);
      const read = (now: string) => asTenantJob(db, all[0]!.workspaceId, () => readProjectBenchmark(db, all[0]!.projectId, new Date(now)));
      expect(BENCHMARK_WINDOW_DAYS).toBe(7);
      expect(benchmarkWindow(new Date("2026-11-07T23:59:59Z"))).toEqual({ from: "2026-11-01", to: "2026-11-07" });
      expect((await read("2026-11-07T23:59:59Z"))!.engines).toHaveLength(1); // the oldest day of the window
      expect(await read("2026-11-08T00:00:00Z")).toEqual({ project_id: all[0]!.projectId, category_slug: "crm", engines: null }); // one day older
    });

    it("an engine whose newest row is stale is dropped while a fresher engine stays", async () => {
      const all = await seedCategory("crm", 20);
      for (const w of all) await metric(w.projectId, w.workspaceId, 5, "perplexity", "2026-11-08");
      await refresh(["crm"], DAY, "2026-11-08");
      const read = await asTenantJob(db, all[0]!.workspaceId, () => readProjectBenchmark(db, all[0]!.projectId, new Date("2026-11-08T12:00:00Z")));
      expect(read!.engines!.map((e) => e.engine_key)).toEqual(["perplexity"]);
    });

    it("readProjectBenchmark of another workspace's project answers nothing (undefined), never that project's category", async () => {
      const all = await seedCategory("crm", 20);
      await refresh(["crm"]);
      const stranger = await seed("banks", 1);
      expect(await asTenantJob(db, stranger.workspaceId, () => readProjectBenchmark(db, all[0]!.projectId, NOW))).toBeUndefined();
    });
  });

  describe("M6 — the aggregate is its own nightly job, not a step of any workspace's rollup", () => {
    const NOW = new Date(`${DAY}T12:00:00Z`);
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
    });
    afterAll(async () => {
      await pool.end();
    });
    const context = () => ({ pool, env: {} as never }) satisfies QueueHandlerContext;
    const nightly = (deps: Parameters<typeof createRollupCategoryBenchmarkHandler>[1] = {}) => createRollupCategoryBenchmarkHandler(context(), { now: () => NOW, ...deps });
    const run = (deps?: Parameters<typeof createRollupCategoryBenchmarkHandler>[1]) => nightly(deps)(db, {} as Job);
    const taxonomy = async () => (await db.query<{ slug: string }>("SELECT slug FROM business_categories ORDER BY slug")).rows.map((r) => r.slug);

    it("the nightly job applies the membership batch and then recomputes every category over the window: a project's change lands, and the old category loses it", async () => {
      const crm = await seedCategory("crm", 20);
      await seedCategory("banks", 19);
      await refresh(["crm", "banks"]);
      await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [crm[0]!.projectId]);
      expect(await rows("banks")).toEqual([]); // nothing moves before the job
      const outcome = await run();
      expect(outcome).toMatchObject({ status: "complete", projectsMoved: 1 });
      expect(await rows("crm")).toEqual([]);
      expect(await rows("banks")).toHaveLength(1);
    });

    it("the membership step on its own is one short transaction that returns a count, and leaves no session limit behind", async () => {
      const crm = await seedCategory("crm", 20);
      await db.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [crm[0]!.projectId]);
      expect(await applyBenchmarkMembership(pool)).toBe(1);
      expect(await applyBenchmarkMembership(pool)).toBe(0);
      const client = await pool.connect();
      try {
        expect((await client.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
      } finally {
        client.release();
      }
    });

    it("it covers every category of the taxonomy, and a category that has rows but is no longer in it", async () => {
      const seen: string[] = [];
      const record = async (_pool: Pool, category: string): Promise<{ written: number; removed: number }> => {
        seen.push(category);
        return { written: 0, removed: 0 };
      };
      await run({ refreshCategory: record });
      expect([...seen].sort()).toEqual([...(await taxonomy())].sort());
      // A row published under a slug the taxonomy does not have (the FK is NOT VALID, so such values can predate it).
      await db.query(
        `INSERT INTO platform_metrics (metric_date, category_slug, engine_key, sample_size, median_visibility, p25_visibility, p75_visibility, median_aux_score, top_source_domains)
         VALUES ($1, 'legacy_slug', $2, 20, 50, 40, 60, 70, '[]'::jsonb)`,
        [DAY, ENGINE],
      );
      seen.length = 0;
      await run({ refreshCategory: record });
      expect(seen).toContain("legacy_slug"); // so a published row for it is re-evaluated and can be removed
    });

    it("an aggregate failure in one category does not stop the others and is reported: the job fails AFTER every category was tried", async () => {
      const crm = await seedCategory("crm", 20);
      await seedCategory("banks", 20);
      const failing = (category: string) => async (p: Pool, c: string, o: Parameters<typeof refreshCategoryBenchmark>[2]) => {
        if (c === category) throw new Error("boom");
        return refreshCategoryBenchmark(p, c, o);
      };
      await expect(run({ refreshCategory: failing("crm") })).rejects.toThrow(/1 of \d+ categor/);
      expect(await rows("banks")).toHaveLength(1); // the rest still ran
      expect(await rows("crm")).toEqual([]);
      await expect(run()).resolves.toMatchObject({ status: "complete" }); // the retry lands it
      expect(await rows("crm")).toHaveLength(1);
      expect(crm).toHaveLength(20);
    });

    it("TIMEOUTS — a category whose lock is held is abandoned after the lock timeout instead of waiting; its transaction is short and sets both limits locally", async () => {
      await seedCategory("crm", 20);
      const holder = new Client({ connectionString: container.getConnectionUri() });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('platform_metrics:crm', 0))");
        const started = Date.now();
        await expect(refreshCategoryBenchmark(pool, "crm", { now: NOW, lockTimeoutMs: 250 })).rejects.toMatchObject({ code: "55P03" });
        expect(Date.now() - started).toBeLessThan(5_000);
        await holder.query("COMMIT");
      } finally {
        await holder.end();
      }
      await expect(refreshCategoryBenchmark(pool, "crm", { now: NOW })).resolves.toMatchObject({ written: 1 });
      // The pool's session carries no leftover limit: the settings were transaction-local.
      const client = await pool.connect();
      try {
        expect((await client.query("SHOW lock_timeout")).rows[0].lock_timeout).toBe("0");
        expect((await client.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
      } finally {
        client.release();
      }
    });

    it("the timeouts are set with set_config(..., is_local) BEFORE the function runs, inside one BEGIN/COMMIT", async () => {
      const statements: string[] = [];
      const spy = {
        connect: async () => {
          const client = await pool.connect();
          return {
            query: async (sql: string, params?: unknown[]) => {
              statements.push(sql);
              return client.query(sql, params);
            },
            release: () => client.release(),
          };
        },
      } as unknown as Pool;
      await refreshCategoryBenchmark(spy, "crm", { now: NOW });
      const flat = statements.map((x) => x.replace(/\s+/g, " ").trim());
      const at = (needle: string) => flat.findIndex((x) => x.includes(needle));
      expect(flat[0]).toBe("BEGIN");
      expect(at("lock_timeout")).toBeGreaterThan(0);
      expect(at("statement_timeout")).toBeGreaterThan(0);
      expect(flat.filter((x) => x.includes("set_config")).every((x) => x.includes("true"))).toBe(true);
      expect(at("refresh_platform_metrics")).toBeGreaterThan(Math.max(at("lock_timeout"), at("statement_timeout")));
      expect(flat[flat.length - 1]).toBe("COMMIT");
    });

    it("observability — one span, one metric and one redacted log line per run: counts only, no slug, score or domain", async () => {
      await seedCategory("crm", 20);
      exporter.reset();
      const lines: string[] = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(typeof m === "string" ? m : JSON.stringify(m)));
      try {
        await run();
      } finally {
        vi.restoreAllMocks();
      }
      const span = exporter.getFinishedSpans().find((x) => x.name === "rollup.category_benchmark");
      expect(span).toBeDefined();
      expect(span!.attributes).toMatchObject({ "nominara.rollup.groups_written": 1, "nominara.rollup.groups_removed": 0, "nominara.rollup.categories_failed": 0 });
      expect(exporter.getFinishedSpans().some((x) => x.name === "rollup.category_recompute")).toBe(true);
      expect(lines.some((l) => l.includes('"metric":"nominara_rollup_category_recompute_total"') && l.includes('"reason":"nightly"'))).toBe(true);
      const log = lines.find((l) => l.includes("rollup.category_benchmark.run"))!;
      expect(log).toBeDefined();
      expect(log).not.toMatch(/crm|visibility|median|domain|workspace/);
    });

    it("it is single-flight across replicas: a replica that cannot take the session lock yields and does nothing", async () => {
      await seedCategory("crm", 20);
      const holder = new Client({ connectionString: container.getConnectionUri() });
      await holder.connect();
      try {
        expect(await tryAdvisorySessionLock(holder, globalQueueLockKey("rollup.category_benchmark"))).toBe(true);
        expect(await run()).toEqual({ status: "yielded" });
        expect(await rows("crm")).toEqual([]);
      } finally {
        await holder.end(); // ending the session releases its lock
      }
      expect(await run()).toMatchObject({ status: "complete" });
    });
  });

  describe("the rollup.metric_daily handler no longer touches the category aggregate", () => {
    const context = { pool: {} as never, env: {} as never } satisfies QueueHandlerContext;
    const handler = () => createRollupMetricDailyHandler(context, { enqueueVerifyPresence: async () => undefined, enqueueTaskGenerate: async () => undefined });
    const job = (workspaceId: string, payload: Record<string, unknown>): Job => ({ data: { payload: { workspaceId, kid: "k", ...payload } } }) as unknown as Job;

    it("M6 — a tenant's own rollup computes no benchmark: platform_metrics stays untouched, so an aggregate failure can never roll a tenant's rollup back", async () => {
      const all = await seedCategory("crm", 20);
      await asTenantJob(db, all[0]!.workspaceId, () => handler()(db, job(all[0]!.workspaceId, { projectId: all[0]!.projectId, metricDate: DAY })));
      expect(await rows("crm")).toEqual([]);
      expect((await db.query("SELECT count(*)::int AS n FROM platform_metrics")).rows[0].n).toBe(0);
    });

    it("a category_override job still rolls the project up (its own derived values), and accepts no previous-slug field any more", async () => {
      const lone = await seed("crm", 5);
      await asTenantJob(db, lone.workspaceId, () => handler()(db, job(lone.workspaceId, { projectId: lone.projectId, reason: "category_override" })));
      await expect(asTenantJob(db, lone.workspaceId, () => handler()(db, job(lone.workspaceId, { projectId: lone.projectId, previousCategorySlug: "crm" })))).rejects.toThrow();
    });
  });
});
