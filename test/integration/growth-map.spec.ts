import { randomUUID, createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { growthMapResponseSchema, type GrowthMapTimeframe } from "../../contracts/analytics/index.js";
import { GrowthMapService, MILESTONE_IMPACT_CAVEAT } from "../../src/modules/analytics/growth-map.service.js";
import { rollUpDay } from "../../src/lib/rollup/roll-up-day.js";
import { SCORING_VERSION } from "../../src/lib/scoring/index.js";
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
    // STORY-066 scenario 1 — twelve monthly partitions BEFORE the ones the
    // migration made, so "bounded to one day" is measured against a table that
    // has history to prune.
    const now = new Date();
    for (let monthsBack = 1; monthsBack <= 12; monthsBack += 1) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack + 1, 1));
      await db.query(
        `CREATE TABLE answer_captures_p${start.toISOString().slice(0, 7).replace("-", "")}
           PARTITION OF answer_captures FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
      );
    }
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

  function read(timeframe: GrowthMapTimeframe = "7d", entities?: string, engines?: string, client: Client = db) {
    return withTenantContext(client, { workspaceId, actorId: randomUUID() }, () =>
      new GrowthMapService().growthMap(projectId, {
        timeframe,
        ...(entities === undefined ? {} : { entities }),
        ...(engines === undefined ? {} : { engines }),
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

  /** One rolled-up day with a present brand on `chatgpt` and an absent one on `google_ai_mode`. */
  async function twoEngineDay(): Promise<void> {
    const { date, at } = dayAgo(1);
    const present = await addCell(at, "chatgpt", true);
    await addMention(present, at);
    await addCell(at, "google_ai_mode", false);
    await rollUpDay(db, workspaceId, projectId, date, "UTC");
  }

  it("NEW-A-14 AC2 — engines=chatgpt plots only chatgpt's measurements and lists only chatgpt", async () => {
    await twoEngineDay();
    const all = await read("7d", "brand");
    const narrowed = await read("7d", "brand", "chatgpt");
    const lastScored = (r: typeof all) => r.series[0]!.points.filter((p) => p.visibility_score !== null).at(-1)!;
    expect((narrowed.engines ?? []).map((e) => e.engine_key)).toEqual(["chatgpt"]);
    expect(lastScored(narrowed).cells).toBe(1);
    expect(lastScored(all).cells).toBe(2);
    expect(lastScored(narrowed).visibility_score).not.toBe(lastScored(all).visibility_score);
    expect(growthMapResponseSchema.safeParse(narrowed).success).toBe(true);
  });

  it("NEW-A-14 AC2 — engines=all is the unfiltered payload", async () => {
    await twoEngineDay();
    const [unfiltered, all] = [await read("7d", "brand"), await read("7d", "brand", "all")];
    expect(all.series).toEqual(unfiltered.series);
    expect(all.engines).toEqual(unfiltered.engines);
  });

  it("NEW-A-14 AC2 — an engine the project is not entitled to narrows to nothing and never widens", async () => {
    await twoEngineDay();
    const none = await read("7d", "brand", "claude");
    expect(none.engines).toEqual([]);
    expect(none.series[0]!.points.every((p) => p.visibility_score === null && p.cells === 0)).toBe(true);
    expect(none.summary.visibility_end).toBeNull();
    const mixed = await read("7d", "brand", "chatgpt,claude");
    expect((mixed.engines ?? []).map((e) => e.engine_key)).toEqual(["chatgpt"]);
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


  // ───────────────────────── STORY-066 — the series contract ─────────────────────────

  /** One brand `engine_key='all'` row, written straight into the rollup layer. */
  async function dailyRow(n: number, visibility: number, version = SCORING_VERSION, entity: { type: "brand" | "competitor"; id: string } = { type: "brand", id: projectId }): Promise<string> {
    const { date } = dayAgo(n);
    await db.query(
      `INSERT INTO metric_daily (workspace_id,project_id,engine_key,entity_type,entity_id,metric_date,cells_total,cells_present,
                                 presence_rate,sov,visibility_score,live_capture_ratio,scoring_version)
       VALUES ($1,$2,'all',$3,$4,$5::date,10,5,0.5,$6,$7,1,$8)`,
      [workspaceId, projectId, entity.type, entity.id, date, visibility / 200, visibility, version],
    );
    return date;
  }

  it("STORY-066 scenario 1 — each timeframe auto-selects its granularity (24h → hour, ≤90d → day, >90d → week)", async () => {
    await measuredDay(1);
    const expected: [GrowthMapTimeframe, string, number][] = [
      ["24h", "hour", 24],
      ["7d", "day", 7],
      ["30d", "day", 30],
      ["90d", "day", 90],
      ["180d", "week", 26],
      ["365d", "week", 53],
    ];
    for (const [timeframe, granularity, points] of expected) {
      const document = await read(timeframe);
      expect(document.granularity, timeframe).toBe(granularity);
      expect(document.series[0]!.points, timeframe).toHaveLength(points);
      expect(growthMapResponseSchema.safeParse(document).success, timeframe).toBe(true);
    }
  });

  it("STORY-066 scenario 1 — 24h reads the captures directly: an hour with cells is scored with no rollup row at all", async () => {
    const at = new Date(Date.now() - 2 * 3_600_000);
    const cell = await addCell(at.toISOString(), "google_ai_mode", true);
    await addMention(cell, at.toISOString());
    expect((await db.query("SELECT 1 FROM metric_daily")).rowCount).toBe(0);

    const document = await read("24h", "brand");
    const hour = `${at.toISOString().slice(0, 13)}:00:00Z`;
    const point = document.series[0]!.points.find((p) => p.d === hour);
    expect(point, `no ${hour} bucket in ${document.series[0]!.points.map((p) => p.d).join(",")}`).toBeDefined();
    expect(point!.cells).toBe(1);
    expect(point!.visibility_score).not.toBeNull();
    // Every other hour measured nothing: null, and announced as a gap.
    expect(document.series[0]!.points.filter((p) => p.visibility_score !== null)).toHaveLength(1);
    expect(document.annotations.data_gaps.length).toBeGreaterThan(0);
    expect(document.timeframe.to).toBe(document.series[0]!.points.at(-1)!.d);
  });

  it("STORY-066 scenario 1 — every 24h read of answer_captures is pruned to at most the two partitions one day can span", async () => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    await addCell(at, "chatgpt", false, "failed");
    const plans: string[] = [];
    const explaining = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "query") {
          return async (sql: unknown, values?: unknown[]) => {
            if (typeof sql === "string" && /\banswer_captures\b/u.test(sql)) {
              const explained = await target.query<Record<string, string>>(`EXPLAIN (COSTS OFF) ${sql}`, values);
              plans.push(explained.rows.map((row) => row["QUERY PLAN"] ?? "").join("\n"));
            }
            return (target.query as (...a: unknown[]) => unknown).call(target, sql, values);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    await read("24h", undefined, undefined, explaining as unknown as Client);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      const partitions = new Set([...plan.matchAll(/ on (answer_captures_[a-z0-9_]+)/gu)].map((match) => match[1]));
      expect(partitions.size, `a 24h read reached ${String(partitions.size)} partitions:\n${plan}`).toBeGreaterThan(0);
      expect(partitions.size, `a 24h read reached ${String(partitions.size)} partitions:\n${plan}`).toBeLessThanOrEqual(2);
    }
  });

  it("STORY-066 scenario 2 — the longest timeframe plots the MEAN of daily values, not a resampled last value", async () => {
    // The last bucket is the seven days ending today.
    await dailyRow(6, 10);
    await dailyRow(5, 20);
    await dailyRow(0, 90);
    const document = await read("365d", "brand");
    const last = document.series[0]!.points.at(-1)!;
    expect(last.d).toBe(dayAgo(6).date);
    expect(last.visibility_score).toBeCloseTo(40, 6);
    expect(last.cells).toBe(30);
    // The week before measured nothing: null, never carried across.
    expect(document.series[0]!.points.at(-2)!.visibility_score).toBeNull();
  });

  it("STORY-066 scenario 6 — a cadence change is annotated, from the trigger's own milestone", async () => {
    await measuredDay(1);
    await db.query("UPDATE projects SET cadence = 'daily' WHERE id = $1", [projectId]);
    // A system annotation whose detail is not the trigger's format is not a cadence change.
    await db.query(
      `INSERT INTO milestones (workspace_id,project_id,occurred_at,kind,title,detail,severity,source_type)
       VALUES ($1,$2,now(),'annotation','Capture cadence changed','sometime to never','info','system')`,
      [workspaceId, projectId],
    );
    const document = await read("7d");
    expect(document.annotations.cadence_changes).toEqual([{ at: dayAgo(0).date, from: "weekly", to: "daily" }]);
  });

  it("STORY-066 scenario 14 — a series spanning two scoring versions plots both and marks the boundary", async () => {
    await dailyRow(5, 40, "v0");
    await dailyRow(4, 41, "v0");
    const boundary = await dailyRow(2, 60);
    await dailyRow(2, 30, "v0"); // the same day under the old version loses to the current one
    await dailyRow(1, 61);
    const document = await read("7d", "brand");
    const byDay = new Map(document.series[0]!.points.map((p) => [p.d, p.visibility_score]));
    expect(byDay.get(dayAgo(5).date)).toBeCloseTo(40, 6);
    expect(byDay.get(boundary)).toBeCloseTo(60, 6);
    expect(document.annotations.scoring_version_changes).toEqual([{ at: boundary, from: "v0", to: SCORING_VERSION }]);
  });

  it("STORY-066 scenario 14 / STORY-136 AC9 — the summary delta is null across a scoring-version boundary; the ends are still reported", async () => {
    await dailyRow(5, 40, "v0");
    await dailyRow(1, 61);
    const summary = (await read("7d", "brand")).summary;
    expect(summary.visibility_start).toBeCloseTo(40, 6);
    expect(summary.visibility_end).toBeCloseTo(61, 6);
    expect(summary.visibility_delta).toBeNull();
  });

  it("STORY-066 scenario 14 — best and worst engine are read under the same version pick as the series, so an older-version window still names them", async () => {
    for (const [engine, visibility] of [["chatgpt", 20], ["gemini", 70]] as const) {
      await db.query(
        `INSERT INTO metric_daily (workspace_id,project_id,engine_key,entity_type,entity_id,metric_date,cells_total,cells_present,
                                   presence_rate,sov,visibility_score,live_capture_ratio,scoring_version)
         VALUES ($1,$2,$3,'brand',$2,$4::date,10,5,0.5,0.2,$5,1,'v0')`,
        [workspaceId, projectId, engine, dayAgo(3).date, visibility],
      );
    }
    await dailyRow(3, 45, "v0");
    expect((await read("7d", "brand")).summary).toMatchObject({ best_engine: "gemini", worst_engine: "chatgpt" });
  });

  it("STORY-066 scenario 14 — a window under one scoring version has no boundary", async () => {
    await dailyRow(2, 60);
    await dailyRow(1, 61);
    expect((await read("7d")).annotations.scoring_version_changes).toEqual([]);
  });

  it("STORY-066 scenario 15 — a full 90d × 6 engines × 4 entities series arrives in ONE request inside its 45 ms budget", async () => {
    await setUp(3);
    const engines = ["chatgpt", "perplexity", "google_aio", "google_ai_mode", "gemini", "claude", "all"];
    const entities: [string, string][] = [["brand", projectId], ...competitorIds.map((id): [string, string] => ["competitor", id])];
    for (const [entityType, entityId] of entities) {
      await db.query(
        `INSERT INTO metric_daily (workspace_id,project_id,engine_key,entity_type,entity_id,metric_date,cells_total,cells_present,
                                   presence_rate,sov,visibility_score,live_capture_ratio,scoring_version)
         SELECT $1,$2,e,$3,$4,(now() AT TIME ZONE 'UTC')::date - g,40,20,0.5,0.2,50 + (g % 7),1,$5
           FROM generate_series(0,89) g CROSS JOIN unnest($6::text[]) e`,
        [workspaceId, projectId, entityType, entityId, SCORING_VERSION, engines],
      );
    }
    for (let i = 0; i < 12; i += 1) {
      await db.query(
        `INSERT INTO milestones (workspace_id,project_id,occurred_at,kind,title,severity)
         VALUES ($1,$2,now() - make_interval(days => $3::int),'annotation','Note','info')`,
        [workspaceId, projectId, i * 7],
      );
    }
    await db.query("ANALYZE metric_daily");

    const document = await read("90d");
    // ONE payload carries every series, the pins and both annotation layers.
    expect(document.series.map((s) => s.entity_type)).toEqual(["brand", "competitor", "competitor", "competitor", "derived"]);
    expect(document.series.every((s) => s.points.length === 90 && s.points.every((p) => p.visibility_score !== null))).toBe(true);
    expect(document.milestones).toHaveLength(12);

    const timings: number[] = [];
    for (let run = 0; run < 9; run += 1) {
      const started = performance.now();
      await read("90d");
      timings.push(performance.now() - started);
    }
    const median = [...timings].sort((a, b) => a - b)[4]!;
    expect(median, `median ${median.toFixed(1)} ms over ${timings.map((t) => t.toFixed(1)).join(", ")}`).toBeLessThanOrEqual(45);
  });

  it("404s for a project that does not exist", async () => {
    await expect(
      withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
        new GrowthMapService().growthMap(randomUUID(), { timeframe: "7d", granularity: "day" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
