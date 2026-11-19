import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { aggregateRange, aggregateRangeByDay } from "../../src/lib/rollup/aggregate-day.js";
import { rollUpDay } from "../../src/lib/rollup/roll-up-day.js";
import { GrowthMapService } from "../../src/modules/analytics/growth-map.service.js";
import { ScorecardsService } from "../../src/modules/analytics/scorecards.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-090 AC8 - the topic-cluster multi-select on the two reads the Overview filters. The figures are the SAME formulas over the member prompts of the
// chosen clusters (a cluster's score is never a second formula - STORY-188), with the engine filter and the custom range applied together.
//
// Fixture: two clusters. Cluster A's prompt is answered with the brand present on every cell (3 cells); cluster B's prompt never names it (3 cells).
// The project as a whole therefore reads 3 of 6 present; A alone 3 of 3; B alone 0 of 3; A and B together 3 of 6.

describe("STORY-090 AC8 · topic-cluster filter on scorecards and the growth map", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let clusterA: string;
  let clusterB: string;
  let promptA: string;
  let promptB: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  async function addCluster(label: string, project: string, workspace: string): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO topic_clusters (id, workspace_id, project_id, label) VALUES ($1,$2,$3,$4)", [id, workspace, project, label]);
    return id;
  }

  async function addPrompt(cluster: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status,cluster_id)
       VALUES ($1,$2,$3,$4,sha256($4::text::bytea),'recommendation','consideration',false,'active',$5)`,
      [id, workspaceId, projectId, `q-${id}`, cluster],
    );
    return id;
  }

  beforeEach(async () => {
    await db.query(
      "TRUNCATE metric_daily, mention_facts, citation_facts, answer_captures, tracked_prompts, topic_clusters, competitors, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query("INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com')", [
      projectId,
      workspaceId,
      `p-${randomUUID().slice(0, 8)}`,
    ]);
    for (const [engine, minPlan] of [
      ["google_ai_mode", "growth"],
      ["chatgpt", "free"],
    ] as const) {
      await db.query(
        `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,cache_ttl_seconds,volatility_band,min_plan_key,status,cadence_by_plan)
         VALUES ($1,$1,'v','api','1.0.0',86400,'medium',$2,'active','{}'::jsonb) ON CONFLICT (key) DO NOTHING`,
        [engine, minPlan],
      );
      await db.query("INSERT INTO project_engines (workspace_id,project_id,engine_key,enabled,sample_count,weight) VALUES ($1,$2,$3,true,1,1)", [workspaceId, projectId, engine]);
    }
    clusterA = await addCluster("Pricing", projectId, workspaceId);
    clusterB = await addCluster("Support", projectId, workspaceId);
    promptA = await addPrompt(clusterA);
    promptB = await addPrompt(clusterB);
  });

  const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
  const dateOf = (n: number): string => daysAgo(n).slice(0, 10);

  async function addCell(promptId: string, capturedAt: string, engineKey: string, brandPresent: boolean): Promise<void> {
    const resultId = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present,scoring_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,'api','1.0.0','n1',$8,'{}'::jsonb,'{}','live','parsed',$9,'v1')`,
      [resultId, workspaceId, projectId, uuidV7(), promptId, engineKey, capturedAt, createHash("sha256").update(resultId).digest(), brandPresent],
    );
    if (brandPresent) {
      await db.query(
        `INSERT INTO mention_facts
           (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_id,entity_label,matched_alias,occurrence_index,char_start,char_end,first_token_index,
            prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,render_score,scoring_version)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,'brand',NULL,'HubSpot','HubSpot',0,0,1,0,0.8,'positive',0.5,0.9,'lexicon',0.4,'v1')`,
        [workspaceId, projectId, resultId, promptId, engineKey, capturedAt],
      );
    }
  }

  /** Cluster A: present on 2 google_ai_mode + 1 chatgpt cell. Cluster B: absent on 1 google_ai_mode + 2 chatgpt cells. All inside the last 5 days. */
  async function seed(): Promise<void> {
    await addCell(promptA, daysAgo(1), "google_ai_mode", true);
    await addCell(promptA, daysAgo(2), "google_ai_mode", true);
    await addCell(promptA, daysAgo(2), "chatgpt", true);
    await addCell(promptB, daysAgo(1), "google_ai_mode", false);
    await addCell(promptB, daysAgo(2), "chatgpt", false);
    await addCell(promptB, daysAgo(3), "chatgpt", false);
    for (const n of [1, 2, 3]) await rollUpDay(db, workspaceId, projectId, dateOf(n), "UTC");
  }

  const ctx = () => ({ workspaceId, actorId: randomUUID() });
  const scorecards = (query: Record<string, unknown>, project = projectId) =>
    withTenantContext(db, ctx(), () => new ScorecardsService().scorecards(project, { timeframe: "30d", ...query } as never)) as ReturnType<ScorecardsService["scorecards"]>;
  const growthMap = (query: Record<string, unknown>) =>
    withTenantContext(db, ctx(), () => new GrowthMapService().growthMap(projectId, { timeframe: "30d", ...query } as never)) as ReturnType<GrowthMapService["growthMap"]>;

  it("STORY-090 AC8 · scorecards: one cluster narrows the figures to its prompts, and two clusters together cover both", async () => {
    await seed();
    const whole = await scorecards({});
    expect(whole.blended.metrics).toMatchObject({ cells_total: 6, cells_present: 3 });

    const a = await scorecards({ topics: clusterA });
    expect(a.blended.metrics).toMatchObject({ cells_total: 3, cells_present: 3, presence_rate: 1 });
    const b = await scorecards({ topics: clusterB });
    // ZERO IS A REAL RESULT: cluster B was measured and never named the brand - presence 0, not null.
    expect(b.blended.metrics).toMatchObject({ cells_total: 3, cells_present: 0, presence_rate: 0 });

    const both = await scorecards({ topics: `${clusterA},${clusterB}` });
    expect(both.blended.metrics).toMatchObject({ cells_total: whole.blended.metrics.cells_total, cells_present: whole.blended.metrics.cells_present });
    expect(both.blended.visibility_score).toBe(whole.blended.visibility_score);
  });

  it("STORY-090 AC8 · scorecards: topics, engines and a custom range are applied together", async () => {
    await seed();
    const result = await scorecards({ topics: clusterA, engines: "chatgpt" });
    expect(result.engines.map((e) => e.engine_key)).toEqual(["chatgpt"]);
    expect(result.engines[0]!.metrics).toMatchObject({ cells_total: 1, cells_present: 1 });

    // Custom range covering only day -2: cluster A has two cells that day (one per engine); day -1's cell is outside.
    const ranged = await scorecards({ topics: clusterA, timeframe: "custom", from: dateOf(2), to: dateOf(2) });
    expect(ranged.timeframe).toBe("custom");
    expect(ranged.blended.metrics.cells_total).toBe(2);
  });

  it("STORY-090 AC8 · scorecards: a cluster with no answered cell in the window reads null, not zero", async () => {
    await seed();
    const empty = await addCluster("Empty", projectId, workspaceId);
    const result = await scorecards({ topics: empty });
    expect(result.blended.metrics.cells_total).toBe(0);
    expect(result.blended.metrics.presence_rate).toBeNull();
    expect(result.blended.visibility_score).toBeNull();
  });

  it("STORY-090 AC8 · scorecards: an unknown cluster id and another project's cluster id are a 400 naming `topics`, never dropped", async () => {
    await seed();
    const otherProject = randomUUID();
    await db.query("INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Other',$3,'https://o.test','o.test')", [otherProject, workspaceId, `o-${randomUUID().slice(0, 8)}`]);
    const foreign = await addCluster("Foreign", otherProject, workspaceId);
    for (const topics of [randomUUID(), foreign, `${clusterA},${foreign}`]) {
      await expect(scorecards({ topics })).rejects.toMatchObject({ code: "validation_failed", details: { issues: [{ path: ["topics"] }] } });
      await expect(growthMap({ topics })).rejects.toMatchObject({ code: "validation_failed", details: { issues: [{ path: ["topics"] }] } });
    }
  });

  it("STORY-090 AC8 · scorecards: no topics is unchanged from the unfiltered read", async () => {
    await seed();
    const plain = await scorecards({});
    const explicitNone = await scorecards({ topics: undefined });
    expect(explicitNone).toEqual(plain);
  });

  it("STORY-090 AC8 · growth map: one cluster plots only its prompts' days, and no topics is the stored rollup unchanged", async () => {
    await seed();
    const whole = await growthMap({});
    const brandAt = (doc: Awaited<ReturnType<typeof growthMap>>, day: string) => doc.series.find((s) => s.series_id === "brand")!.points.find((p) => p.d === day)!;

    const a = await growthMap({ topics: clusterA });
    // Day -3 has only cluster B's cell: with A selected the day has no cells, so the point is a gap (null), not a 0.
    expect(brandAt(a, dateOf(3))).toMatchObject({ visibility_score: null, cells: 0 });
    expect(brandAt(a, dateOf(2)).cells).toBe(2);
    expect(brandAt(a, dateOf(1)).cells).toBe(1);
    expect(brandAt(whole, dateOf(3)).cells).toBe(1);
    expect(brandAt(whole, dateOf(2)).cells).toBe(3);

    const both = await growthMap({ topics: `${clusterA},${clusterB}` });
    for (const n of [1, 2, 3]) {
      expect(brandAt(both, dateOf(n)).cells).toBe(brandAt(whole, dateOf(n)).cells);
      // The stored rollup is numeric(6,3), so it is the computed figure rounded half-up to 3 places; the filtered series is computed unrounded. They
      // differ by at most HALF a storage unit, and exactly half (39.0625 vs 39.063) is a legitimate tie. toBeCloseTo(_, 3) is strict `< 0.0005`.
      expect(Math.abs(brandAt(both, dateOf(n)).visibility_score! - brandAt(whole, dateOf(n)).visibility_score!)).toBeLessThanOrEqual(0.0005 + 1e-9);
    }
    expect(await growthMap({ topics: undefined })).toEqual(whole);
  });

  it("batch 19 fix · aggregateRangeByDay is, per day, exactly aggregateRange over that day (one SQL, grouped) - and keeps two scoring versions apart", async () => {
    await seed();
    // A cell of an OLDER scoring version on day -2 of cluster A: it must land in its own (day, version) group, never in v1's figures.
    const resultId = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present,scoring_version)
       VALUES ($1,$2,$3,$4,$5,'chatgpt',$6::timestamptz,'api','1.0.0','n1',$7,'{}'::jsonb,'{}','live','parsed',false,'v0')`,
      [resultId, workspaceId, projectId, uuidV7(), promptA, daysAgo(2), createHash("sha256").update(resultId).digest()],
    );
    await withTenantContext(db, ctx(), async (tx) => {
      const grouped = await aggregateRangeByDay(tx, projectId, dateOf(5), dateOf(0), "UTC", clusterA);
      const key = (a: { metricDate: string; engineKey: string; entityType: string; entityId: string }): string => `${a.metricDate}|${a.engineKey}|${a.entityType}|${a.entityId}`;
      for (const n of [1, 2, 3]) {
        const perDay = await aggregateRange(tx, projectId, dateOf(n), dateOf(n), "UTC", "v1", undefined, clusterA);
        const fromGroup = grouped.filter((g) => g.metricDate === dateOf(n) && g.scoringVersion === "v1");
        const strip = <T extends object>(rows: T[]) => rows.map((r) => ({ ...r })).sort((l, r) => (key(l as never) < key(r as never) ? -1 : 1));
        expect(strip(fromGroup.map(({ metricDate: _day, scoringVersion: _version, newestCaptureMs: _newest, ...rest }) => ({ metricDate: dateOf(n), ...rest })))).toEqual(
          strip(perDay.map((a) => ({ metricDate: dateOf(n), ...a }))),
        );
      }
      const old = grouped.filter((g) => g.scoringVersion === "v0");
      expect(old).toHaveLength(1);
      expect(old[0]).toMatchObject({ metricDate: dateOf(2), engineKey: "chatgpt", cellsTotal: 1 });
    });
  });

  it("STORY-090 AC8 · growth map: topics, engines and a custom range together", async () => {
    await seed();
    const doc = await growthMap({ topics: clusterA, engines: "chatgpt", timeframe: "custom", from: dateOf(3), to: dateOf(1) });
    const brand = doc.series.find((s) => s.series_id === "brand")!;
    expect(brand.points.map((p) => p.cells)).toEqual([0, 1, 0]);
    expect((doc.engines ?? []).map((e) => e.engine_key)).toEqual(["chatgpt"]);
  });

  it("STORY-090 AC8 · growth map: the 24h view honours the topic filter too", async () => {
    await addCell(promptA, new Date(Date.now() - 3_600_000).toISOString(), "chatgpt", true);
    await addCell(promptB, new Date(Date.now() - 3_600_000).toISOString(), "chatgpt", false);
    const total = (doc: Awaited<ReturnType<typeof growthMap>>) => doc.series.find((s) => s.series_id === "brand")!.points.reduce((sum, p) => sum + p.cells, 0);
    expect(total(await growthMap({ timeframe: "24h" }))).toBe(2);
    expect(total(await growthMap({ timeframe: "24h", topics: clusterA }))).toBe(1);
  });
});
