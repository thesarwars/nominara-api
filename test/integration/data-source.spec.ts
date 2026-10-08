import { randomUUID, createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { Logger } from "@nestjs/common";
import { afterAll, vi, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { DEMO_SEED_MARKER } from "../../src/db/seed/demo/constants.js";
import { growthMapResponseSchema, scorecardsResponseSchema } from "../../contracts/analytics/index.js";
import { matrixResponseSchema } from "../../contracts/tracking/index.js";
import { GrowthMapService } from "../../src/modules/analytics/growth-map.service.js";
import { ScorecardsService } from "../../src/modules/analytics/scorecards.service.js";
import { MatrixService } from "../../src/modules/tracking/matrix.service.js";
import { engineDataSourcesForProjects } from "../../src/lib/analytics/data-source.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// NEW-A-5 — per-engine data_source on matrix, scorecards and growth map.
// Real: gemini. Demo: rows stamped normalizer_version = 'demo-seed'.

describe("NEW-A-5 · data_source provenance", () => {
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

  beforeEach(async () => {
    await db.query(
      "TRUNCATE metric_daily, mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain)
       VALUES ($1,$2,'P',$3,'https://e.test','e.test')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
    for (const engine of ["gemini", "chatgpt", "perplexity"]) {
      await db.query(
        `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,
                              cache_ttl_seconds,volatility_band,min_plan_key,status)
         VALUES ($1,$1,'v','api','1.0.0',86400,'medium','free','active')`,
        [engine],
      );
      await db.query(
        `INSERT INTO project_engines (workspace_id,project_id,engine_key,enabled,sample_count,weight)
         VALUES ($1,$2,$3,true,1,1)`,
        [workspaceId, projectId, engine],
      );
    }
  });

  async function capture(engine: string, normalizer: string, status = "parsed", hoursAgo = 2, brandPresent = true): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,
          capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present)
       VALUES ($1,$2,$3,$4,$5,$6, now() - make_interval(hours => $7::int),'api','1.0.0',$8,$9,'{}'::jsonb,'{}','live',$10,$11)`,
      [id, workspaceId, projectId, uuidV7(), promptId, engine, hoursAgo, normalizer, createHash("sha256").update(id).digest(), status, brandPresent],
    );
    return id;
  }

  /** The mention that makes a capture's brand presence real: presence is read from mention_facts, not the flag. */
  async function mention(resultId: string, engine: string): Promise<void> {
    await db.query(
      `INSERT INTO mention_facts
         (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,
          entity_type,entity_id,entity_label,matched_alias,occurrence_index,
          char_start,char_end,first_token_index,prominence,
          sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,render_score)
       SELECT workspace_id,project_id,id,prompt_id,engine_key,captured_at,
              'brand',NULL,'P','P',0,0,1,0,0.8,'positive',0.5,0.9,'lexicon',0.4
         FROM answer_captures WHERE id = $1 AND engine_key = $2`,
      [resultId, engine],
    );
  }

  const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, fn) as Promise<T>;
  const matrix = () => ctx(() => new MatrixService().matrix(projectId, { timeframe: "30d" }));
  const scorecards = () => ctx(() => new ScorecardsService().scorecards(projectId, { timeframe: "30d" }));
  const growth = () => ctx(() => new GrowthMapService().growthMap(projectId, { timeframe: "7d", granularity: "day" }));
  const sourceOf = (list: { engine_key: string; data_source?: string | null | undefined }[] | undefined, key: string) =>
    list?.find((entry) => entry.engine_key === key)?.data_source;

  it("NEW-A-5 AC2 — a project with only demo-seeded captures shows demo on every engine, on all three surfaces", async () => {
    for (const engine of ["gemini", "chatgpt", "perplexity"]) await capture(engine, DEMO_SEED_MARKER);
    const m = await matrix();
    const s = await scorecards();
    const g = await growth();
    expect(m.engines!.map((e) => e.data_source)).toEqual(["demo", "demo", "demo"]);
    expect(m.prompts[0]!.cells.map((c) => c.data_source)).toEqual(["demo", "demo", "demo"]);
    expect(s.engines.map((e) => e.data_source)).toEqual(["demo", "demo", "demo"]);
    expect(s.blended.data_source).toBe("demo");
    expect(g.engines!.map((e) => e.data_source)).toEqual(["demo", "demo", "demo"]);
    expect(g.series.every((series) => series.data_source === "demo")).toBe(true);
  });

  it("NEW-A-5 AC2 — a real gemini capture plus seeded others shows gemini live and the rest demo", async () => {
    await capture("gemini", "n1");
    await capture("chatgpt", DEMO_SEED_MARKER);
    await capture("perplexity", DEMO_SEED_MARKER);
    const m = await matrix();
    const s = await scorecards();
    const g = await growth();
    for (const list of [m.engines, s.engines, g.engines]) {
      expect(sourceOf(list, "gemini")).toBe("live");
      expect(sourceOf(list, "chatgpt")).toBe("demo");
      expect(sourceOf(list, "perplexity")).toBe("demo");
    }
    expect(m.prompts[0]!.cells.find((c) => c.engine_key === "gemini")!.data_source).toBe("live");
    // The blend includes demo engines, says so, and counts them.
    expect(s.blended.data_source).toBe("mixed");
    expect(s.blend!).toEqual({ policy: "all_measured_engines", live_engines: 1, demo_engines: 2, mixed_engines: 0 });
    expect(g.series[0]!.data_source).toBe("mixed");
    expect(scorecardsResponseSchema.safeParse(s).success).toBe(true);
    expect(growthMapResponseSchema.safeParse(g).success).toBe(true);
    expect(matrixResponseSchema.safeParse(m).success).toBe(true);
  });

  it("NEW-A-5 O1 — the blended score is over ALL measured engines, demo ones included, and the demo count is disclosed", async () => {
    // gemini is real and present in its answer; chatgpt is demo and absent
    // from its. Had the blend dropped the demo engine it would equal gemini's
    // score; a blend over both lies strictly between the two.
    await mention(await capture("gemini", "n1", "parsed", 2, true), "gemini");
    await capture("chatgpt", DEMO_SEED_MARKER, "parsed", 2, false);
    const s = await scorecards();
    const gemini = s.engines.find((e) => e.engine_key === "gemini")!;
    const chatgpt = s.engines.find((e) => e.engine_key === "chatgpt")!;
    expect(gemini.visibility_score).not.toBeNull();
    expect(chatgpt.visibility_score).not.toBeNull();
    expect(gemini.visibility_score).not.toBe(chatgpt.visibility_score);
    expect(s.blended.measured_cells).toBe(gemini.measured_cells + chatgpt.measured_cells);
    expect(s.blended.visibility_score).not.toBe(gemini.visibility_score);
    expect(s.blended.visibility_score!).toBeGreaterThan(Math.min(gemini.visibility_score!, chatgpt.visibility_score!));
    expect(s.blended.visibility_score!).toBeLessThan(Math.max(gemini.visibility_score!, chatgpt.visibility_score!));
    expect(s.blend!).toEqual({ policy: "all_measured_engines", live_engines: 1, demo_engines: 1, mixed_engines: 0 });
    expect(s.blended.data_source).toBe("mixed");
  });

  it("NEW-A-5 AC2 — a cell never captured stays pending with a null data_source, not demo", async () => {
    await capture("chatgpt", DEMO_SEED_MARKER);
    const m = await matrix();
    const gemini = m.prompts[0]!.cells.find((c) => c.engine_key === "gemini")!;
    expect(gemini.status).toBe("pending");
    expect(gemini.data_source).toBeNull();
    expect(sourceOf(m.engines, "gemini")).toBeNull();
    const s = await scorecards();
    expect(sourceOf(s.engines, "gemini")).toBeNull();
  });

  it("NEW-A-5 AC2 — a failed capture is not data: its cell and engine carry null, whatever its normalizer_version", async () => {
    await capture("gemini", "n1", "failed");
    const m = await matrix();
    const cell = m.prompts[0]!.cells.find((c) => c.engine_key === "gemini")!;
    expect(cell.status).toBe("failed");
    expect(cell.data_source).toBeNull();
    expect(sourceOf(m.engines, "gemini")).toBeNull();
  });

  it("NEW-A-5 AC2 — an engine with both kinds of measured capture in the window is mixed", async () => {
    await capture("gemini", "n1", "parsed", 3);
    await capture("gemini", DEMO_SEED_MARKER, "parsed", 5);
    const m = await matrix();
    expect(sourceOf(m.engines, "gemini")).toBe("mixed");
    const s = await scorecards();
    expect(sourceOf(s.engines, "gemini")).toBe("mixed");
    expect(s.blend!.mixed_engines).toBe(1);
  });

  it("NEW-A-5 AC2 — an empty project reports null everywhere and an all-zero blend", async () => {
    const s = await scorecards();
    expect(s.engines.every((e) => e.data_source === null)).toBe(true);
    expect(s.blended.data_source).toBeNull();
    expect(s.blend!).toEqual({ policy: "all_measured_engines", live_engines: 0, demo_engines: 0, mixed_engines: 0 });
    const g = await growth();
    expect(g.engines).toEqual([]);
    expect(g.series.every((series) => series.data_source === null)).toBe(true);
  });

  it("NEW-A-5 observability — demo exposure is counted per surface with the workspace id only; live-only is silent", async () => {
    const log = vi.spyOn(Logger.prototype, "log");
    try {
      await capture("gemini", "n1");
      await scorecards();
      expect(log.mock.calls.some(([m]) => (m as { metric?: string }).metric === "nominara_analytics_demo_data_served_total")).toBe(false);
      await capture("chatgpt", DEMO_SEED_MARKER);
      await scorecards();
      const hit = log.mock.calls.map(([m]) => m as Record<string, unknown>).find((m) => m.metric === "nominara_analytics_demo_data_served_total");
      expect(hit).toMatchObject({ surface: "scorecards", workspace_id: workspaceId });
    } finally {
      log.mockRestore();
    }
  });

  describe("NEW-A-5 · engineDataSourcesForProjects — real SQL over several projects", () => {
    const WINDOW = { from: "2026-03-10", to: "2026-03-12" } as const;
    let p1: string;
    let p2: string;
    let p3: string;

    async function addProject(): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain)
         VALUES ($1,$2,'P',$3,'https://e.test','e.test')`,
        [id, workspaceId, `p-${randomUUID().slice(0, 8)}`],
      );
      return id;
    }

    async function captureIn(project: string, engine: string, normalizer: string, at: string, status = "parsed"): Promise<void> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO answer_captures
           (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,
            capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,'api','1.0.0',$8,$9,'{}'::jsonb,'{}','live',$10,true)`,
        [id, workspaceId, project, uuidV7(), promptId, engine, at, normalizer, createHash("sha256").update(id).digest(), status],
      );
    }

    beforeEach(async () => {
      for (const engine of ["copilot", "deepseek"]) {
        await db.query(
          `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,
                                cache_ttl_seconds,volatility_band,min_plan_key,status)
           VALUES ($1,$1,'v','api','1.0.0',86400,'medium','free','active')`,
          [engine],
        );
      }
      p1 = projectId;
      p2 = await addProject();
      p3 = await addProject();
      // p1: gemini live, chatgpt demo, perplexity live AND demo, copilot only FAILED (live-stamped),
      // deepseek only OUTSIDE the window (live-stamped).
      await captureIn(p1, "gemini", "n1", "2026-03-11T10:00:00Z");
      await captureIn(p1, "chatgpt", DEMO_SEED_MARKER, "2026-03-11T10:00:00Z");
      await captureIn(p1, "perplexity", "n1", "2026-03-11T10:00:00Z");
      await captureIn(p1, "perplexity", DEMO_SEED_MARKER, "2026-03-12T10:00:00Z");
      await captureIn(p1, "copilot", "n1", "2026-03-11T10:00:00Z", "failed");
      await captureIn(p1, "deepseek", "n1", "2026-03-01T10:00:00Z");
      // p2: the opposite labels, so a project filter or a label swap cannot hide behind p1.
      await captureIn(p2, "gemini", DEMO_SEED_MARKER, "2026-03-11T10:00:00Z");
      await captureIn(p2, "chatgpt", "n1", "2026-03-11T10:00:00Z");
      await captureIn(p2, "perplexity", "n1", "2026-03-11T10:00:00Z", "blocked");
      // p3: nothing at all.
    });

    const run = (ids: string[], timezone = "UTC", window: { from: string; to: string } = WINDOW) =>
      engineDataSourcesForProjects(db, ids, window.from, window.to, timezone);
    const entries = (map: Map<string, string> | undefined) => [...(map ?? new Map<string, string>()).entries()].sort();

    it("NEW-A-5 AC2 — live, demo and mixed are labelled per project and per engine; failed and out-of-window captures make an engine null", async () => {
      const result = await run([p1, p2, p3]);
      expect(entries(result.get(p1))).toEqual([["chatgpt", "demo"], ["gemini", "live"], ["perplexity", "mixed"]]);
      expect(entries(result.get(p2))).toEqual([["chatgpt", "live"], ["gemini", "demo"]]);
    });

    it("NEW-A-5 AC2 — a project with no captures is an empty map (null stays null, never demo), and an unrequested project is absent", async () => {
      const result = await run([p1, p3]);
      expect(result.get(p3)).toEqual(new Map());
      expect(result.has(p2)).toBe(false);
      expect(await run([])).toEqual(new Map());
    });

    it("NEW-A-5 AC2 — the window is a workspace-local DATE range: the last day is inclusive, the day before the first is out", async () => {
      expect(entries((await run([p1], "UTC", { from: "2026-03-12", to: "2026-03-12" })).get(p1))).toEqual([["perplexity", "demo"]]);
      expect(entries((await run([p1], "UTC", { from: "2026-03-01", to: "2026-03-01" })).get(p1))).toEqual([["deepseek", "live"]]);
      expect((await run([p1], "UTC", { from: "2026-03-13", to: "2026-03-20" })).get(p1)).toEqual(new Map());
    });

    it("NEW-A-5 AC2 — the window uses the workspace timezone, not UTC", async () => {
      await captureIn(p3, "gemini", "n1", "2026-04-10T23:30:00Z");
      const day = { from: "2026-04-11", to: "2026-04-11" };
      expect((await run([p3], "UTC", day)).get(p3)).toEqual(new Map());
      expect(entries((await run([p3], "Pacific/Auckland", day)).get(p3))).toEqual([["gemini", "live"]]);
    });
  });
});
