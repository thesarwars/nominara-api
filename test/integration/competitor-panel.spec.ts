import { randomUUID, createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { competitorPanelResponseSchema } from "../../contracts/analytics/index.js";
import { CompetitorPanelService } from "../../src/modules/analytics/competitor-panel.service.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { DEMO_SEED_MARKER } from "../../src/db/seed/demo/constants.js";

// NEW-C-1 — `GET /v1/projects/{id}/competitors/panel`, against real facts.
//
// STORY-092 backend scenarios 1, 2 and 4, plus scoring-models §12's numbers
// computed by hand: head-to-head win rate, category_share against SoV,
// detection variance, and the detected-not-tracked threshold.

interface Mention {
  type: "brand" | "competitor" | "other";
  entityId?: string;
  label: string;
  prominence: number;
  listPosition?: number | null;
}

describe("NEW-C-1 · competitor panel", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let compA: string;
  let compB: string;

  const resolver = {
    resolveForWorkspace: async () => ({ entitlements: { "competitors.max_per_project": { value: 5 } } }),
  } as unknown as EntitlementResolver;

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
    await db.query(
      "TRUNCATE metric_daily, mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    compA = randomUUID();
    compB = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain)
       VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
    for (const [engine, minPlan] of [["chatgpt", "free"], ["gemini", "free"]] as const) {
      await db.query(
        `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,
                              cache_ttl_seconds,volatility_band,min_plan_key,status,cadence_by_plan)
         VALUES ($1,$1,'v','api','1.0.0',86400,'medium',$2,'active','{}'::jsonb)`,
        [engine, minPlan],
      );
      await db.query(
        `INSERT INTO project_engines (workspace_id,project_id,engine_key,enabled,sample_count,weight)
         VALUES ($1,$2,$3,true,1,1)`,
        [workspaceId, projectId, engine],
      );
    }
    await addCompetitor(compA, "Salesforce", "salesforce.com");
    await addCompetitor(compB, "Zoho CRM", "zoho.com");
  });

  async function addCompetitor(id: string, name: string, rootDomain: string): Promise<void> {
    await db.query(
      `INSERT INTO competitors (id,workspace_id,project_id,name,root_domain) VALUES ($1,$2,$3,$4,$5)`,
      [id, workspaceId, projectId, name, rootDomain],
    );
  }

  function daysAgo(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString();
  }

  async function addCell(
    mentions: Mention[],
    options: { daysAgo?: number; engine?: string; normalizer?: string } = {},
  ): Promise<string> {
    const resultId = randomUUID();
    const capturedAt = daysAgo(options.daysAgo ?? 1);
    const engine = options.engine ?? "chatgpt";
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,
          capture_mode,adapter_version,normalizer_version,content_hash,
          payload,flags,cache_layer,status,brand_present)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,'api','1.0.0',$8,$9,'{}'::jsonb,'{}','live','parsed',$10)`,
      [
        resultId,
        workspaceId,
        projectId,
        uuidV7(),
        promptId,
        engine,
        capturedAt,
        options.normalizer ?? "n1",
        createHash("sha256").update(resultId).digest(),
        mentions.some((m) => m.type === "brand"),
      ],
    );
    let token = 0;
    for (const m of mentions) {
      await db.query(
        `INSERT INTO mention_facts
           (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,
            entity_type,entity_id,entity_label,matched_alias,occurrence_index,
            char_start,char_end,first_token_index,prominence,list_position,
            sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,render_score)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$9,0,0,1,$10,$11,$12,'positive',0.5,0.9,'lexicon',0.4)`,
        [
          workspaceId, projectId, resultId, promptId, engine, capturedAt,
          m.type, m.entityId ?? null, m.label, (token += 10), m.prominence, m.listPosition ?? null,
        ],
      );
    }
    return resultId;
  }

  const brand = (prominence: number, listPosition?: number): Mention => ({
    type: "brand", label: "HubSpot", prominence, listPosition: listPosition ?? null,
  });
  const compMention = (id: string, label: string, prominence: number, listPosition?: number): Mention => ({
    type: "competitor", entityId: id, label, prominence, listPosition: listPosition ?? null,
  });
  const other = (label: string, prominence = 0.1): Mention => ({ type: "other", label, prominence });

  function panel(query: { timeframe?: "7d" | "30d" | "90d"; engines?: string } = {}, ws = workspaceId) {
    return withTenantContext(db, { workspaceId: ws, actorId: randomUUID() }, () =>
      new CompetitorPanelService(resolver).panel(projectId, { timeframe: query.timeframe ?? "30d", ...(query.engines === undefined ? {} : { engines: query.engines }) }),
    ) as ReturnType<CompetitorPanelService["panel"]>;
  }

  it("STORY-092 #1 — the brand row is always present, first, and marked is_brand, even with no facts", async () => {
    const document = await panel();
    expect(competitorPanelResponseSchema.safeParse(document).success).toBe(true);
    expect(document.rows[0]).toMatchObject({ is_brand: true, tracked: true, label: "HubSpot", entity_id: projectId, h2h_win_rate: null });
    expect(document.rows.filter((r) => r.is_brand)).toHaveLength(1);
    // Tracked competitors are rows too, though nothing has been captured.
    expect(document.rows.map((r) => r.label)).toEqual(["HubSpot", "Salesforce", "Zoho CRM"]);
    expect(document.tracked_count).toBe(2);
    expect(document.competitors_cap).toBe(5);
  });

  it("STORY-092 #1 — head-to-head win rate is hand-computed over cells where BOTH appear", async () => {
    // Salesforce vs the brand, four cells:
    //   c1 both, brand ranks 1, SF 2   -> brand wins
    //   c2 both, brand ranks 2, SF 1   -> SF wins
    //   c3 both, brand ranks 1, SF 3   -> brand wins
    //   c4 SF only                     -> not counted
    // win rate = 2 / 3. (Over all four cells it would be 0.5; over cells the
    // brand appears in alone, 1.0.)
    await addCell([brand(0.6, 1), compMention(compA, "Salesforce", 0.3, 2)]);
    await addCell([brand(0.3, 2), compMention(compA, "Salesforce", 0.6, 1)]);
    await addCell([brand(0.6, 1), compMention(compA, "Salesforce", 0.2, 3)]);
    await addCell([compMention(compA, "Salesforce", 0.9, 1)]);
    const row = (await panel()).rows.find((r) => r.label === "Salesforce")!;
    expect(row.h2h_win_rate).toBeCloseTo(2 / 3, 12);
  });

  it("STORY-092 #1 — a tracked competitor never co-appearing has a NULL win rate, not 0", async () => {
    await addCell([brand(0.6, 1)]);
    const row = (await panel()).rows.find((r) => r.label === "Zoho CRM")!;
    expect(row.h2h_win_rate).toBeNull();
  });

  it("scoring-models §12 — sov counts Other in the denominator; category_share is over the TRACKED set only", async () => {
    // cell 1: brand .6, SF .3, Pipedrive(other) .1   denominator 1.0
    // cell 2: brand .5, SF .5                        denominator 1.0
    // SoV(brand) = (0.6+0.5)/2 = 0.55 ; SoV(SF) = (0.3+0.5)/2 = 0.40
    // category_share(brand) = 0.55 / (0.55 + 0.40 + 0) = 0.5789…
    await addCell([brand(0.6), compMention(compA, "Salesforce", 0.3), other("Pipedrive", 0.1)]);
    await addCell([brand(0.5), compMention(compA, "Salesforce", 0.5)]);
    const rows = (await panel()).rows;
    const me = rows.find((r) => r.is_brand)!;
    const sf = rows.find((r) => r.label === "Salesforce")!;
    // `mention_facts.prominence` is a float4 column, so 0.6 is stored as
    // 0.60000002…: the inputs carry ~1e-8 of storage error, and 6 digits is
    // the precision the fixture can deliver, not a loosened assertion.
    expect(me.sov).toBeCloseTo(0.55, 6);
    expect(sf.sov).toBeCloseTo(0.4, 6);
    expect(me.category_share).toBeCloseTo(0.55 / 0.95, 6);
    expect(sf.category_share).toBeCloseTo(0.4 / 0.95, 6);
    expect(me.category_share).not.toBeCloseTo(me.sov!, 3);
  });

  it("an absent tracked competitor measured over real cells has sov 0, while an unmeasured sentiment is null", async () => {
    await addCell([brand(0.6)]);
    const zoho = (await panel()).rows.find((r) => r.label === "Zoho CRM")!;
    expect(zoho.sov).toBe(0);
    expect(zoho.sentiment).toBeNull();
  });

  it("STORY-092 #2 — an 'other' label with 10 appearances in 30 days is a detected-not-tracked row carrying its count", async () => {
    for (let i = 0; i < 10; i += 1) await addCell([brand(0.6), other("Pipedrive")], { daysAgo: i + 1 });
    for (let i = 0; i < 9; i += 1) await addCell([brand(0.6), other("Close CRM")], { daysAgo: i + 1 });
    const rows = (await panel()).rows;
    const detected = rows.filter((r) => !r.tracked);
    expect(detected.map((r) => r.label)).toEqual(["Pipedrive"]);
    expect(detected[0]).toMatchObject({ appearances: 10, entity_id: null, is_brand: false });
  });

  it("an 'other' appearance older than 30 days does not count toward the threshold", async () => {
    for (let i = 0; i < 9; i += 1) await addCell([brand(0.6), other("Pipedrive")], { daysAgo: i + 1 });
    await addCell([brand(0.6), other("Pipedrive")], { daysAgo: 45 });
    expect((await panel({ timeframe: "90d" })).rows.filter((r) => !r.tracked)).toEqual([]);
  });

  it("STORY-092 #4 — an untracked row's blended, per_engine and sov are null, never 0", async () => {
    for (let i = 0; i < 12; i += 1) await addCell([brand(0.6), other("Pipedrive")], { daysAgo: i + 1 });
    const document = await panel();
    const row = document.rows.find((r) => !r.tracked)!;
    expect(row.blended).toBeNull();
    expect(row.sov).toBeNull();
    expect(Object.keys(row.per_engine).sort()).toEqual(document.engines.slice().sort());
    for (const value of Object.values(row.per_engine)) expect(value).toBeNull();
    expect(row).toMatchObject({ category_share: null, h2h_win_rate: null, delta: null, sentiment: null, citation_share: null });
  });

  it("detection variance is the sample stddev of daily sov per engine", async () => {
    // day 1: brand sov 1.0 (alone) ; day 2: brand sov 0.5 ; stddev_samp([1, .5]) = 0.3535…
    await addCell([brand(0.6)], { daysAgo: 2 });
    await addCell([brand(0.5), compMention(compA, "Salesforce", 0.5)], { daysAgo: 1 });
    const me = (await panel()).rows.find((r) => r.is_brand)!;
    expect(me.detection_variance["chatgpt"]).toBeCloseTo(Math.SQRT1_2 / 2, 6);
    // One measured day cannot have a variance: null, not 0.
    expect(me.detection_variance["gemini"]).toBeNull();
  });

  it("delta is null under 30 cells in either window", async () => {
    await addCell([brand(0.6)], { daysAgo: 1 });
    await addCell([brand(0.6)], { daysAgo: 40 });
    expect((await panel()).rows.find((r) => r.is_brand)!.delta).toBeNull();
  });

  it("marks an engine demo when every capture in the window is seeded, live when none is, mixed when both kinds contributed, null when none", async () => {
    await addCell([brand(0.6)], { engine: "chatgpt", normalizer: DEMO_SEED_MARKER });
    await addCell([brand(0.6)], { engine: "gemini" });
    const document = await panel();
    expect(document.engine_data_source).toEqual({ chatgpt: "demo", gemini: "live" });
    const empty = await panel({ engines: "chatgpt" });
    expect(Object.keys(empty.engine_data_source)).toEqual(["chatgpt"]);
  });

  it("an engine with both seeded and real captures in the window is mixed, not demo", async () => {
    await addCell([brand(0.6)], { engine: "chatgpt", normalizer: DEMO_SEED_MARKER });
    await addCell([brand(0.6)], { engine: "chatgpt" });
    await addCell([brand(0.6)], { engine: "gemini" });
    expect((await panel()).engine_data_source).toEqual({ chatgpt: "mixed", gemini: "live" });
  });

  it("the engines filter narrows the per-engine columns", async () => {
    await addCell([brand(0.6)], { engine: "chatgpt" });
    await addCell([brand(0.6)], { engine: "gemini" });
    const document = await panel({ engines: "gemini" });
    expect(document.engines).toEqual(["gemini"]);
    expect(Object.keys(document.rows[0]!.per_engine)).toEqual(["gemini"]);
  });

  it("a project that does not exist is a 404", async () => {
    await expect(
      withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
        new CompetitorPanelService(resolver).panel(randomUUID(), { timeframe: "30d" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("a second workspace reading this project, under the application role, gets 404", async () => {
    await addCell([brand(0.6)]);
    const otherWorkspace = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W2',$2,'growth','UTC')", [
      otherWorkspace,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    // The owning role bypasses RLS and would pass this for the wrong reason.
    await db.query("SET ROLE nominara_app");
    try {
      await expect(panel({}, otherWorkspace)).rejects.toMatchObject({ code: "not_found" });
      await expect(panel({}, workspaceId)).resolves.toBeDefined();
    } finally {
      await db.query("RESET ROLE");
    }
  });
});
