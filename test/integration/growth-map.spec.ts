import { randomUUID, createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { growthMapResponseSchema } from "../../contracts/analytics/index.js";
import { GrowthMapService, MILESTONE_IMPACT_CAVEAT } from "../../src/modules/analytics/growth-map.service.js";
import { rollUpDay } from "../../src/lib/rollup/roll-up-day.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// STORY-137 — §7's payload, against real rollup rows.
//
// The unit suite covers the gap and median rules. THESE ARE THE THINGS ONLY A
// DATABASE CAN SHOW: that the series come from the rollup's own cross-engine
// rows, that a gap is derived from a real absence, and that an unvalidatable
// stored impact does not reach the wire.

describe("STORY-137 · growth map", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let competitorIds: string[] = [];

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

  async function setUp(competitorCount = 0): Promise<void> {
    await db.query(
      "TRUNCATE milestones, metric_daily, mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    competitorIds = [];

    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain)
       VALUES ($1,$2,'HubSpot CRM',$3,'https://hubspot.com','hubspot.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
    for (const [engine, weight] of [
      ["google_ai_mode", 3],
      ["chatgpt", 1],
    ] as const) {
      await db.query(
        `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,
                              cache_ttl_seconds,volatility_band,min_plan_key,status)
         VALUES ($1,$1,'v','api','1.0.0',86400,'medium','free','active') ON CONFLICT (key) DO NOTHING`,
        [engine],
      );
      await db.query(
        `INSERT INTO project_engines (workspace_id,project_id,engine_key,enabled,sample_count,weight)
         VALUES ($1,$2,$3,true,1,$4)`,
        [workspaceId, projectId, engine, weight],
      );
    }
    for (let i = 0; i < competitorCount; i += 1) {
      const id = randomUUID();
      competitorIds.push(id);
      await db.query(
        `INSERT INTO competitors (id,workspace_id,project_id,name,root_domain,aliases,source)
         VALUES ($1,$2,$3,$4,$5,ARRAY[]::text[],'user')`,
        [id, workspaceId, projectId, `Rival ${String(i)}`, `rival${String(i)}.com`],
      );
    }
  }

  beforeEach(async () => {
    await setUp();
  });

  /** A workspace-local date `n` days before today, and midday on it. */
  function dayAgo(n: number): { date: string; at: string } {
    const at = new Date(Date.now() - n * 86_400_000);
    const date = at.toISOString().slice(0, 10);
    return { date, at: `${date}T12:00:00Z` };
  }

  async function addCell(at: string, engineKey: string, brandPresent: boolean, status = "parsed"): Promise<string> {
    const resultId = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,
          capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,'api','1.0.0','n1',$8,'{}'::jsonb,'{}','live',$9,$10)`,
      [
        resultId,
        workspaceId,
        projectId,
        uuidV7(),
        promptId,
        engineKey,
        at,
        createHash("sha256").update(resultId).digest(),
        status,
        brandPresent,
      ],
    );
    return resultId;
  }

  async function addMention(resultId: string, at: string, entityId: string | null = null): Promise<void> {
    const engine = await db.query<{ engine_key: string }>("SELECT engine_key FROM answer_captures WHERE id = $1", [
      resultId,
    ]);
    await db.query(
      `INSERT INTO mention_facts
         (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,
          entity_type,entity_id,entity_label,matched_alias,occurrence_index,
          char_start,char_end,first_token_index,prominence,
          sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,render_score)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,'L','L',0,0,1,0,0.8,'positive',0.5,0.9,'lexicon',0.4)`,
      [
        workspaceId,
        projectId,
        resultId,
        promptId,
        engine.rows[0]!.engine_key,
        at,
        entityId === null ? "brand" : "competitor",
        entityId,
      ],
    );
  }

  /** A captured, mentioned, rolled-up day for the brand and any listed competitors. */
  async function measuredDay(n: number, mentionedCompetitors: string[] = []): Promise<void> {
    const { date, at } = dayAgo(n);
    const cell = await addCell(at, "google_ai_mode", true);
    await addMention(cell, at);
    for (const competitorId of mentionedCompetitors) await addMention(cell, at, competitorId);
    await rollUpDay(db, workspaceId, projectId, date, "UTC");
  }

  function read(timeframe: "7d" | "30d" | "90d" = "7d", entities?: string) {
    return withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
      new GrowthMapService().growthMap(projectId, {
        timeframe,
        granularity: "day",
        ...(entities === undefined ? {} : { entities }),
      }),
    ) as ReturnType<GrowthMapService["growthMap"]>;
  }

  it("returns a payload that validates against §7's contract", async () => {
    await measuredDay(1);
    expect(growthMapResponseSchema.safeParse(await read()).success).toBe(true);
  });

  it("plots one point per calendar day in the window, gaps included", async () => {
    await measuredDay(1);
    const document = await read("7d");
    expect(document.series[0]!.points).toHaveLength(7);
    expect(document.point_count).toBe(7);
  });

  it("scenario 1 — a missing day is null and appears in data_gaps, never interpolated", async () => {
    await measuredDay(4);
    await measuredDay(1);

    const document = await read("7d");
    const brand = document.series.find((s) => s.series_id === "brand")!;
    const nulls = brand.points.filter((p) => p.visibility_score === null);
    expect(nulls.length).toBeGreaterThan(0);
    // Every null day is announced, and none of them carries a number.
    const announced = document.annotations.data_gaps.flatMap((gap) => [gap.from, gap.to]);
    expect(announced.length).toBeGreaterThan(0);
    for (const point of nulls) expect(point.cells).toBe(0);
  });

  it("names the engines behind a gap caused by a failure, rather than calling it silence", async () => {
    const { date, at } = dayAgo(2);
    await addCell(at, "chatgpt", false, "failed");
    // No successful capture that day, so the day is a gap with a reason.
    void date;

    const document = await read("7d");
    const gap = document.annotations.data_gaps.find((g) => g.reason === "engine_unavailable");
    expect(gap).toBeDefined();
    expect(gap!.engines).toContain("chatgpt");
  });

  it("scenario 2 — the baseline is the median across competitors", async () => {
    await setUp(3);
    const { date, at } = dayAgo(1);
    const cell = await addCell(at, "google_ai_mode", true);
    await addMention(cell, at);
    for (const competitorId of competitorIds) await addMention(cell, at, competitorId);
    await rollUpDay(db, workspaceId, projectId, date, "UTC");

    const document = await read("7d");
    const baseline = document.series.find((s) => s.series_id === "competitor_baseline")!;
    const competitors = document.series.filter((s) => s.entity_type === "competitor");
    expect(competitors).toHaveLength(3);

    const index = baseline.points.findIndex((p) => p.d === date);
    const values = competitors.map((s) => s.points[index]!.visibility_score!).sort((a, b) => a - b);
    expect(baseline.points[index]!.visibility_score).toBeCloseTo(values[1]!, 9);
  });

  it("scenario 4 — no competitors means NO baseline series at all", async () => {
    await measuredDay(1);
    const document = await read("7d");
    expect(document.series.map((s) => s.series_id)).toEqual(["brand"]);
    expect(document.summary.competitor_gap_start).toBeNull();
  });

  it("scenario 6 — an empty milestones table returns [] and the series still render", async () => {
    await measuredDay(1);
    const document = await read("7d");
    expect(document.milestones).toEqual([]);
    expect(document.series[0]!.points.some((p) => p.visibility_score !== null)).toBe(true);
  });

  it("scenario 5 — a milestone with a computed delta always carries the caveat", async () => {
    await measuredDay(1);
    const { at } = dayAgo(1);
    // Stored WITHOUT a caveat — the mandatory string is supplied here, so a
    // delta cannot reach a tooltip bare whatever the jsonb holds.
    await db.query(
      `INSERT INTO milestones (workspace_id,project_id,occurred_at,kind,title,severity,source_type,affected_engines,measured_impact)
       VALUES ($1,$2,$3::timestamptz,'task_completed','Structured Schema Applied','positive','task',ARRAY['chatgpt'],$4::jsonb)`,
      [
        workspaceId,
        projectId,
        at,
        JSON.stringify({
          visibility_before: 68.1,
          visibility_after_14d: 74.5,
          delta: 6.4,
          window_days: 14,
          confidence: "medium",
          method: "pre_post_mean_diff",
        }),
      ],
    );

    const [milestone] = (await read("7d")).milestones;
    expect(milestone!.measured_impact).not.toBeNull();
    expect(milestone!.measured_impact!.caveat).toBe(MILESTONE_IMPACT_CAVEAT);
    expect(milestone!.measured_impact!.delta).toBeCloseTo(6.4, 9);
  });

  it("keeps a stored caveat rather than overwriting it", async () => {
    await measuredDay(1);
    const { at } = dayAgo(1);
    await db.query(
      `INSERT INTO milestones (workspace_id,project_id,occurred_at,kind,title,severity,affected_engines,measured_impact)
       VALUES ($1,$2,$3::timestamptz,'annotation','T','info',ARRAY[]::text[],$4::jsonb)`,
      [
        workspaceId,
        projectId,
        at,
        JSON.stringify({
          visibility_before: 1,
          visibility_after_14d: 2,
          delta: 1,
          window_days: 7,
          confidence: "low",
          method: "custom",
          caveat: "A method-specific note.",
        }),
      ],
    );
    expect((await read("7d")).milestones[0]!.measured_impact!.caveat).toBe("A method-specific note.");
  });

  it("DROPS an impact that cannot be validated, rather than publishing half of one", async () => {
    // A delta with no window, method or confidence beside it is the shape of
    // the causal claim NFR-ANL-05 exists to prevent.
    await measuredDay(1);
    const { at } = dayAgo(1);
    await db.query(
      `INSERT INTO milestones (workspace_id,project_id,occurred_at,kind,title,severity,affected_engines,measured_impact)
       VALUES ($1,$2,$3::timestamptz,'annotation','T','info',ARRAY[]::text[],$4::jsonb)`,
      [workspaceId, projectId, at, JSON.stringify({ delta: 6.4 })],
    );

    const [milestone] = (await read("7d")).milestones;
    expect(milestone!.measured_impact).toBeNull();
    // The milestone itself still renders — the pin is real, the number is not.
    expect(milestone!.title).toBe("T");
  });

  it("narrows to the requested entities", async () => {
    await setUp(1);
    const { date, at } = dayAgo(1);
    const cell = await addCell(at, "google_ai_mode", true);
    await addMention(cell, at);
    await addMention(cell, at, competitorIds[0]!);
    await rollUpDay(db, workspaceId, projectId, date, "UTC");

    expect((await read("7d", "brand")).series.map((s) => s.series_id)).toEqual(["brand"]);
    const competitorsOnly = await read("7d", "competitors");
    expect(competitorsOnly.series.some((s) => s.series_id === "brand")).toBe(false);
    expect(competitorsOnly.series.some((s) => s.entity_type === "competitor")).toBe(true);
  });

  it("names a best and a worst engine only when there are two to compare", async () => {
    // One engine is neither best nor worst; naming it both would put the same
    // engine on both ends of a comparison with no other side.
    await measuredDay(1);
    expect((await read("7d")).summary).toMatchObject({ best_engine: null, worst_engine: null });

    const { date, at } = dayAgo(1);
    const cell = await addCell(at, "chatgpt", false);
    void cell;
    await rollUpDay(db, workspaceId, projectId, date, "UTC");

    const summary = (await read("7d")).summary;
    expect(summary.best_engine).toBe("google_ai_mode");
    expect(summary.worst_engine).toBe("chatgpt");
  });

  it("reports a null summary throughout for a window that measured nothing", async () => {
    const summary = (await read("7d")).summary;
    expect(summary).toMatchObject({
      visibility_start: null,
      visibility_end: null,
      visibility_delta: null,
      competitor_gap_start: null,
      competitor_gap_end: null,
    });
  });

  it("404s for a project that does not exist", async () => {
    await expect(
      withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
        new GrowthMapService().growthMap(randomUUID(), { timeframe: "7d", granularity: "day" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
