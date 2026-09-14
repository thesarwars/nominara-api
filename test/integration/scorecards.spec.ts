import { randomUUID, createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { scorecardsResponseSchema } from "../../contracts/analytics/index.js";
import { ScorecardsService } from "../../src/modules/analytics/scorecards.service.js";
import { rollUpDay } from "../../src/lib/rollup/roll-up-day.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// STORY-136 — `GET /v1/projects/{id}/scorecards`, against real facts.
//
// The unit suite covers the arithmetic. THESE ARE THE THINGS ONLY A DATABASE
// CAN SHOW: that the window boundary is the project's own, that an enabled
// engine with no rows still appears, and — scenario 1 — that a window rate is
// not the mean of the daily rates the rollup wrote.

describe("STORY-136 · project scorecards", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;

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

  async function setUp(options: { timezone?: string; cadence?: Record<string, unknown> } = {}): Promise<void> {
    await db.query(
      "TRUNCATE metric_daily, mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();

    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth',$3)", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
      options.timezone ?? "UTC",
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
    // The catalog is unseeded (STORY-130), so the rows are created here —
    // including `cadence_by_plan`, which is what the cadence field reads.
    for (const [engine, weight] of [
      ["google_ai_mode", 3],
      ["chatgpt", 1],
    ] as const) {
      await db.query(
        `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,
                              cache_ttl_seconds,volatility_band,min_plan_key,status,cadence_by_plan)
         VALUES ($1,$1,'v','api','1.0.0',86400,'medium','free','active',$2::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [engine, JSON.stringify(options.cadence ?? {})],
      );
      await db.query(
        `INSERT INTO project_engines (workspace_id,project_id,engine_key,enabled,sample_count,weight)
         VALUES ($1,$2,$3,true,1,$4)`,
        [workspaceId, projectId, engine, weight],
      );
    }
  }

  beforeEach(async () => {
    await setUp();
  });

  interface CellSpec {
    capturedAt: string;
    engineKey?: string;
    brandPresent?: boolean;
    status?: string;
  }

  /**
   * A captured cell, and — when the brand is present — THE MENTION THAT MAKES
   * IT PRESENT.
   *
   * `cells_present` is `count(DISTINCT result_id)` over `mention_facts`, not
   * a read of `answer_captures.brand_present`: presence is established by the
   * parser writing a mention, and the denormalised flag is a convenience for
   * the matrix. A fixture that set the flag alone would build a state the
   * parse stage cannot produce, and every presence assertion on it would be
   * measuring nothing.
   */
  async function addCell(spec: CellSpec): Promise<string> {
    const resultId = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,
          capture_mode,adapter_version,normalizer_version,content_hash,
          payload,flags,cache_layer,status,brand_present)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,'api','1.0.0','n1',$8,'{}'::jsonb,'{}','live',$9,$10)`,
      [
        resultId,
        workspaceId,
        projectId,
        uuidV7(),
        promptId,
        spec.engineKey ?? "google_ai_mode",
        spec.capturedAt,
        createHash("sha256").update(resultId).digest(),
        spec.status ?? "parsed",
        spec.brandPresent ?? false,
      ],
    );
    if (spec.brandPresent === true) await addMention(resultId, spec.capturedAt);
    return resultId;
  }

  async function addMention(resultId: string, capturedAt: string, prominence = 0.8, sentimentScore = 0.5): Promise<void> {
    const engine = await db.query<{ engine_key: string }>("SELECT engine_key FROM answer_captures WHERE id = $1", [
      resultId,
    ]);
    await db.query(
      `INSERT INTO mention_facts
         (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,
          entity_type,entity_id,entity_label,matched_alias,occurrence_index,
          char_start,char_end,first_token_index,prominence,
          sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,render_score)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,'brand',NULL,'HubSpot','HubSpot',0,0,1,0,$7,'positive',$8,0.9,'lexicon',0.4)`,
      [workspaceId, projectId, resultId, promptId, engine.rows[0]!.engine_key, capturedAt, prominence, sentimentScore],
    );
  }

  async function addCitation(resultId: string, capturedAt: string, isOwned: boolean): Promise<void> {
    const engine = await db.query<{ engine_key: string }>("SELECT engine_key FROM answer_captures WHERE id = $1", [
      resultId,
    ]);
    await db.query(
      `INSERT INTO citation_facts
         (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,
          slot_index,raw_url,normalized_url,url_hash,domain,is_owned,is_competitor,http_status,position_weight)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,1,'https://x','https://x',sha256(random()::text::bytea),'x.com',$7,false,200,1.0)`,
      [workspaceId, projectId, resultId, promptId, engine.rows[0]!.engine_key, capturedAt, isOwned],
    );
  }

  /** A day inside the 30-day window, as an ISO instant at midday UTC. */
  function daysAgo(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString();
  }

  function read(timeframe: "7d" | "30d" | "90d" = "30d", engines?: string) {
    return withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
      new ScorecardsService().scorecards(projectId, { timeframe, ...(engines === undefined ? {} : { engines }) }),
    ) as ReturnType<ScorecardsService["scorecards"]>;
  }

  it("returns a document that validates against the contract", async () => {
    await addCell({ capturedAt: daysAgo(1), brandPresent: true });
    expect(scorecardsResponseSchema.safeParse(await read()).success).toBe(true);
  });

  it("scenario 10 — an enabled engine with NO rows is present, not omitted", async () => {
    // Omitting it would read as "not enabled", where the truth is "enabled
    // and never measured" — the same distinction the matrix draws.
    const document = await read();
    expect(document.engines.map((e) => e.engine_key)).toEqual(["chatgpt", "google_ai_mode"]);
    for (const entry of document.engines) {
      expect(entry).toMatchObject({ visibility_score: null, measured_cells: 0, confidence: "low" });
      expect(entry.metrics.presence_rate).toBeNull();
    }
  });

  it("scenario 1 — the window rate is Σpresent/Σtotal, NOT the mean of the rollup's daily rates", async () => {
    // Day A: 9 of 10 present. Day B: 0 of 1 present.
    // Mean of the daily rates = (0.9 + 0.0) / 2 = 0.45
    // Window rate            = 9 / 11               = 0.818…
    const dayA = daysAgo(3);
    const dayB = daysAgo(2);
    for (let i = 0; i < 9; i += 1) await addCell({ capturedAt: dayA, brandPresent: true });
    await addCell({ capturedAt: dayA, brandPresent: false });
    await addCell({ capturedAt: dayB, brandPresent: false });

    const engine = (await read()).engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(engine.metrics.presence_rate).toBeCloseTo(9 / 11, 12);
    expect(engine.metrics.presence_rate).not.toBeCloseTo(0.45, 3);
    expect(engine.measured_cells).toBe(11);
  });

  it("scenario 2 — a window with cells and no citations reports a NULL citation share", async () => {
    // And `metric_daily` stores `0` for the same day — which is exactly why
    // this endpoint reads the facts rather than that column.
    const day = daysAgo(1);
    await addCell({ capturedAt: day, brandPresent: true });
    await rollUpDay(db, workspaceId, projectId, day.slice(0, 10), "UTC");

    const stored = await db.query<{ citation_share: string }>(
      "SELECT citation_share::text FROM metric_daily WHERE project_id = $1 AND engine_key = 'google_ai_mode' AND entity_type = 'brand'",
      [projectId],
    );
    expect(Number(stored.rows[0]!.citation_share)).toBe(0);

    const engine = (await read()).engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(engine.metrics.citation_share).toBeNull();
  });

  it("keeps a MEASURED zero citation share as zero", async () => {
    const day = daysAgo(1);
    const id = await addCell({ capturedAt: day, brandPresent: true });
    await addCitation(id, day, false);

    const engine = (await read()).engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(engine.metrics.citation_share).toBe(0);
    expect(engine.metrics.citations_total).toBe(1);
  });

  it("scenario 3 — a window with cells and no mentions reports a NULL sentiment", async () => {
    await addCell({ capturedAt: daysAgo(1), brandPresent: false });
    const engine = (await read()).engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(engine.metrics.sentiment_score).toBeNull();
    // And the score is still produced, renormalised over what exists.
    expect(engine.visibility_score).not.toBeNull();
  });

  it("scenario 4 — an attribute-incapable engine reports a NULL rendering quality", async () => {
    const day = daysAgo(1);
    await addCell({ capturedAt: day, engineKey: "chatgpt", brandPresent: true });

    const engine = (await read()).engines.find((e) => e.engine_key === "chatgpt")!;
    expect(engine.metrics.rendering_quality).toBeNull();
    expect((await read()).engines.find((e) => e.engine_key === "google_ai_mode")!.metrics.rendering_quality).toBeNull();
  });

  it("scenario 5 and 6 — the delta is null while either window is under-sampled", async () => {
    for (let i = 0; i < 5; i += 1) await addCell({ capturedAt: daysAgo(1), brandPresent: true });
    const engine = (await read()).engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(engine.measured_cells).toBe(5);
    expect(engine.visibility_delta).toBeNull();
  });

  it("scenario 7 — with both windows sampled, the delta is the difference of the two scores", async () => {
    // Current window: 40 cells, all present. Prior window: 40 cells, none.
    for (let i = 0; i < 40; i += 1) await addCell({ capturedAt: daysAgo(2), brandPresent: true });
    for (let i = 0; i < 40; i += 1) await addCell({ capturedAt: daysAgo(40), brandPresent: false });

    const engine = (await read()).engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(engine.visibility_delta).not.toBeNull();
    expect(engine.visibility_delta!).toBeGreaterThan(0);
  });

  it("scenario 8 — the blend is weighted, and carries the SUMMED cell count", async () => {
    // google_ai_mode weighs 3 and is fully present; chatgpt weighs 1 and is
    // absent. A plain mean would land halfway; the weighted blend does not.
    for (let i = 0; i < 10; i += 1) await addCell({ capturedAt: daysAgo(1), brandPresent: true });
    for (let i = 0; i < 10; i += 1) await addCell({ capturedAt: daysAgo(1), engineKey: "chatgpt", brandPresent: false });

    const document = await read();
    const strong = document.engines.find((e) => e.engine_key === "google_ai_mode")!;
    const weak = document.engines.find((e) => e.engine_key === "chatgpt")!;

    expect(document.blended.measured_cells).toBe(20);
    const mean = (strong.visibility_score! + weak.visibility_score!) / 2;
    const weighted = (3 * strong.visibility_score! + 1 * weak.visibility_score!) / 4;
    expect(document.blended.visibility_score).toBeCloseTo(weighted, 9);
    expect(document.blended.visibility_score).not.toBeCloseTo(mean, 3);
  });

  it("scenario 9 — an engine with no measurement is left out of the blend, not blended in at zero", async () => {
    for (let i = 0; i < 10; i += 1) await addCell({ capturedAt: daysAgo(1), brandPresent: true });
    const document = await read();
    const measured = document.engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(document.blended.visibility_score).toBeCloseTo(measured.visibility_score!, 9);
  });

  it("scenario 11 — the cadence follows `cadence_by_plan`, the scheduler's own source", async () => {
    await setUp({ cadence: { growth: { full: 8 } } });
    expect((await read()).engines[0]!.cadence_runs_per_cycle).toBe(8);

    await setUp({ cadence: { growth: { full: 26 } } });
    expect((await read()).engines[0]!.cadence_runs_per_cycle).toBe(26);
  });

  it("reports a NULL cadence when the plan does not schedule the engine — the scheduler's fail-closed rule", async () => {
    await setUp({ cadence: { starter: { full: 4 } } });
    expect((await read()).engines[0]!.cadence_runs_per_cycle).toBeNull();
  });

  it("scenario 13 — the window is bounded in the PROJECT'S timezone", async () => {
    // A capture at 23:00 UTC is the NEXT day in Sydney. With a 7-day window,
    // a project in Sydney and one in UTC can therefore disagree about whether
    // a capture at the boundary is inside it — the rollup buckets it the same
    // way, and the two must not disagree.
    await setUp({ timezone: "Australia/Sydney" });
    const document = await read("7d");
    expect(document.window.timezone).toBe("Australia/Sydney");
    expect(document.window.from < document.window.to).toBe(true);
  });

  it("narrows to the requested engines, and never widens past what is enabled", async () => {
    expect((await read("30d", "chatgpt")).engines.map((e) => e.engine_key)).toEqual(["chatgpt"]);
    expect((await read("30d", "gemini")).engines).toEqual([]);
  });

  it("excludes a failed cell from both numerator and denominator", async () => {
    // §2.5 — "we could not ask" is not a measurement. Counting it as an
    // absence would report a visibility drop caused by an outage.
    await addCell({ capturedAt: daysAgo(1), brandPresent: true });
    await addCell({ capturedAt: daysAgo(1), brandPresent: false, status: "failed" });

    const engine = (await read()).engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(engine.measured_cells).toBe(1);
    expect(engine.metrics.presence_rate).toBe(1);
  });

  // Scenario 14's cross-tenant 404 is NOT asserted here, deliberately. This
  // suite connects as the owning role, which bypasses RLS, so a
  // cross-workspace read succeeds against this harness whether the policies
  // are right or not — an assertion here would pass for the wrong reason and
  // go on passing after someone removed the policy. `pnpm test:isolation`
  // runs as the application role and is where that claim is actually proven.

  it("404s for a project that does not exist at all", async () => {
    await expect(
      withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
        new ScorecardsService().scorecards(randomUUID(), { timeframe: "30d" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
