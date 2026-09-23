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
    // ⚠ EACH ENGINE CARRIES ITS OWN REAL PLAN FLOOR, NOT 'free' FOR EVERYTHING.
    // This fixture used to seed min_plan_key='free' on every engine, which
    // made STORY-152's plan floor INERT in the one spec that covers this
    // surface — the floor could have been deleted from the view and nothing
    // here would have noticed. These are the floors migration 0027 seeds.
    for (const [engine, weight, minPlan] of [
      ["google_ai_mode", 3, "growth"],
      ["chatgpt", 1, "free"],
    ] as const) {
      await db.query(
        `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,
                              cache_ttl_seconds,volatility_band,min_plan_key,status,cadence_by_plan)
         VALUES ($1,$1,'v','api','1.0.0',86400,'medium',$3,'active',$2::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [engine, JSON.stringify(options.cadence ?? {}), minPlan],
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

  // ⚠ THE TITLE USED TO SAY "never widens past what is ENABLED", and STORY-152
  // made that overstate the invariant: a measured engine is in the response
  // whether or not the plan entitles it (see the blend-membership block at the
  // bottom of this file). `gemini` returns nothing here because it is BOTH
  // unentitled and unmeasured in this fixture — which is what the narrower
  // title now claims, and what the next person adding a gemini cell needs to
  // know before they read this as a promise it no longer makes.
  it("narrows to the requested engines, and cannot summon one with no data and no entitlement", async () => {
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

  it("STORY-090 — reports the last capture per engine, from OUTSIDE the window if that is where it is", async () => {
    // Not windowed: the engine that has been silent longest is exactly the
    // one the header exists to surface.
    await addCell({ capturedAt: daysAgo(200), engineKey: "chatgpt", brandPresent: true });
    const document = await read("7d");
    const engine = document.engines.find((e) => e.engine_key === "chatgpt")!;
    expect(engine.last_captured_at).not.toBeNull();
    expect(engine.measured_cells).toBe(0);
  });

  it("STORY-090 — projects the next run from the cadence, and null without one", async () => {
    await setUp({ cadence: { growth: { full: 30 } } });
    await addCell({ capturedAt: daysAgo(1), engineKey: "chatgpt", brandPresent: true });

    const engine = (await read()).engines.find((e) => e.engine_key === "chatgpt")!;
    // 30 runs per 30-day cycle is a daily interval.
    const expected = Date.parse(engine.last_captured_at!) + 86_400_000;
    expect(Date.parse(engine.next_run_at!)).toBe(expected);

    // The other engine never ran, so there is nothing to project from.
    expect((await read()).engines.find((e) => e.engine_key === "google_ai_mode")!.next_run_at).toBeNull();
  });

  it("STORY-090 — a plan that does not schedule the engine has no next run", async () => {
    await setUp({ cadence: { starter: { full: 4 } } });
    await addCell({ capturedAt: daysAgo(1), engineKey: "chatgpt", brandPresent: true });
    expect((await read()).engines.find((e) => e.engine_key === "chatgpt")!.next_run_at).toBeNull();
  });

  it("STORY-090 — the blended entry carries no last scan and no next run", async () => {
    // They are per-engine facts; a "blended last scan" would be the max of a
    // set the reader cannot see.
    await addCell({ capturedAt: daysAgo(1), brandPresent: true });
    const document = await read();
    expect(document.blended.last_captured_at).toBeNull();
    expect(document.blended.next_run_at).toBeNull();
  });

  it("STORY-090 — every metric delta is suppressed while a window is under-sampled", async () => {
    for (let i = 0; i < 5; i += 1) await addCell({ capturedAt: daysAgo(1), brandPresent: true });
    const engine = (await read()).engines.find((e) => e.engine_key === "google_ai_mode")!;
    expect(Object.values(engine.metrics_delta)).toEqual([null, null, null, null, null]);
  });

  it("404s for a project that does not exist at all", async () => {
    await expect(
      withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
        new ScorecardsService().scorecards(randomUUID(), { timeframe: "30d" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  // ==========================================================================
  // STORY-152 — WHAT A BLEND IS A STATEMENT ABOUT.
  //
  // ⚠ THIS PAIR EXISTS BECAUSE THE FIRST VERSION OF STORY-152 SILENTLY
  // REDEFINED THE HEADLINE VISIBILITY SCORE.
  //
  // Switching this service onto `project_entitled_engines` made the blend run
  // over "the engines you are entitled to TODAY". The stored cross-engine row
  // that Growth Map and the trend series read (roll-up-day.ts's
  // upsertCrossEngineRows) blends every engine holding a `metric_daily` row
  // and applies no floor at all. Before the change both were unfiltered and
  // agreed; after it, a project holding a measurement from an engine its plan
  // no longer sells showed one number in its header and another on its chart.
  // Reachable the moment a workspace downgrades, which STORY-151 made
  // possible.
  //
  // The settled rule: ENTITLEMENT GOVERNS WHAT MAY BE CAPTURED NEXT. It
  // cannot retroactively un-measure something already measured, because a
  // past day's score has to stay reproducible from an export.
  // ==========================================================================
  describe("STORY-152 · blend membership is what was MEASURED, not what is entitled", () => {
    /** `claude` is a business engine; this workspace is on `growth`. */
    async function seedBelowFloorEngineWithData(): Promise<void> {
      await db.query(
        `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,
                              cache_ttl_seconds,volatility_band,min_plan_key,status,cadence_by_plan)
         VALUES ('claude','claude','v','api','1.0.0',86400,'medium','business','active',
                 '{"business":{"full":4}}'::jsonb)
         ON CONFLICT (key) DO NOTHING`,
      );
      await addCell({ capturedAt: daysAgo(0), engineKey: "claude", brandPresent: true });
    }

    it("⚠ an engine BELOW the plan floor still counts if it was measured in the window", async () => {
      await seedBelowFloorEngineWithData();

      const document = await read();
      const keys = document.engines.map((engine) => engine.engine_key);

      expect(keys, "claude is not entitled at growth, but it was measured — dropping it rewrites a past score").toContain(
        "claude",
      );
    });

    it("and it is genuinely NOT entitled — so the floor is doing its job, not simply absent", async () => {
      await seedBelowFloorEngineWithData();

      // The view is the entitlement answer, and it must exclude claude. If
      // this passed too, the test above would be proving nothing: both would
      // just mean "the floor is not applied anywhere".
      const entitled = await db.query<{ engine_key: string }>(
        "SELECT engine_key FROM project_entitled_engines WHERE project_id = $1 ORDER BY engine_key",
        [projectId],
      );
      expect(entitled.rows.map((r) => r.engine_key)).not.toContain("claude");

      // And the consequence of not being entitled: no cadence is claimed for
      // it, because the plan schedules no runs of an engine it does not sell.
      //
      // ⚠ CLAUDE CARRIES A REAL business CADENCE IN THE FIXTURE, AND THAT IS
      // WHAT MAKES THIS ASSERTION MEAN ANYTHING. The first version seeded
      // `cadence_by_plan = '{}'`, so the null came from an empty map and this
      // line would have passed with the plan floor deleted from the view — a
      // comment claiming a discrimination the assertion did not have. Now the
      // cadence EXISTS and is withheld because the project is not entitled to
      // it, which the upgrade below proves by making the same row report 4.
      const claude = (await read()).engines.find((engine) => engine.engine_key === "claude")!;
      expect(claude.cadence_runs_per_cycle, "an unentitled engine is scheduled zero times").toBeNull();

      await db.query("UPDATE workspaces SET plan_key = 'business' WHERE id = $1", [workspaceId]);
      const upgraded = (await read()).engines.find((engine) => engine.engine_key === "claude")!;
      expect(upgraded.cadence_runs_per_cycle, "on business the very same row reports its cadence").toBe(4);
    });

    // ⚠ THE ONE THING THE FLOOR STILL DECIDES IN THIS SERVICE, AND NOTHING
    // TESTED IT. Under the union rule a MEASURED engine is present whether or
    // not it is entitled, so the floor is unobservable for any engine with
    // data — which means every assertion above would survive deleting it.
    // What remains observable is: unentitled AND unmeasured must be ABSENT.
    it("an engine that is neither entitled nor measured does not appear at all", async () => {
      await db.query(
        `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,
                              cache_ttl_seconds,volatility_band,min_plan_key,status,cadence_by_plan)
         VALUES ('gemini','gemini','v','api','1.0.0',86400,'medium','business','active',
                 '{"business":{"full":4}}'::jsonb)
         ON CONFLICT (key) DO NOTHING`,
      );
      await addCell({ capturedAt: daysAgo(1), engineKey: "google_ai_mode", brandPresent: true });

      const keys = (await read()).engines.map((engine) => engine.engine_key);
      expect(keys, "growth does not buy gemini and nothing measured it").not.toContain("gemini");
      // Anti-vacuity: the entitled engines are present, so this is not an
      // empty response.
      expect(keys).toContain("google_ai_mode");
      expect(keys).toContain("chatgpt");
    });

    // ⚠ daysAgo(0) IN THE FIXTURE ABOVE IS LOad-BEARING. With daysAgo(2) both
    // tests here pass against a `measured` CTE whose upper bound is EXCLUSIVE
    // and whose timezone is the session's — which is what the first version
    // of this change shipped. Today's captures are the ones that expose it.
    // ⚠ THIS TEST IS PLACED AT THE WINDOW'S FIRST INSTANT ON PURPOSE, AND A
    // LOOSER PLACEMENT PROVED NOTHING.
    //
    // The first version used `daysAgo(0)` and a Sydney workspace, on the
    // reasoning that a ten-hour skew must show up somewhere. It does not:
    // both bounds are DATES compared with an inclusive BETWEEN, so a skew
    // only changes the answer for a capture within hours of a boundary.
    // Forcing the conversion to UTC left all 27 tests green — the mutation
    // survived, and the test was decorative.
    //
    // `from` is `today - 29` in the WORKSPACE's zone. A capture at 00:30 on
    // that date in Sydney is 14:30 the PREVIOUS day in UTC, so its UTC date
    // is `from - 1` and a UTC-converted predicate excludes it while a
    // Sydney-converted one includes it. That is the only shape that can tell
    // the two apart.
    it("⚠ the window's own timezone decides, at the boundary where that differs", async () => {
      await setUp({ timezone: "Australia/Sydney" });
      await db.query(
        `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,
                              cache_ttl_seconds,volatility_band,min_plan_key,status,cadence_by_plan)
         VALUES ('claude','claude','v','api','1.0.0',86400,'medium','business','active','{}'::jsonb)
         ON CONFLICT (key) DO NOTHING`,
      );

      // Derived in SQL from the same clock and zone the service uses, so it
      // cannot drift from `resolveWindow`'s arithmetic or from the test
      // machine's zone.
      const boundary = await db.query<{ at: string; syd: string; utc: string }>(
        `SELECT ts AS at,
                to_char((ts AT TIME ZONE 'Australia/Sydney')::date, 'YYYY-MM-DD') AS syd,
                to_char((ts AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')              AS utc
           FROM (SELECT ((date_trunc('day', (now() AT TIME ZONE 'Australia/Sydney')) - interval '29 days')
                         + interval '30 minutes') AT TIME ZONE 'Australia/Sydney' AS ts) t`,
      );
      const { at, syd, utc } = boundary.rows[0]!;
      // The fixture only discriminates if the two zones genuinely disagree
      // about the date. If they ever stop disagreeing, fail loudly rather
      // than pass silently.
      expect(utc, "the two zones must land on different dates, or this proves nothing").not.toBe(syd);

      await addCell({ capturedAt: at, engineKey: "claude", brandPresent: true });

      expect(
        (await read()).engines.map((engine) => engine.engine_key),
        "the capture is inside the window in Sydney and outside it in UTC — the workspace's zone decides",
      ).toContain("claude");
    });

    it("an entitled engine with NO measurement is still listed, and changes no number", async () => {
      // The other direction of the union. `blendMetrics` filters nulls before
      // summing the denominator, so an empty engine is in neither numerator
      // nor denominator — it must be visible without moving the score.
      await addCell({ capturedAt: daysAgo(1), engineKey: "google_ai_mode", brandPresent: true });
      const withoutChatgptData = await read();

      const chatgpt = withoutChatgptData.engines.find((engine) => engine.engine_key === "chatgpt");
      expect(chatgpt, "entitled and never measured is a state the screen must be able to show").toBeDefined();
      expect(chatgpt!.last_captured_at).toBeNull();

      // ⚠ brandPresent FALSE, and it has to be. A second engine measured
      // IDENTICALLY blends to the same number, so seeding another present
      // cell would leave the score unchanged for a reason that has nothing to
      // do with membership — and this guard would fail while everything
      // worked. A measured ABSENCE is what moves the blend.
      await addCell({ capturedAt: daysAgo(1), engineKey: "chatgpt", brandPresent: false });
      const withChatgptData = await read();
      expect(
        withChatgptData.blended.visibility_score === withoutChatgptData.blended.visibility_score,
        "a measured absence on a second engine SHOULD lower the blend — if this is equal, the fixture measured nothing and the assertions above are vacuous",
      ).toBe(false);
    });
  });
});
