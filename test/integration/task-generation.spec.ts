import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { taskBaselineMetricsSchema, taskGenerationConditionSchema, taskPlaybookPayloadSchema } from "../../contracts/tasks/index.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { generateTasksForProject, type GenerationSummary } from "../../src/lib/taskgen/generate.js";
import { evaluateRule, parseCondition } from "../../src/lib/taskgen/evaluate.js";
import { captureBaseline } from "../../src/lib/taskgen/baseline.js";
import { SCORING_VERSION } from "../../src/lib/scoring/index.js";
import { refreshProjectSourceIndex } from "../../src/lib/rollup/refresh-project-source-index.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { authorityTaskFingerprint, linkDisplacementToTask } from "../../src/lib/analytics/displacement-recovery.js";
import { DisplacementService } from "../../src/modules/displacement/displacement.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import type { Job } from "bullmq";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import { createTaskGenerateHandler } from "../../src/lib/queue/handlers/task-generate.handler.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { projectQueueLockKey } from "../../src/lib/queue/locks.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// STORY-063 — the task generation engine. Scenario numbers are the story's Test scenarios table.
//
// Facts are `metric_daily` rows written directly: the generator reads facts, not captures, and a hand-built window is
// the only way to put "one bad day", "29 cells" and "exactly the threshold" on the page deliberately.
//
// Window layout for evaluation date D = 2026-10-14 and `window_days` 7: the CURRENT window is 2026-10-08..2026-10-14 and
// the PRIOR window is 2026-10-01..2026-10-07.
const D = "2026-10-14";
const NEXT = "2026-10-15";

describe("STORY-063 · task generation engine", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let promptId: string;
  let catalog: unknown[];
  const tasksService = new TasksService(new NoopRealtimePublisher());
  const displacementService = new DisplacementService(tasksService);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db, MIGRATIONS_DIR);
    catalog = (await db.query("SELECT to_jsonb(r) AS j FROM task_generation_rules r")).rows.map((r) => r.j);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE tasks, ref_counters, metric_daily, displacement_events, project_source_index, source_domains, aux_findings, aux_audits, answer_captures, tracked_prompts, competitors, projects, workspaces CASCADE",
    );
    // The catalog is data and some tests tune it; every test starts from what the migration shipped.
    await db.query("DELETE FROM task_generation_rules");
    await db.query("INSERT INTO task_generation_rules SELECT * FROM jsonb_populate_recordset(NULL::task_generation_rules, $1::jsonb)", [JSON.stringify(catalog)]);
    // The INSERT trigger stamps a rule inserted enabled; the shipped catalog is "evaluated since always", so restore that.
    await db.query("UPDATE task_generation_rules SET enabled_since = NULL");
    runIds = new Map();
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [id, `w-${id.slice(0, 8)}`]);
    }
    await db.query("INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Planet',$3,'https://p.com','p.com')", [
      projectId, workspaceId, `p-${projectId.slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
  });

  // ---- fixtures -----------------------------------------------------------------------------------------------

  const day = (date: string, offset: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

  interface MetricSpec {
    cells?: number;
    present?: number;
    sov?: number;
    owned?: number;
    mentions?: number;
    negative?: number;
    visibility?: number;
    entity?: "brand" | "competitor";
    entityId?: string;
    /** The capture RUN the day's cells belong to. Rows sharing a key are ONE run (one run can straddle local midnight). Defaults to one run a day. */
    run?: string;
    /** Cells the run PLANNED for the engine (default: the cells it wrote). A run that planned 30 and measured 3 lost 27 to failures. */
    planned?: number;
    /** The run is still being captured (status `running`, no `finished_at`): the hourly rollup can see its first cells. */
    inProgress?: boolean;
    /**
     * Several runs that put cells on this local date, each with ITS OWN rates (a manual deep scan beside a scheduled run; a run's tail beside the
     * next run's head). The date row is their blend; the generator judges each run on its own cells. When given, cells / present / sov / owned of
     * the spec itself are ignored.
     */
    parts?: readonly RunPart[];
  }
  interface RunPart {
    run: string;
    cells: number;
    present?: number;
    sov?: number;
    owned?: number;
    planned?: number;
    inProgress?: boolean;
  }
  let runIds = new Map<string, string>();

  /** `cells` answer_captures of one run on one local date, carrying the per-cell facts the generator reads (presence, share, owned citations). */
  async function writeCells(engine: string, date: string, part: Required<Omit<RunPart, "planned" | "inProgress">> & Pick<RunPart, "planned" | "inProgress">): Promise<void> {
    const key = `${engine}|${part.run}`;
    if (!runIds.has(key)) runIds.set(key, uuidV7());
    const capturedAt = `${date}T10:00:00Z`;
    await db.query("DELETE FROM answer_captures WHERE project_id = $1 AND run_id = $2 AND engine_key = $3 AND captured_at = $4", [projectId, runIds.get(key), engine, capturedAt]);
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,sample_index,captured_at,capture_mode,adapter_version,
          normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present,sov,owned_citation_count)
       SELECT gen_random_uuid(),$1,$2,$3,$4,$5,g,$6::timestamptz,'api','1.0.0','n1',sha256(gen_random_uuid()::text::bytea),'{}'::jsonb,'{}','live','parsed',
              g <= $7::int, $8::real, ($9::int / $10::int) + CASE WHEN g <= ($9::int % $10::int) THEN 1 ELSE 0 END
         FROM generate_series(1, $10::int) AS g`,
      [workspaceId, projectId, runIds.get(key), promptId, engine, capturedAt, part.present, part.sov, part.owned, part.cells],
    );
    // The run row the cells belong to: finished unless the test says it is still being captured; it planned what it wrote unless told otherwise.
    const inProgress = part.inProgress === true;
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells, status, started_at, finished_at)
       VALUES ($1, $2, $3, 'scheduled', ARRAY[$4::text], 0, $5, $6::timestamptz, CASE WHEN $5 = 'completed' THEN $6::timestamptz END)
       ON CONFLICT (id) DO NOTHING`,
      [runIds.get(key), workspaceId, projectId, engine, inProgress ? "running" : "completed", capturedAt],
    );
    await db.query(
      `UPDATE capture_runs SET planned_cells = COALESCE($2::int, (SELECT count(*) FROM answer_captures WHERE run_id = $1 AND engine_key = $3))::int WHERE id = $1`,
      [runIds.get(key), part.planned ?? null, engine],
    );
  }

  async function metric(engine: string, date: string, spec: MetricSpec = {}): Promise<void> {
    const entity = spec.entity ?? "brand";
    const parts: (Required<Omit<RunPart, "planned" | "inProgress">> & Pick<RunPart, "planned" | "inProgress">)[] =
      spec.parts !== undefined
        ? spec.parts.map((p) => ({ ...p, present: p.present ?? p.cells, sov: p.sov ?? 0.4, owned: p.owned ?? 0 }))
        : [{ run: spec.run ?? date, cells: spec.cells ?? 5, present: spec.present ?? spec.cells ?? 5, sov: spec.sov ?? 0.4, owned: spec.owned ?? 0, ...(spec.planned === undefined ? {} : { planned: spec.planned }), ...(spec.inProgress === undefined ? {} : { inProgress: spec.inProgress }) }];
    const cells = parts.reduce((n, p) => n + p.cells, 0);
    const present = parts.reduce((n, p) => n + p.present, 0);
    const owned = parts.reduce((n, p) => n + p.owned, 0);
    const sov = cells === 0 ? (spec.sov ?? 0.4) : parts.reduce((n, p) => n + p.sov * p.cells, 0) / cells;
    if (entity === "brand") {
      // The generator judges capture RUNS (a date is not a run) on their own cells, so a day's facts carry the captures that produced them.
      for (const part of parts) if (part.cells > 0) await writeCells(engine, date, part);
    }
    await db.query(
      `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, cells_total, cells_present,
                                 presence_rate, sov, mentions_total, mentions_negative, citations_owned, citations_total, visibility_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14)
       ON CONFLICT (project_id, engine_key, entity_type, entity_id, metric_date, scoring_version) DO UPDATE
         SET cells_total = EXCLUDED.cells_total, cells_present = EXCLUDED.cells_present, presence_rate = EXCLUDED.presence_rate, sov = EXCLUDED.sov,
             mentions_total = EXCLUDED.mentions_total, mentions_negative = EXCLUDED.mentions_negative, citations_owned = EXCLUDED.citations_owned,
             citations_total = EXCLUDED.citations_total, visibility_score = EXCLUDED.visibility_score`,
      [
        workspaceId, projectId, engine, entity, spec.entityId ?? projectId, date, cells, present, cells === 0 ? 0 : present / cells,
        sov, spec.mentions ?? 0, spec.negative ?? 0, owned, spec.visibility ?? 50,
      ],
    );
  }

  /** Seven days ending `end`, one row a day. */
  const GROWTH_DAYS = 14; // Growth runs 1.87 times in 7 days, so its window is 14 days (owner decision 2026-10-19)
  async function windowOf(engine: string, end: string, spec: MetricSpec | ((i: number) => MetricSpec), days = 7): Promise<void> {
    for (let i = 0; i < days; i += 1) await metric(engine, day(end, -i), typeof spec === "function" ? spec(i) : spec);
  }

  /**
   * A prior window at `prior` and a current window at `current` for one engine, ending at D. `days` is the window the engine is compared over:
   * 7, the rule's own, for an engine the workspace's plan does not schedule (the fallback); `GROWTH_DAYS` for ChatGPT on the default Growth plan.
   */
  async function twoWindows(engine: string, prior: MetricSpec | ((i: number) => MetricSpec), current: MetricSpec | ((i: number) => MetricSpec), days = 7): Promise<void> {
    await windowOf(engine, day(D, -days), prior, days);
    await windowOf(engine, D, current, days);
  }

  const generate = (date = D, ws = workspaceId, triggerKinds?: readonly string[]): Promise<GenerationSummary> =>
    withTenantContext(db, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, () =>
      generateTasksForProject(db, tasksService, { projectId, metricDate: date, ...(triggerKinds === undefined ? {} : { triggerKinds }) }),
    );
  const taskRows = async (rule?: string) =>
    (await db.query(`SELECT * FROM tasks ${rule === undefined ? "" : "WHERE rule_code = $1"} ORDER BY created_at, id`, rule === undefined ? [] : [rule])).rows;
  const rule = async (code: string) => (await db.query("SELECT * FROM task_generation_rules WHERE code = $1", [code])).rows[0];
  const events = async (taskId: string) => (await db.query("SELECT * FROM task_events WHERE task_id = $1 ORDER BY occurred_at, id", [taskId])).rows;

  async function capture(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,
          normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present)
       VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','1.0.0','n1',$7,'{}'::jsonb,'{}','live','parsed',true)`,
      [id, workspaceId, projectId, uuidV7(), promptId, `${D}T10:00:00Z`, createHash("sha256").update(id).digest()],
    );
    return id;
  }
  const gapEntry = (domain: string, path = "x") => ({ url: `https://${domain}/${path}`, domain, source_class: "blog", held_by: ["Rival"], brand_present: false });

  async function displacement(over: { impact?: number; citationGap?: unknown[]; detectedAt?: string; recovered?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO displacement_events
         (id,workspace_id,project_id,prompt_id,engine_key,kind,before_result_id,after_result_id,
          displaced_by,citation_gap,concept_gap,impact_score,detected_at,recovered_at)
       VALUES ($1,$2,$3,$4,'gemini','position_lost',$5,$6,'[]'::jsonb,$7::jsonb,'[]'::jsonb,$8,$9,$10)`,
      [id, workspaceId, projectId, promptId, await capture(), await capture(), JSON.stringify(over.citationGap ?? []), over.impact ?? 75,
        over.detectedAt ?? `${D}T12:00:00Z`, over.recovered === true ? `${D}T13:00:00Z` : null],
    );
    return id;
  }

  /** A seedable domain at a critical gap on the project's `all` / 90-day index row — the gate for an authority task. */
  async function actionable(domain: string, severity = "critical"): Promise<string> {
    const sd = (await db.query("INSERT INTO source_domains (workspace_id, domain, is_seedable) VALUES ($1,$2,true) RETURNING id", [workspaceId, domain])).rows[0].id;
    await db.query(
      `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, gap_severity,
                                         brand_present_on_domain, verified_at)
       VALUES ($1,$2,$3,'all','2026-07-16',90,$4,false, now() - interval '1 day')`,
      [workspaceId, projectId, sd, severity],
    );
    return sd;
  }

  async function auxFinding(ruleCode: string, severity: string, detectedAt = `${D}T12:00:00Z`): Promise<string> {
    await db.query(
      `INSERT INTO aux_rule_catalog (code, category, title, description, rationale, severity_default, weight, rule_version)
       VALUES ($1,'crawler_access','T','D','R','high',0.5,'v1') ON CONFLICT (code) DO NOTHING`,
      [ruleCode],
    );
    const audit = (await db.query(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer)
       VALUES ($1,$2,'manual',ARRAY['https://p.com/'],'v1','none') RETURNING id`,
      [workspaceId, projectId],
    )).rows[0].id;
    return (await db.query(
      `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, severity, fingerprint, title, evidence, rule_version, first_detected_at, last_detected_at)
       VALUES ($1,$2,$3,$4,$5,$6,'robots.txt blocks a crawler','{}'::jsonb,'v1',$7,$7) RETURNING id`,
      [workspaceId, projectId, audit, ruleCode, severity, createHash("sha256").update(randomUUID()).digest(), detectedAt],
    )).rows[0].id;
  }

  // ---- the catalog ----------------------------------------------------------------------------------------------

  it("[STORY-063 #1 / AC1] the migration seeds every code the alert catalog generates, each with a condition the closed grammar accepts", async () => {
    const rows = (await db.query("SELECT * FROM task_generation_rules ORDER BY code")).rows;
    const codes = rows.map((r) => r.code);
    for (const code of [
      "TG-SOV-DROP-ENGINE", "TG-SOV-DROP-GLOBAL", "TG-PRESENCE-LOSS", "TG-SENTIMENT-NEGATIVE", "TG-CITATION-LOSS", "TG-COMPETITOR-GAIN",
      "TG-SOURCE-ABSENCE", "TG-PROMPT-UNSTABLE", "TG-DISPLACEMENT-RECOVER", "TG-RENDER-SCHEMA", "TG-ENTITY-NODE", "TG-DIVERGENCE", "TG-TOPIC-CONTENT",
    ]) expect(codes, code).toContain(code);
    expect(codes.filter((c) => c.startsWith("TG-AUX-")).length).toBeGreaterThan(0);
    for (const row of rows) expect(taskGenerationConditionSchema.safeParse(row.condition).success, row.code).toBe(true);
    // The rules whose facts need an analysis that has not shipped are seeded disabled.
    for (const code of ["TG-RENDER-SCHEMA", "TG-ENTITY-NODE", "TG-SENTIMENT-NEGATIVE"]) expect((await rule(code)).enabled, code).toBe(false);
    // STORY-061 / owner decision 20: the A4 and A5 rules are retargeted at their analyses and ENABLED by migration 0152.
    for (const code of ["TG-DIVERGENCE", "TG-TOPIC-CONTENT", "TG-SENTIMENT-REASON"]) expect((await rule(code)).enabled, code).toBe(true);
    // negative_cell_rate is not computable from metric_daily, so the alert is pending, never approximated by another formula.
    expect((await rule("TG-SENTIMENT-NEGATIVE")).condition).toEqual({ kind: "pending_analysis", analysis: "negative_cell_rate" });
    // Hysteresis is in every windowed rule: a sample floor of 30 and a day-level sustain.
    for (const row of rows.filter((r) => r.condition.kind === "metric_window" || r.condition.kind === "competitor_overtake")) {
      expect(row.condition.min_n, row.code).toBeGreaterThanOrEqual(30);
      if (row.condition.kind === "metric_window") expect(row.condition.sustained_days, row.code).toBeGreaterThanOrEqual(2);
    }
    // scoring-models.md §15 numbers, transcribed exactly.
    expect((await rule("TG-SOV-DROP-ENGINE")).cooldown_days).toBe(7);
    expect((await rule("TG-SOV-DROP-ENGINE")).condition).toMatchObject({ threshold: 0.15, window_days: 7, min_n: 30 });
    expect((await rule("TG-SENTIMENT-NEGATIVE")).cooldown_days).toBe(3);
    expect((await rule("TG-COMPETITOR-GAIN")).cooldown_days).toBe(14);
    expect((await rule("TG-SOURCE-ABSENCE")).cooldown_days).toBe(30);
    expect((await rule("TG-DISPLACEMENT-RECOVER")).cooldown_days).toBe(0);
    expect((await rule("TG-DISPLACEMENT-RECOVER")).condition).toMatchObject({ min_impact: 60 });
  });

  it("[STORY-063 AC2] the category CHECK admits exactly content / technical / authority / monitoring — never the classic search dichotomy", async () => {
    const insert = (category: string) =>
      db.query(
        `INSERT INTO task_generation_rules (code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight, effort_band, rule_version)
         VALUES ($1,$2,'t','d','sov_drop','{}'::jsonb,3,0.5,'m','1')`,
        [`TG-X-${randomUUID().slice(0, 6)}`, category],
      );
    for (const ok of ["content", "technical", "authority", "monitoring"]) await expect(insert(ok), ok).resolves.toBeDefined();
    for (const bad of ["on-page", "off-page", "seo", "CONTENT"]) await expect(insert(bad), bad).rejects.toMatchObject({ code: "23514" });
  });

  // ---- scenario 1: each rule's trigger -------------------------------------------------------------------------

  it("[STORY-063 #1] each rule's trigger fires per specification", async () => {
    // TG-SOV-DROP-ENGINE: sov 0.40 -> 0.30 is a 25% relative drop on one engine, n = 35 in both windows.
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    // TG-PRESENCE-LOSS: presence 1.0 -> 0.8 is a 0.20 absolute drop (>= 0.10) on another engine; sov flat.
    await twoWindows("chatgpt", { cells: 10, present: 10 }, { cells: 10, present: 8 }, GROWTH_DAYS);
    // TG-CITATION-LOSS: owned citations 40 -> 20 (50% down, >= 25%) on a third; presence/sov flat.
    await twoWindows("claude", { owned: 4 }, { owned: 2 });
    const summary = await generate();
    // Exactly the three that moved: the negative-sentiment alert is a pending analysis now, so it is not a fourth.
    expect(summary.created).toBe(3);
    const byRule = new Map((await taskRows()).map((t) => [t.rule_code, t]));
    expect(byRule.get("TG-SOV-DROP-ENGINE")!.affected_engines).toEqual(["gemini"]);
    expect(byRule.get("TG-PRESENCE-LOSS")!.affected_engines).toEqual(["chatgpt"]);
    expect(byRule.get("TG-CITATION-LOSS")!.affected_engines).toEqual(["claude"]);
    // The unmoved engines made nothing: sov flat on chatgpt/claude/perplexity (0.4 -> 0.4).
    expect((await taskRows("TG-SOV-DROP-ENGINE")).length).toBe(1);
  });

  it("[STORY-063 #1] TG-SOV-DROP-GLOBAL needs the same drop across >= 3 engines; two engines make only the per-engine tasks", async () => {
    for (const engine of ["gemini", "chatgpt"]) await twoWindows(engine, { cells: 10, sov: 0.4 }, { cells: 10, sov: 0.3 }, engine === "chatgpt" ? GROWTH_DAYS : 7);
    await generate();
    expect(await taskRows("TG-SOV-DROP-GLOBAL")).toHaveLength(0);
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(2);
    await twoWindows("claude", { sov: 0.4 }, { sov: 0.3 });
    await generate();
    const global = await taskRows("TG-SOV-DROP-GLOBAL");
    expect(global).toHaveLength(1);
    expect([...global[0].affected_engines].sort()).toEqual(["chatgpt", "claude", "gemini"]);
  });

  it("[STORY-063 #1] the cross-engine `all` row is not an engine: a drop only there makes no per-engine task and does not count toward the global rule", async () => {
    await twoWindows("all", { sov: 0.4 }, { sov: 0.3 });
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await twoWindows("chatgpt", { cells: 10, sov: 0.4 }, { cells: 10, sov: 0.3 }, GROWTH_DAYS);
    await generate();
    expect((await taskRows("TG-SOV-DROP-ENGINE")).flatMap((t) => t.affected_engines).sort()).toEqual(["chatgpt", "gemini"]);
    expect(await taskRows("TG-SOV-DROP-GLOBAL")).toHaveLength(0);
  });

  it("[STORY-063 #1] TG-COMPETITOR-GAIN fires when a competitor's Visibility Score crosses above the brand's, and not when it was already above", async () => {
    const competitorId = randomUUID();
    await db.query("INSERT INTO competitors (id,workspace_id,project_id,name,root_domain,aliases,source) VALUES ($1,$2,$3,'Rival','r.com',ARRAY[]::text[],'user')", [competitorId, workspaceId, projectId]);
    await windowOf("all", day(D, -7), { visibility: 60 });
    await windowOf("all", D, { visibility: 40 });
    await windowOf("all", day(D, -7), { visibility: 50, entity: "competitor", entityId: competitorId });
    await windowOf("all", D, { visibility: 55, entity: "competitor", entityId: competitorId });
    await generate();
    expect(await taskRows("TG-COMPETITOR-GAIN")).toHaveLength(1);
    // Already above before: no crossing.
    await db.query("TRUNCATE tasks CASCADE");
    await windowOf("all", day(D, -7), { visibility: 70, entity: "competitor", entityId: competitorId });
    await generate();
    expect(await taskRows("TG-COMPETITOR-GAIN")).toHaveLength(0);
  });

  it("[STORY-063 #1] TG-PROMPT-UNSTABLE fires on >= 5 priority prompts below 0.4 stability, not 4", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = randomUUID();
      ids.push(id);
      await db.query(
        `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status,stability_score)
         VALUES ($1,$2,$3,$4,sha256($4::text::bytea),'recommendation','consideration',true,'active',0.3)`,
        [id, workspaceId, projectId, `unstable ${i}`],
      );
    }
    await db.query("UPDATE tracked_prompts SET stability_score = 0.9 WHERE id = $1", [ids[0]]);
    await generate();
    expect(await taskRows("TG-PROMPT-UNSTABLE")).toHaveLength(0);
    await db.query("UPDATE tracked_prompts SET stability_score = 0.3 WHERE id = $1", [ids[0]]);
    await generate();
    const [task] = await taskRows("TG-PROMPT-UNSTABLE");
    expect([...task.affected_prompt_ids].sort()).toEqual([...ids].sort());
  });

  it("[STORY-063 #1] a new critical AUX finding of a catalogued rule makes a technical task linked to the finding; a medium one does not", async () => {
    const critical = await auxFinding("AUX-R-001", "critical");
    await auxFinding("AUX-R-002", "medium");
    await generate();
    const tasks = await taskRows();
    const aux = tasks.filter((t) => t.rule_code?.startsWith("TG-AUX-"));
    expect(aux).toHaveLength(1);
    expect(aux[0].rule_code).toBe("TG-AUX-R-001");
    expect(aux[0].kind).toBe("technical");
    expect(aux[0].source_finding_id).toBe(critical);
  });

  it("[STORY-063 #1] TG-SOURCE-ABSENCE fires for a seedable domain at a critical gap and not for a medium one", async () => {
    await actionable("seed.com");
    await actionable("meh.com", "medium");
    await generate();
    const tasks = await taskRows("TG-SOURCE-ABSENCE");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind).toBe("authority");
    expect(tasks[0].source_domain_id).not.toBeNull();
  });

  // ---- hysteresis -----------------------------------------------------------------------------------------------

  it("[STORY-063 #2] a single bad day inside an otherwise flat window makes NO task", async () => {
    // One day at sov 0 in the current window: the window mean falls 0.40 -> 0.343, a 14.3% drop, under the 15% bar.
    await twoWindows("gemini", { sov: 0.4 }, (i) => ({ sov: i === 0 ? 0 : 0.4 }));
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });


  // ---- hysteresis, from the hazard ---------------------------------------------------------------------------------

  // One bad day must never carry a content rule. Each case is built from the HAZARD (a single bad day, with the same or a much
  // heavier volume than its neighbours), not from the arithmetic of one rule's threshold.
  for (const heavy of [false, true]) {
    it(`[STORY-063 #2] one bad day${heavy ? " with 20x the volume" : ""} cannot generate a task from ANY metric_window rule`, async () => {
      const bad = (i: number, normal: MetricSpec, worst: MetricSpec): MetricSpec => (i === 0 ? { ...worst, ...(heavy ? { cells: 100 } : {}) } : normal);
      // sov (TG-SOV-DROP-*), presence (TG-PRESENCE-LOSS), owned citations (TG-CITATION-LOSS), on three engines so the global rule is in play.
      for (const engine of ["gemini", "chatgpt", "claude"]) {
        await windowOf(engine, day(D, -7), { sov: 0.4, present: 5, owned: 4 });
        await windowOf(engine, D, (i) => bad(i, { sov: 0.4, present: 5, owned: 4 }, { sov: 0, present: 0, owned: 0 }));
      }
      await generate();
      expect(await taskRows()).toHaveLength(0);
    });
  }

  it("[STORY-063 #2] the day floor is exact: the change on 3 of 7 days fires, on 2 of 7 does not, even though both clear the window aggregate", async () => {
    await windowOf("gemini", day(D, -7), { sov: 0.4 });
    // 3 days at 0.1: window mean 0.271 (a 32% drop) and 3 breaching days.
    await windowOf("gemini", D, (i) => ({ sov: i < 3 ? 0.1 : 0.4 }));
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(1);
    await db.query("TRUNCATE tasks CASCADE");
    // 2 days at 0: window mean 0.286 (a 28.6% drop, well over 15%) but only 2 breaching days.
    await windowOf("gemini", D, (i) => ({ sov: i < 2 ? 0 : 0.4 }));
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(0);
  });

  it("[STORY-063 AC4] the negative-sentiment alert is not approximated by the mention rate: a rise in mentions_negative / mentions_total makes no task even when the rule is enabled", async () => {
    // The rate over MENTIONS goes 0 -> 0.17 (the mention-rate rule would fire, n = 42 mentions); the reference alert is the share of
    // CELLS with a negative mention (scoring-models.md §6/§15), which metric_daily cannot yet say. The rule fails closed.
    await db.query("UPDATE task_generation_rules SET enabled = true WHERE code = 'TG-SENTIMENT-NEGATIVE'");
    await windowOf("gemini", day(D, -7), { cells: 30, mentions: 6, negative: 0 });
    await windowOf("gemini", D, { cells: 30, mentions: 6, negative: 1 });
    await generate();
    expect(await taskRows("TG-SENTIMENT-NEGATIVE")).toHaveLength(0);
  });

  it("[STORY-063 #4] a competitor window under the sample floor cannot produce an overtake, in either period", async () => {
    const competitorId = randomUUID();
    await db.query("INSERT INTO competitors (id,workspace_id,project_id,name,root_domain,aliases,source) VALUES ($1,$2,$3,'Rival','r.com',ARRAY[]::text[],'user')", [competitorId, workspaceId, projectId]);
    await windowOf("all", day(D, -7), { visibility: 60 });
    await windowOf("all", D, { visibility: 40 });
    await windowOf("all", day(D, -7), { visibility: 50, entity: "competitor", entityId: competitorId, cells: 2 }); // 14 cells
    await windowOf("all", D, { visibility: 55, entity: "competitor", entityId: competitorId, cells: 2 });
    await generate();
    expect(await taskRows("TG-COMPETITOR-GAIN")).toHaveLength(0);
  });

  it("[STORY-063 #4] a competitor's window is weighted by cells: a one-cell day at 100 does not lift a 50-point competitor over a 55 brand", async () => {
    const competitorId = randomUUID();
    await db.query("INSERT INTO competitors (id,workspace_id,project_id,name,root_domain,aliases,source) VALUES ($1,$2,$3,'Rival','r.com',ARRAY[]::text[],'user')", [competitorId, workspaceId, projectId]);
    await windowOf("all", day(D, -7), { visibility: 60, cells: 6 });
    await windowOf("all", D, { visibility: 55, cells: 6 });
    await windowOf("all", day(D, -7), { visibility: 50, entity: "competitor", entityId: competitorId, cells: 6 });
    // Unweighted mean (100 + 6*50) / 7 = 57.1 (> 55); weighted (1*100 + 36*50) / 37 = 51.4 (< 55).
    await windowOf("all", D, (i) => ({ visibility: i === 0 ? 100 : 50, entity: "competitor", entityId: competitorId, cells: i === 0 ? 1 : 6 }));
    await generate();
    expect(await taskRows("TG-COMPETITOR-GAIN")).toHaveLength(0);
  });

  it("[STORY-063 #2] the window comparison is the unit: the same drop spread across the whole window DOES fire", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(1);
  });

  it("[STORY-063 #3] a sustained change with an adequate sample (n = 30 exactly) makes a task", async () => {
    // 7 days x 5 cells = 35; trim to exactly 30 in both windows: six days of 5 and one empty day.
    await windowOf("gemini", day(D, -7), (i) => ({ sov: 0.4, cells: i === 0 ? 0 : 5 }));
    await windowOf("gemini", D, (i) => ({ sov: 0.3, cells: i === 0 ? 0 : 5 }));
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(1);
  });

  it("[STORY-063 #4] a sustained change with an INSUFFICIENT sample (n = 29) makes NO task — in either window", async () => {
    await windowOf("gemini", day(D, -7), (i) => ({ sov: 0.4, cells: i === 0 ? 4 : i === 1 ? 0 : 5 })); // 4 + 0 + 5*5 = 29
    await windowOf("gemini", D, { sov: 0.3 }); // 35
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(0);
    await windowOf("gemini", day(D, -7), { sov: 0.4 }); // 35
    await windowOf("gemini", D, (i) => ({ sov: 0.3, cells: i === 0 ? 4 : i === 1 ? 0 : 5 })); // 29
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(0);
  });

  it("[STORY-063 #4] a window with no facts at all, or a prior value of zero, makes no task and no error", async () => {
    await generate();
    expect(await taskRows()).toHaveLength(0);
    await twoWindows("gemini", { sov: 0 }, { sov: 0 });
    await expect(generate()).resolves.toBeDefined();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #5] the same rule firing inside its cooldown is suppressed, and fires again once the cooldown has passed", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await generate();
    const [first] = await taskRows("TG-SOV-DROP-ENGINE");
    // Done, so the open-task dedupe no longer applies: only the cooldown stands between the condition and a new task.
    await db.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1", [first.id]);
    const again = await generate(NEXT);
    expect(again.suppressed).toBeGreaterThanOrEqual(1);
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(1);
    // Cooldown is 7 days: a task created 8 days ago no longer suppresses.
    await db.query("UPDATE tasks SET created_at = now() - interval '8 days' WHERE id = $1", [first.id]);
    await generate(NEXT);
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(2);
  });

  // ---- displacement ---------------------------------------------------------------------------------------------

  it("[STORY-063 #6] two high-impact displacements in quick succession BOTH surface — no cooldown applies", async () => {
    await actionable("one.com");
    await actionable("two.com");
    const a = await displacement({ citationGap: [gapEntry("one.com")], impact: 80 });
    const b = await displacement({ citationGap: [gapEntry("two.com")], impact: 72 });
    await generate();
    const tasks = await taskRows("TG-DISPLACEMENT-RECOVER");
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((t) => t.source_displacement_id))).toEqual(new Set([a, b]));
    for (const task of tasks) expect(task.kind).toBe("authority");
    // Each displacement points at its task, so the same event is never planned twice.
    expect((await db.query("SELECT count(*)::int AS n FROM displacement_events WHERE task_id IS NOT NULL")).rows[0].n).toBe(2);
  });

  it("[STORY-063 #6] a displacement on the SAME domain as a recently completed task still surfaces, even with a non-zero cooldown on the rule", async () => {
    await db.query("UPDATE task_generation_rules SET cooldown_days = 14 WHERE code = 'TG-DISPLACEMENT-RECOVER'");
    await actionable("seed.com");
    await displacement({ citationGap: [gapEntry("seed.com")], impact: 80 });
    await generate();
    const [first] = await taskRows("TG-DISPLACEMENT-RECOVER");
    await db.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1", [first.id]);
    await displacement({ citationGap: [gapEntry("seed.com", "y")], impact: 70 });
    await generate();
    expect(await taskRows("TG-DISPLACEMENT-RECOVER")).toHaveLength(2);
  });

  it("[STORY-063 #7] a displacement that was already planned is not planned again after its task is completed", async () => {
    await actionable("seed.com");
    await displacement({ citationGap: [gapEntry("seed.com")], impact: 80 });
    await generate();
    const [first] = await taskRows("TG-DISPLACEMENT-RECOVER");
    await db.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1", [first.id]);
    await generate();
    expect(await taskRows("TG-DISPLACEMENT-RECOVER")).toHaveLength(1);
  });

  it("[STORY-063 #6] the bar is impact >= 60: 60 surfaces, 59.9 does not; a recovered or dismissed event does not", async () => {
    await actionable("edge.com");
    await actionable("low.com");
    await actionable("rec.com");
    await displacement({ citationGap: [gapEntry("edge.com")], impact: 60 });
    await displacement({ citationGap: [gapEntry("low.com")], impact: 59.9 });
    await displacement({ citationGap: [gapEntry("rec.com")], impact: 90, recovered: true });
    await generate();
    expect((await taskRows("TG-DISPLACEMENT-RECOVER")).map((t) => t.affected_url)).toEqual(["https://edge.com/x"]);
  });

  it("[STORY-063 AC5] the rule path and the on-demand recovery plan share one fingerprint, so they collapse into one task", async () => {
    await actionable("seed.com");
    const id = await displacement({ citationGap: [gapEntry("seed.com")], impact: 80 });
    await generate();
    const [task] = await taskRows();
    expect(Buffer.from(task.dedupe_fingerprint).equals(authorityTaskFingerprint(projectId, "seed.com"))).toBe(true);
    const planned = await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => displacementService.recoveryPlan(id));
    expect(planned).toHaveLength(1);
    expect(planned[0]!.id).toBe(task.id);
    expect(await taskRows()).toHaveLength(1);
  });


  // ---- events are planned once, whatever date the job carries ----------------------------------------------------------

  it("[STORY-063 AC5] a displacement detected after local midnight (D+1 00:10) for a run captured on D is planned once, by the job for D or for D+7", async () => {
    await actionable("late.com");
    await displacement({ citationGap: [gapEntry("late.com")], impact: 80, detectedAt: `${NEXT}T00:10:00Z` });
    expect((await generate(D)).created).toBe(1);
    await generate(day(D, 7));
    await generate(NEXT);
    expect(await taskRows("TG-DISPLACEMENT-RECOVER")).toHaveLength(1);
  });

  it("[STORY-063 AC5] a displacement detected NOW while an earlier date is reprocessed is not lost", async () => {
    await actionable("now.com");
    await displacement({ citationGap: [gapEntry("now.com")], impact: 90, detectedAt: new Date().toISOString() });
    // The job carries a date three days before the detection; the event still surfaces.
    const date = day(new Date().toISOString().slice(0, 10), -3);
    expect((await generate(date)).created).toBe(1);
  });

  it("[STORY-063 AC5] a displacement older than the lookback, or one detected before the rule was (re-)enabled, is not planned", async () => {
    // The source-gap rule shares the displacement rule's fingerprint, so left on it would take these domains first.
    await db.query("UPDATE task_generation_rules SET enabled = false WHERE code = 'TG-SOURCE-ABSENCE'");
    await actionable("old.com");
    await actionable("off.com");
    await displacement({ citationGap: [gapEntry("old.com")], impact: 80, detectedAt: `${day(D, -45)}T12:00:00Z` });
    await generate(D);
    expect(await taskRows("TG-DISPLACEMENT-RECOVER")).toHaveLength(0);
    // Timestamp watermark: detected an hour before the rule was switched on.
    await db.query("UPDATE task_generation_rules SET enabled_since = $1 WHERE code = 'TG-DISPLACEMENT-RECOVER'", [`${D}T13:00:00Z`]);
    await displacement({ citationGap: [gapEntry("off.com")], impact: 80, detectedAt: `${D}T12:00:00Z` });
    await generate(D);
    expect(await taskRows("TG-DISPLACEMENT-RECOVER")).toHaveLength(0);
    await displacement({ citationGap: [gapEntry("old.com", "z")], impact: 80, detectedAt: `${D}T14:00:00Z` });
    await generate(D);
    expect(await taskRows("TG-DISPLACEMENT-RECOVER")).toHaveLength(1);
  });

  it("[STORY-063 #6] a second loss on the SAME domain the SAME day is not folded away: it refreshes the open task, counts once, and is linked", async () => {
    await actionable("dup.com");
    const first = await displacement({ citationGap: [gapEntry("dup.com", "a")], impact: 70 });
    await generate();
    const second = await displacement({ citationGap: [gapEntry("dup.com", "b")], impact: 85 });
    const again = await generate();
    expect(again.refreshed).toBe(1);
    const [task] = await taskRows("TG-DISPLACEMENT-RECOVER");
    expect(await taskRows("TG-DISPLACEMENT-RECOVER")).toHaveLength(1);
    expect(task.recurrence_count).toBe(1);
    expect(task.source_displacement_id).toBe(first);
    const refreshed = (await events(task.id)).filter((e) => e.event === "evidence_refreshed");
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].payload).toMatchObject({ source_displacement_id: second, recurrence_count: 1 });
    expect((await db.query("SELECT count(*)::int AS n FROM displacement_events WHERE task_id = $1", [task.id])).rows[0].n).toBe(2);
    // Consumed once: running again counts nothing more.
    await generate();
    await generate(NEXT);
    expect((await taskRows("TG-DISPLACEMENT-RECOVER"))[0].recurrence_count).toBe(1);
  });

  it("[STORY-063 AC3] an AUX finding from an audit that finishes after the day's rollup, or on a day no rollup runs, still becomes a task", async () => {
    const finding = await auxFinding("AUX-R-001", "critical", `${D}T23:30:00Z`);
    // Evaluated for the day before the finding, and for a week later.
    await generate(day(D, -1));
    await generate(day(D, 7));
    const aux = (await taskRows()).filter((t) => t.rule_code === "TG-AUX-R-001");
    expect(aux).toHaveLength(1);
    expect(aux[0].source_finding_id).toBe(finding);
  });

  it("[STORY-063 AC3] a finding that has a task is not planned again; one that REGRESSES after it is, and a finding detected before the rule was enabled is not", async () => {
    const finding = await auxFinding("AUX-R-002", "critical");
    await generate();
    await db.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE source_finding_id = $1", [finding]);
    await generate();
    expect((await taskRows()).filter((t) => t.rule_code === "TG-AUX-R-002")).toHaveLength(1);
    await db.query("UPDATE aux_findings SET status = 'regressed', regressed_at = now() + interval '1 minute' WHERE id = $1", [finding]);
    await generate();
    expect((await taskRows()).filter((t) => t.rule_code === "TG-AUX-R-002")).toHaveLength(2);
    // Watermark: a finding first detected before the rule's enabled_since is the period the rule was off.
    await db.query("UPDATE task_generation_rules SET enabled_since = now() + interval '1 hour' WHERE code = 'TG-AUX-R-003'");
    await auxFinding("AUX-R-003", "critical");
    await generate();
    expect((await taskRows()).filter((t) => t.rule_code === "TG-AUX-R-003")).toHaveLength(0);
  });

  it("[STORY-063 AC13 / hazard] a rule inserted enabled starts at its insertion: it does not reach back into history", async () => {
    await db.query(
      `INSERT INTO task_generation_rules (code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight, effort_band, cooldown_days, rule_version)
       VALUES ('TG-AUX-R-004-NEW','technical','t','d','aux_finding','{"kind":"aux_finding","aux_rule_code":"AUX-R-009","severities":["critical"]}'::jsonb,3,0.5,'s',0,'1')`,
    );
    expect((await rule("TG-AUX-R-004-NEW")).enabled_since).not.toBeNull();
    await auxFinding("AUX-R-009", "critical", `${day(D, -10)}T12:00:00Z`);
    await generate();
    expect((await taskRows()).filter((t) => t.rule_code === "TG-AUX-R-004-NEW")).toHaveLength(0);
  });

  it("[STORY-063 AC10] the source-gap rule and the recovery plan agree on actionability: a critical row superseded by a newer medium one is neither", async () => {
    const sd = await actionable("fixed.com");
    await db.query(
      `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, gap_severity)
       VALUES ($1,$2,$3,'all','2026-07-17',90,'medium')`,
      [workspaceId, projectId, sd],
    );
    const id = await displacement({ citationGap: [gapEntry("fixed.com")], impact: 80 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
    const planned = await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => displacementService.recoveryPlan(id));
    expect(planned).toHaveLength(0);
  });

  // ---- idempotency and recurrence -------------------------------------------------------------------------------

  it("[STORY-063 #7] running the same evaluation five times leaves the task count — and the recurrence counter — unchanged", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await actionable("seed.com");
    await displacement({ citationGap: [gapEntry("seed.com")], impact: 80 });
    await generate();
    const before = await taskRows();
    expect(before.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 4; i += 1) await generate();
    const after = await taskRows();
    expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
    expect(after.map((t) => t.recurrence_count)).toEqual(before.map(() => 0));
    for (const t of after) expect((await events(t.id)).filter((e) => e.event === "evidence_refreshed")).toHaveLength(0);
    expect((await db.query("SELECT next_value FROM ref_counters")).rows[0].next_value).toBe(before.length + 1);
  });

  it("[STORY-063 #8] a condition that recurs on a LATER day while the task is open refreshes evidence and increments the counter — no duplicate", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await metric("gemini", NEXT, { sov: 0.3 });
    await generate();
    const [created] = await taskRows("TG-SOV-DROP-ENGINE");
    expect(created.recurrence_count).toBe(0);
    await generate(NEXT);
    const rows = await taskRows("TG-SOV-DROP-ENGINE");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.id);
    expect(rows[0].recurrence_count).toBe(1);
    expect(new Date(rows[0].last_evidence_at).getTime()).toBeGreaterThan(new Date(created.last_evidence_at).getTime());
    const refreshed = (await events(created.id)).filter((e) => e.event === "evidence_refreshed");
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].actor_type).toBe("system");
    expect(refreshed[0].actor_id).toBeNull();
    expect(refreshed[0].payload).toMatchObject({ metric_date: NEXT, recurrence_count: 1 });
  });

  it("[STORY-063 #8] a recurrence on an out-of-order (older) date does not move the evidence backwards or count again", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await metric("gemini", NEXT, { sov: 0.3 });
    await generate(NEXT);
    await generate(D);
    const [task] = await taskRows("TG-SOV-DROP-ENGINE");
    expect(task.recurrence_count).toBe(0);
  });

  // ---- what a task records --------------------------------------------------------------------------------------

  it("[STORY-063 #9 / AC8 / AC10] a generated task records its rule, evidence links, baseline, impact score and effort band — all from the rule", async () => {
    await twoWindows("gemini", { sov: 0.4, visibility: 50, owned: 1 }, { sov: 0.3, visibility: 42, owned: 1 });
    await generate();
    const [task] = await taskRows("TG-SOV-DROP-ENGINE");
    const r = await rule("TG-SOV-DROP-ENGINE");
    expect(task.origin).toBe("auto");
    expect(task.kind).toBe(r.category);
    expect(task.effort_band).toBe(r.effort_band);
    expect(task.priority).toBe(r.default_priority);
    expect(task.impact_score).toBeGreaterThan(0);
    expect(task.impact_score).toBeLessThanOrEqual(100);
    expect(task.impact_score).toBeLessThanOrEqual(100 * r.impact_weight + 1e-6);
    expect(task.affected_engines).toEqual(["gemini"]);
    expect(task.title).toContain("gemini");
    expect(task.title).not.toMatch(/[{}]/u);
    const baseline = taskBaselineMetricsSchema.parse(task.baseline_metrics);
    expect(baseline.engine_key).toBe("gemini");
    expect(baseline.metric_date).toBe(D);
    expect(baseline.sov).toBeCloseTo(0.3, 5);
    expect(baseline.cells_total).toBe(35);
    const created = (await events(task.id)).find((e) => e.event === "created")!;
    expect(created.actor_type).toBe("system");
    expect(created.actor_id).toBeNull();
  });

  it("[STORY-063 #9] impact orders the queue: the higher-impact rule's task sorts first", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await twoWindows("chatgpt", { cells: 10, present: 10 }, { cells: 10, present: 8 }, GROWTH_DAYS);
    await generate();
    const ordered = (await db.query("SELECT rule_code FROM tasks ORDER BY impact_score DESC, id")).rows.map((r) => r.rule_code);
    const impacts = (await db.query("SELECT impact_score FROM tasks ORDER BY impact_score DESC")).rows.map((r) => r.impact_score);
    expect(ordered.length).toBeGreaterThanOrEqual(2);
    expect([...impacts].sort((a, b) => b - a)).toEqual(impacts);
    expect(new Set(impacts).size).toBeGreaterThan(1);
  });

  it("[STORY-063 #10 / AC9] the baseline is captured AT CREATION: later facts and later evaluations never rewrite it", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await generate();
    const [created] = await taskRows("TG-SOV-DROP-ENGINE");
    const baseline = taskBaselineMetricsSchema.parse(created.baseline_metrics);
    expect(new Date(baseline.captured_at).getTime()).toBeLessThanOrEqual(new Date(created.created_at).getTime());
    // The world moves on: sov recovers to 0.45, and the condition keeps being evaluated on later days.
    await windowOf("gemini", D, { sov: 0.45 });
    await windowOf("gemini", NEXT, { sov: 0.2 });
    await metric("gemini", NEXT, { sov: 0.2 });
    await generate(NEXT);
    const [later] = await taskRows("TG-SOV-DROP-ENGINE");
    expect(later.baseline_metrics).toEqual(created.baseline_metrics);
    expect(taskBaselineMetricsSchema.parse(later.baseline_metrics).sov).toBeCloseTo(0.3, 5);
    // Completion does not touch it either: complete the task through the real path and read the baseline back. (A baseline written
    // or overwritten at completion would be a "before" that postdates the work.)
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => tasksService.completeTask(created.id));
    const [done] = await taskRows("TG-SOV-DROP-ENGINE");
    expect(done.status).toBe("done");
    expect(done.baseline_metrics).toEqual(created.baseline_metrics);
    expect(done.completion_metrics).toBeNull();
  });

  it("[STORY-063 #10] a baseline with no facts keeps null distinct from zero", async () => {
    // A displacement-driven task on a project with no rollup rows: nothing was measured, so nothing is invented.
    await actionable("seed.com");
    await displacement({ citationGap: [gapEntry("seed.com")], impact: 80 });
    await generate();
    const [task] = await taskRows("TG-DISPLACEMENT-RECOVER");
    const baseline = taskBaselineMetricsSchema.parse(task.baseline_metrics);
    expect(baseline.sov).toBeNull();
    expect(baseline.visibility_score).toBeNull();
    expect(baseline.cells_total).toBe(0);
  });

  it("[STORY-063 #11 / AC11] an authority rule attaches its playbook reference and a payload the contract accepts", async () => {
    const sd = await actionable("seed.com");
    await db.query("UPDATE source_domains SET seeding_playbook_slug = 'reddit-answer' WHERE id = $1", [sd]);
    await displacement({ citationGap: [gapEntry("seed.com")], impact: 80 });
    await generate();
    for (const task of [...(await taskRows("TG-DISPLACEMENT-RECOVER")), ...(await taskRows("TG-SOURCE-ABSENCE"))]) {
      expect(task.kind).toBe("authority");
      expect(task.playbook_slug).toBe("reddit-answer");
      const payload = taskPlaybookPayloadSchema.parse(task.playbook_payload);
      expect(payload.target_domain).toBe("seed.com");
      expect(payload.do_not.join(" ")).toMatch(/behalf/u);
    }
  });

  // ---- enable / disable / tuning --------------------------------------------------------------------------------

  it("[STORY-063 #12 / AC13] a disabled rule generates nothing, and re-enabling does not retroactively generate for the disabled period", async () => {
    // Facts for a day entirely in the past, so "the disabled period" is unambiguous.
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await db.query("UPDATE task_generation_rules SET enabled = false WHERE code = 'TG-SOV-DROP-ENGINE'");
    await generate();
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(0);
    await db.query("UPDATE task_generation_rules SET enabled = true WHERE code = 'TG-SOV-DROP-ENGINE'");
    expect((await rule("TG-SOV-DROP-ENGINE")).enabled_since).not.toBeNull();
    // A dirty-date reprocess of the disabled period does not generate.
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(0);
    // A date after the re-enable does.
    const today = new Date().toISOString().slice(0, 10);
    await windowOf("gemini", day(today, -7), { sov: 0.4 });
    await windowOf("gemini", today, { sov: 0.3 });
    await generate(today);
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(1);
  });

  it("[STORY-063 #12] the watermark moves only on a false -> true flip: tuning an enabled rule leaves it alone", async () => {
    await db.query("UPDATE task_generation_rules SET enabled_since = '2020-01-01' WHERE code = 'TG-SOV-DROP-ENGINE'");
    await db.query("UPDATE task_generation_rules SET cooldown_days = 9 WHERE code = 'TG-SOV-DROP-ENGINE'");
    await db.query("UPDATE task_generation_rules SET enabled = true WHERE code = 'TG-SOV-DROP-ENGINE'");
    expect(new Date((await rule("TG-SOV-DROP-ENGINE")).enabled_since).getUTCFullYear()).toBe(2020);
  });

  it("[STORY-063 #13 / AC1] changing a condition in the catalog takes effect on the next evaluation, with no deploy", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 }); // a 25% drop
    const r = await rule("TG-SOV-DROP-ENGINE");
    await db.query("UPDATE task_generation_rules SET condition = $2::jsonb WHERE code = $1", [r.code, JSON.stringify({ ...r.condition, threshold: 0.5 })]);
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(0);
    await db.query("UPDATE task_generation_rules SET condition = $2::jsonb WHERE code = $1", [r.code, JSON.stringify({ ...r.condition, threshold: 0.2 })]);
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(1);
  });

  it("[STORY-063 #13] a rule whose condition does not parse is skipped and counted — nothing is generated from a half-valid rule", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await db.query(`UPDATE task_generation_rules SET condition = '{"kind":"metric_window","metric":"sov","where":"1=1"}'::jsonb WHERE code = 'TG-SOV-DROP-ENGINE'`);
    const metrics: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void metrics.push(m));
    try {
      await generate();
    } finally {
      spy.mockRestore();
    }
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(0);
    expect(metrics).toContainEqual(expect.objectContaining({ metric: "nominara_taskgen_rules_invalid_total" }));
  });

  it("[STORY-063 hazard] a rule for a not-yet-built analysis generates nothing even when enabled — it fails closed", async () => {
    await db.query("UPDATE task_generation_rules SET enabled = true WHERE code IN ('TG-TOPIC-CONTENT','TG-DIVERGENCE','TG-ENTITY-NODE','TG-RENDER-SCHEMA','TG-SENTIMENT-NEGATIVE')");
    await expect(generate()).resolves.toBeDefined();
    expect(await taskRows()).toHaveLength(0);
  });

  // ---- the queue seam -------------------------------------------------------------------------------------------

  const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
  const job = (payload: Record<string, unknown>, id?: string): Job => ({ id, data: { payload: { workspaceId, kid: "test-kid", projectId, ...payload } } }) as unknown as Job;

  it("[STORY-063 #3 / AC3] the task.generate handler evaluates the catalog under the job's tenant context and creates the task", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    const handler = createTaskGenerateHandler(context, { realtime: new NoopRealtimePublisher() });
    const summary = await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => handler(db, job({ metricDate: D })));
    expect(summary).toMatchObject({ created: 1 });
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(1);
  });

  it("[STORY-063 #3] the task.generate payload is strict, and a redelivered job writes nothing more", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    const handler = createTaskGenerateHandler(context, { realtime: new NoopRealtimePublisher() });
    const run = (payload: Record<string, unknown>) => withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => handler(db, job(payload)));
    await expect(run({ metricDate: D, rule: "TG-X" })).rejects.toThrow();
    await run({ metricDate: D });
    await run({ metricDate: D });
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(1);
  });

  it("[STORY-063 #3 / AC3] a rollup enqueues task.generate for the day it rolled up — after commit, keyed by the rollup job", async () => {
    const calls: unknown[] = [];
    const rollup = createRollupMetricDailyHandler(context, {
      enqueueVerifyPresence: async () => undefined,
      enqueueTaskGenerate: async (ws, payload, key) => void calls.push({ ws, payload, key }),
    });
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => rollup(db, job({ metricDate: D }, "rollup-job-1")));
    await new Promise((resolve) => setImmediate(resolve));
    // D is in the past, so the evaluated day is today: a window anchored on an old date would raise tasks from a stale period.
    const today = new Date().toISOString().slice(0, 10);
    expect(calls).toEqual([{ ws: workspaceId, payload: { projectId, metricDate: today }, key: `taskgen:${projectId}:${today}:rollup-job-1` }]);
  });

  it("[STORY-063 #3] a failed enqueue never fails the rollup", async () => {
    const rollup = createRollupMetricDailyHandler(context, {
      enqueueVerifyPresence: async () => undefined,
      enqueueTaskGenerate: async () => {
        throw new Error("valkey down");
      },
    });
    await expect(withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => rollup(db, job({ metricDate: D })))).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
  });


  it("[STORY-063 hazard] two task.generate jobs for one project serialise on a project lock instead of overlapping", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    const handler = createTaskGenerateHandler(context, { realtime: new NoopRealtimePublisher() });
    const holder = new Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [projectQueueLockKey("task.generate", projectId)]);
      let finished = false;
      const running = withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => handler(db, job({ metricDate: D }))).then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(finished).toBe(false);
      await holder.query("COMMIT");
      await running;
      expect(finished).toBe(true);
    } finally {
      await holder.end();
    }
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(1);
  });

  it("[STORY-063 hazard] the on-demand recovery plan takes the same per-project lock as task.generate, so an API call and a worker job cannot deadlock", async () => {
    await actionable("lock.com");
    const id = await displacement({ citationGap: [gapEntry("lock.com")], impact: 80 });
    const holder = new Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [projectQueueLockKey("task.generate", projectId)]);
      let finished = false;
      const running = withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => displacementService.recoveryPlan(id)).then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(finished).toBe(false);
      await holder.query("COMMIT");
      await running;
    } finally {
      await holder.end();
    }
    expect(await taskRows()).toHaveLength(1);
  });

  it("[STORY-063 hazard] two task.generate jobs for one project running at once make one task and no error", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await actionable("one.com");
    await actionable("two.com");
    await displacement({ citationGap: [gapEntry("one.com"), gapEntry("two.com")], impact: 80 });
    await displacement({ citationGap: [gapEntry("two.com", "b"), gapEntry("one.com", "b")], impact: 75 });
    const handler = createTaskGenerateHandler(context, { realtime: new NoopRealtimePublisher() });
    const second = new Client({ connectionString: container.getConnectionUri() });
    await second.connect();
    try {
      const results = await Promise.allSettled([
        withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => handler(db, job({ metricDate: D }, "a"))),
        withTenantContext(second, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => handler(second, job({ metricDate: D }, "b"))),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      await second.end();
    }
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(1);
    expect(await taskRows("TG-DISPLACEMENT-RECOVER")).toHaveLength(2);
  });

  it("[STORY-063 hazard] the owning service validates the jsonb it writes: a malformed baseline is refused, not stored", async () => {
    await expect(
      withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () =>
        tasksService.createGeneratedTask({
          projectId, kind: "monitoring", origin: "auto", ruleCode: null, fingerprint: createHash("sha256").update("x").digest(), title: "t", description: "d",
          sourceDisplacementId: null, sourceDomainId: null, affectedUrl: null,
          generation: { baselineMetrics: { captured_at: "not a date" } as never },
        }),
      ),
    ).rejects.toThrow();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 migration] rolling 0129 back restores an upgraded placeholder instead of deleting it, and drops the catalog the engine owns", async () => {
    const down = readFileSync(join(MIGRATIONS_DIR, "0129_task_generation_engine.down.sql"), "utf8");
    await db.query("BEGIN");
    try {
      await db.query(down);
      const restored = (await db.query("SELECT condition, rule_version FROM task_generation_rules WHERE code = 'TG-SOV-DROP-ENGINE'")).rows[0];
      expect(restored).toEqual({ condition: {}, rule_version: "1.0.0" });
      expect((await db.query("SELECT count(*)::int AS n FROM task_generation_rules WHERE code = 'TG-PRESENCE-LOSS'")).rows[0].n).toBe(0);
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("[STORY-063 hazard] a regression is counted ONCE: three later days on a finding that stays regressed raise recurrence_count to 1, not 3", async () => {
    const finding = await auxFinding("AUX-R-001", "critical");
    await generate();
    const [task] = (await taskRows()).filter((t) => t.rule_code === "TG-AUX-R-001");
    // The task was made two hours ago and is still open when the finding regresses an hour ago; the clock is the real one because
    // `regressed_at` and the task's own timestamps are wall-clock time, while the evaluated dates below are real days.
    await db.query("UPDATE tasks SET created_at = now() - interval '2 hours' WHERE id = $1", [task.id]);
    await db.query("UPDATE aux_findings SET status = 'regressed', regressed_at = now() - interval '1 hour' WHERE id = $1", [finding]);
    const today = new Date().toISOString().slice(0, 10);
    for (const date of [today, day(today, 1), day(today, 2)]) await generate(date);
    const [after] = (await taskRows()).filter((t) => t.rule_code === "TG-AUX-R-001");
    expect(after.id).toBe(task.id);
    expect(after.recurrence_count).toBe(1);
  });

  // ---- round 2: from the hazard, against the shapes production writes ----------------------------------------------

  const realToday = (): string => new Date().toISOString().slice(0, 10);
  const auxTasks = async (code: string) => (await taskRows()).filter((t) => t.rule_code === code);

  it("[STORY-063 hazard] a critical finding that regresses the day its task was completed surfaces again: a done task absorbs nothing", async () => {
    // Anchored on the REAL date: `last_evidence_at` is the end of the evaluated day, a future instant when that day is today.
    const finding = await auxFinding("AUX-R-001", "critical", new Date(Date.now() - 3_600_000).toISOString());
    const today = realToday();
    await generate(today);
    await db.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE source_finding_id = $1", [finding]);
    await db.query("UPDATE aux_findings SET status = 'regressed', regressed_at = now() + interval '1 minute' WHERE id = $1", [finding]);
    await generate(today);
    await generate(day(today, 1));
    expect(await auxTasks("TG-AUX-R-001")).toHaveLength(2);
  });

  it("[STORY-063 hazard] a second regression on the same day as the first refresh is counted too: each regression exactly once", async () => {
    const finding = await auxFinding("AUX-R-001", "critical");
    await generate(realToday());
    const [task] = await auxTasks("TG-AUX-R-001");
    await db.query("UPDATE tasks SET created_at = now() - interval '3 hours' WHERE id = $1", [task.id]);
    await db.query("UPDATE aux_findings SET status = 'regressed', regressed_at = now() - interval '2 hours' WHERE id = $1", [finding]);
    for (const date of [realToday(), realToday(), day(realToday(), 1)]) await generate(date);
    expect((await auxTasks("TG-AUX-R-001"))[0].recurrence_count).toBe(1);
    // The refresh happened an hour ago; the finding regresses again 10 minutes ago, the same local day.
    await db.query("UPDATE task_events SET occurred_at = now() - interval '1 hour' WHERE task_id = $1 AND event = 'evidence_refreshed'", [task.id]);
    await db.query("UPDATE aux_findings SET regressed_at = now() - interval '10 minutes' WHERE id = $1", [finding]);
    for (const date of [realToday(), realToday(), day(realToday(), 1)]) await generate(date);
    const after = await auxTasks("TG-AUX-R-001");
    expect(after).toHaveLength(1);
    expect(after[0].recurrence_count).toBe(2);
  });

  it("[STORY-063 AC4 / hazard] one heavy bad day plus low-volume blips cannot reach sustained_days: a 1-cell day is not a breaching day, for ANY metric_window rule", async () => {
    const shape = (i: number): MetricSpec => {
      if (i === 0) return { cells: 100, sov: 0, present: 0, owned: 0 };
      if (i < 3) return { cells: 1, sov: 0, present: 0, owned: 0 };
      return { cells: 5, sov: 0.4, present: 5, owned: 4 };
    };
    for (const engine of ["gemini", "chatgpt", "claude"]) {
      await windowOf(engine, day(D, -7), { sov: 0.4, present: 5, owned: 4 });
      await windowOf(engine, D, shape);
    }
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  // The production writer of project_source_index: every refresh DELETEs the project's rows and re-inserts them with a new
  // window_start and computed_at, carrying only verified presence. These tests drive THAT, not hand-built row pairs.
  async function refreshIndex(date: string): Promise<void> {
    await db.query("BEGIN");
    await refreshProjectSourceIndex(db, projectId, date);
    await db.query("COMMIT");
  }

  async function verifiedGap(domain: string, verifiedAgo: string): Promise<void> {
    const url = `https://${domain}/p/1`;
    await db.query(
      `INSERT INTO citation_facts (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url,
                                   url_hash, domain, is_owned, is_competitor, http_status, position_weight)
       VALUES ($1,$2,$3,$4,'gemini', now() - interval '1 day', 1, $5, $5, $6, $7, false, false, 200, 1)`,
      [workspaceId, projectId, randomUUID(), promptId, url, createHash("sha256").update(url).digest(), domain],
    );
    await refreshIndex(realToday());
    await db.query(
      `UPDATE project_source_index psi SET brand_present_on_domain = false, verified_at = now() - $3::interval
         FROM source_domains sd WHERE sd.id = psi.source_domain_id AND psi.project_id = $1 AND sd.domain = $2`,
      [projectId, domain, verifiedAgo],
    );
    await refreshIndex(realToday()); // verified presence is carried across a recompute
    const row = (await db.query("SELECT gap_severity FROM project_source_index WHERE project_id = $1 AND engine_key = 'all' AND window_days = 90", [projectId])).rows[0];
    expect(row.gap_severity).toBe("critical");
  }

  it("[STORY-063 hazard] a persistent critical gap, refreshed by the REAL index writer every day, is planned once and never refreshed as a recurrence", async () => {
    await verifiedGap("reddit.com", "1 day");
    const today = realToday();
    await generate(today);
    expect(await taskRows("TG-SOURCE-ABSENCE")).toHaveLength(1);
    for (let i = 1; i <= 4; i += 1) {
      await refreshIndex(day(today, i)); // DELETE + re-insert: a new window_start and computed_at every time
      await generate(day(today, i));
    }
    const [task] = await taskRows("TG-SOURCE-ABSENCE");
    expect(task.recurrence_count).toBe(0);
    expect(await events(task.id)).toHaveLength(1);
    // Completed, the gap persists: nothing regenerates until the gap is verified AGAIN.
    await db.query("UPDATE tasks SET status = 'done', completed_at = now(), created_at = now() - interval '40 days' WHERE id = $1", [task.id]);
    await db.query("UPDATE project_source_index SET verified_at = now() - interval '45 days' WHERE project_id = $1", [projectId]);
    for (let i = 5; i <= 7; i += 1) {
      await refreshIndex(day(today, i));
      await generate(day(today, i));
    }
    expect(await taskRows("TG-SOURCE-ABSENCE")).toHaveLength(1);
    // Verified again (and the 30-day cooldown has passed): ONE new task, and only one however many days follow.
    await db.query("UPDATE project_source_index SET verified_at = now() - interval '1 hour' WHERE project_id = $1", [projectId]);
    for (let i = 8; i <= 10; i += 1) {
      await refreshIndex(day(today, i));
      await generate(day(today, i));
    }
    expect(await taskRows("TG-SOURCE-ABSENCE")).toHaveLength(2);
  });

  it("[STORY-063 hazard] an OPEN task for a gap that is verified again is refreshed once, however many daily index refreshes follow", async () => {
    await verifiedGap("reddit.com", "1 day");
    const today = realToday();
    await generate(today);
    const [task] = await taskRows("TG-SOURCE-ABSENCE");
    await db.query("UPDATE tasks SET created_at = now() - interval '40 days' WHERE id = $1", [task.id]);
    await db.query("UPDATE project_source_index SET verified_at = now() - interval '1 hour' WHERE project_id = $1", [projectId]);
    for (let i = 1; i <= 4; i += 1) {
      await refreshIndex(day(today, i));
      await generate(day(today, i));
    }
    const rows = await taskRows("TG-SOURCE-ABSENCE");
    expect(rows).toHaveLength(1);
    expect(rows[0].recurrence_count).toBe(1);
  });

  it("[STORY-063 AC13] a windowed rule inserted after the fact does not generate when an earlier date is reprocessed", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await db.query("DELETE FROM task_generation_rules");
    await db.query(
      `INSERT INTO task_generation_rules (code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight, effort_band, cooldown_days, rule_version)
       VALUES ('TG-SOV-NEW','monitoring','t {engine}','d','sov_drop',
               '{"kind":"metric_window","metric":"sov","direction":"down","change":"relative","threshold":0.15,"window_days":7,"min_n":30,"sustained_days":3,"engine_scope":"each_engine"}'::jsonb,3,0.5,'s',0,'1')`,
    );
    await generate(D);
    expect(await taskRows("TG-SOV-NEW")).toHaveLength(0);
    // Reaching the present it does evaluate: the watermark holds back the past, not the rule.
    const today = new Date().toISOString().slice(0, 10);
    await windowOf("gemini", day(today, -7), { sov: 0.4 });
    await windowOf("gemini", today, { sov: 0.3 });
    await generate(today);
    expect(await taskRows("TG-SOV-NEW")).toHaveLength(1);
  });

  // ---- "sustained" is measured over capture RUNS, in a window derived from the plan's cadence -----------------------------------------
  //
  // Capture cadence is plan-driven (Starter weekly = 4 runs a 30-day cycle, Growth twice weekly = 8, Business daily). Starter's 7.5-day
  // interval can leave a 7-day window with no run at all, so for a weekly cadence a `window_days: 7` rule compares the last 14 days
  // with the 14 days before (owner decision 2026-10-19): two runs a side, and the drop must hold in both recent runs. A plan that
  // runs at least twice in `window_days` keeps the rule's own window. These tests seed the cadence the product runs, at the volume
  // the plan can produce: Starter holds at most 30 prompts (drift sampling off), so a run is at most 30 cells per engine.
  const setPlan = (key: string): Promise<unknown> => db.query("UPDATE workspaces SET plan_key = $1 WHERE id = $2", [key, workspaceId]);
  const STARTER_ENGINE = "chatgpt"; // entitled on every plan; Starter's cadence is `{"full":4}`
  /** Starter's weekly runs, NEWEST FIRST, as days back from D: two in the current 14 days (D-13..D) and two in the 14 before. */
  const STARTER_RUN_OFFSETS = [2, 10, 17, 25] as const;
  async function starterRuns(sovs: readonly (number | undefined)[], cells = 30, engine = STARTER_ENGINE): Promise<void> {
    for (const [i, offset] of STARTER_RUN_OFFSETS.entries()) {
      const sov = sovs[i];
      if (sov !== undefined) await metric(engine, day(D, -offset), { cells, sov });
    }
  }
  /** Growth's runs (every 3.75 days, 14-day windows): three capture days at `GROWTH` (days back from each window's last day) in the current (k = 0) and prior (1) windows. */
  const GROWTH = [2, 6, 10];
  async function growthRuns(engine: string, spec: (k: number, j: number) => MetricSpec | undefined): Promise<void> {
    for (let k = 0; k < 2; k += 1) {
      for (const [j, offset] of GROWTH.entries()) {
        const row = spec(k, j);
        if (row !== undefined) await metric(engine, day(day(D, -14 * k), -offset), row);
      }
    }
  }
  const reset = (): Promise<unknown> => db.query("TRUNCATE tasks, metric_daily, answer_captures, capture_runs CASCADE");

  it("[STORY-063 #14 / AC3] Starter (weekly): a drop that holds in both of the last two runs, at the plan's real 30 cells a run, makes a task", async () => {
    await setPlan("starter");
    await starterRuns([0.28, 0.28, 0.4, 0.4]);
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
  });

  it("[STORY-063 #14 / AC3] Starter: a step drop whose baseline is a single earlier run still fires once the last two runs both fell", async () => {
    await setPlan("starter");
    await starterRuns([0.28, 0.28, 0.4, undefined]);
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
  });

  it("[STORY-063 #15 / #2] Starter: ONE bad run makes no task, whether it is the newest or the older of the two, though the 14-day aggregate fell 25%", async () => {
    await setPlan("starter");
    await starterRuns([0.2, 0.4, 0.4, 0.4]);
    await generate();
    expect(await taskRows()).toHaveLength(0);
    await reset();
    await starterRuns([0.4, 0.2, 0.4, 0.4]); // it recovered
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #15 / #2] Starter: a window holding a single run is not sustained, however large the fall (there is no shared-baseline path)", async () => {
    await setPlan("starter");
    await starterRuns([0.1, undefined, 0.4, 0.4]); // the only run in the last 14 days
    await generate();
    expect(await taskRows()).toHaveLength(0);
    await reset();
    await starterRuns([0.1, 0.1, 0.4, undefined].map((v, i) => (i === 1 ? undefined : v))); // a lone current run against a lone prior run
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #15 / #2] a window holding ONE run never fires, even when the last three single-run windows held a step drop (the shared-baseline path is gone)", async () => {
    await setPlan("business"); // a 7-day window; the runs are a week apart, so each window holds one
    await metric("chatgpt", day(D, -3), { cells: 60, sov: 0.28 });
    await metric("chatgpt", day(D, -10), { cells: 60, sov: 0.28 });
    await metric("chatgpt", day(D, -17), { cells: 60, sov: 0.4 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #4 / #14] Starter at 29 measured cells a run (one failed prompt): the two-run windows (58 cells) still fire; a one-run window of 29 does not", async () => {
    await setPlan("starter");
    await starterRuns([0.28, 0.28, 0.4, 0.4], 29);
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
    await reset();
    await starterRuns([0.28, 0.28, 0.4, undefined], 29); // the prior window is ONE run of 29 cells: under the floor
    await generate();
    expect(await taskRows()).toHaveLength(0);
    await reset();
    await starterRuns([0.28, undefined, 0.4, 0.4], 29); // the current window is one run of 29 cells
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #4] Starter: the sample floor applies to both 14-day windows (a prior window of one 29-cell run, a current window of two runs of 30)", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -2), { cells: 30, sov: 0.28 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, sov: 0.28 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 29, sov: 0.4 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #16 / #2] Starter: ONE run straddling local midnight (two metric dates) is one bad run and makes NO task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -1), { cells: 15, sov: 0.2, run: "straddler" });
    await metric(STARTER_ENGINE, D, { cells: 15, sov: 0.2, run: "straddler" });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #14] the window comes from the plan's cadence data: Growth compares 14 days (three runs a side, 40 cells each), and a 7-day pair of runs is not enough there", async () => {
    await growthRuns("chatgpt", (k) => ({ cells: 40, sov: k === 0 ? 0.25 : 0.4 }));
    await generate();
    const tasks = await taskRows();
    expect(tasks.map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
    expect(tasks[0].description).toContain("last 14 days against the 14 days before");
    await reset();
    // Runs laid out for 7-day windows (D-1, D-4 and D-8, D-11) all sit in the current 14 days: there is no prior window to compare.
    for (const [offset, sov] of [[1, 0.25], [4, 0.25], [8, 0.4], [11, 0.4]] as const) await metric("chatgpt", day(D, -offset), { cells: 40, sov });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #14] the cadence is per ENGINE and read from data: Gemini on Business runs weekly (`{\"full\":4}`), so it gets the 14-day window while ChatGPT on the same plan keeps 7", async () => {
    await setPlan("business");
    await starterRuns([0.28, 0.28, 0.4, 0.4], 30, "gemini");
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
    expect((await taskRows())[0].description).toContain("last 14 days against the 14 days before");
    await reset();
    await starterRuns([0.2, 0.4, 0.4, 0.4], 30, "gemini"); // one bad weekly run
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #3 / AC3] Growth cadence (14-day windows, three runs a side): all three runs breaching makes a task", async () => {
    await growthRuns("chatgpt", (k) => ({ cells: 40, sov: k === 0 ? 0.25 : 0.4 }));
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
  });

  it("[STORY-063 #2] Growth cadence: one bad run (one of three) makes NO task even though the window aggregate fell 25%", async () => {
    await growthRuns("chatgpt", (k, j) => ({ cells: 40, sov: k === 0 && j === 0 ? 0.1 : 0.4 }));
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #3 / #17] owned citations are per measured CELL: Starter and Growth (14 days each) fire on a real per-cell drop, and one bad Growth run does not", async () => {
    await setPlan("starter");
    for (const [i, offset] of STARTER_RUN_OFFSETS.entries()) await metric(STARTER_ENGINE, day(D, -offset), { cells: 30, sov: 0.4, owned: i < 2 ? 6 : 10 });
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-CITATION-LOSS"]);
    await reset();
    await setPlan("growth");
    await growthRuns("chatgpt", (k) => ({ cells: 40, sov: 0.4, owned: k === 0 ? 8 : 14 })); // 0.2 a cell against 0.35
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-CITATION-LOSS"]);
    await reset();
    await growthRuns("chatgpt", (k, j) => ({ cells: 40, sov: 0.4, owned: k === 0 ? (j === 0 ? 0 : 14) : 14 })); // one bad run: the window fell a third, two runs held
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #3 / #2] Business cadence (daily): a drop over the whole window makes a task; one bad day does not", async () => {
    await setPlan("business");
    await twoWindows("chatgpt", { sov: 0.4 }, { sov: 0.28 });
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
    await reset();
    await twoWindows("chatgpt", { sov: 0.4 }, (i) => ({ sov: i === 0 ? 0 : 0.4 }));
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  // ---- a capture RUN belongs to exactly ONE window (its earliest local capture date) ----------------------------------------------

  it("[STORY-063 #16 / #2] a bad run straddling the boundary between the windows is in ONE window: evaluated 7 days later it does not fire alone (60 cells a run: Business with drift sampling)", async () => {
    await setPlan("business");
    await metric("chatgpt", day(D, -14), { cells: 60, sov: 0.4 });
    await metric("chatgpt", day(D, -7), { cells: 30, sov: 0.2, run: "bad" });
    await metric("chatgpt", day(D, -6), { cells: 30, sov: 0.2, run: "bad" });
    await generate(D); // the next run has not landed: D is not a capture date
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #16 / #2] the same straddling bad run with an extra good run in the prior window: still no task 7 days after it", async () => {
    await setPlan("business");
    await metric("chatgpt", day(D, -14), { cells: 60, sov: 0.4 });
    await metric("chatgpt", day(D, -8), { cells: 60, sov: 0.4 });
    await metric("chatgpt", day(D, -7), { cells: 30, sov: 0.2, run: "bad" });
    await metric("chatgpt", day(D, -6), { cells: 30, sov: 0.2, run: "bad" });
    await generate(D);
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #16 / #2] a run is bucketed by its EARLIEST date: a straddler first seen in the prior window is not a run of the current one", async () => {
    // Two real runs in the current window (D-4, D) fell, plus a straddler (D-7 / D-6) that fell: the current window holds two runs, not three, and both breach.
    await setPlan("business");
    await metric("chatgpt", day(D, -13), { cells: 60, sov: 0.4 });
    await metric("chatgpt", day(D, -4), { cells: 60, sov: 0.2 });
    await metric("chatgpt", D, { cells: 60, sov: 0.2 });
    await metric("chatgpt", day(D, -7), { cells: 30, sov: 0.4, run: "good" });
    await metric("chatgpt", day(D, -6), { cells: 30, sov: 0.4, run: "good" });
    await generate(D);
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
  });

  it("[STORY-063 #16 / #2] a capture RUN is not a date, at a cadence of two runs a 7-day window (Business): a straddling bad run plus one good run is one breaching run of two, so NO task", async () => {
    await setPlan("business");
    await metric("chatgpt", day(D, -4), { cells: 20, sov: 0.4 });
    await metric("chatgpt", day(D, -1), { cells: 10, sov: 0.1, run: "straddler" });
    await metric("chatgpt", D, { cells: 10, sov: 0.1, run: "straddler" });
    await metric("chatgpt", day(D, -11), { cells: 20, sov: 0.4 });
    await metric("chatgpt", day(D, -8), { cells: 20, sov: 0.4 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  // ---- a run breaches from facts that are ITS OWN: a date two runs share is a blend, and breaches for neither -------------------------

  it("[STORY-063 #15 / #2 / R6PROBE A] Starter: a good scheduled run and a BAD manual deep scan on the same local date make NO task (each run is judged on its own cells, and one bad run is one breach)", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -14), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -21), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -7), { parts: [{ run: "scheduled", cells: 30, sov: 0.4 }, { run: "deep-scan", cells: 30, sov: 0.2 }] }); // blends to 0.3
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #15 / #2 / R6PROBE A mirror] Starter: a BAD scheduled run and a good manual deep scan on the same local date make NO task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -14), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -21), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -7), { parts: [{ run: "scheduled", cells: 30, sov: 0.2 }, { run: "deep-scan", cells: 30, sov: 0.4 }] }); // blends to 0.3
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #15 / #2 / REV6-A] Business (7-day window): a scheduled run plus a manual deep scan on one date, one of them bad, make NO task", async () => {
    await setPlan("business");
    await metric("chatgpt", day(D, -11), { cells: 20, sov: 0.4 });
    await metric("chatgpt", day(D, -8), { cells: 20, sov: 0.4 });
    await metric("chatgpt", day(D, -3), { parts: [{ run: "scheduled", cells: 20, sov: 0.2 }, { run: "manual", cells: 20, sov: 0.4 }] });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #15 / #2 / REV6-B] Starter: a scheduled run plus a manual deep scan on one date, one of them bad, make NO task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -2), { parts: [{ run: "scheduled", cells: 30, sov: 0.2 }, { run: "manual", cells: 30, sov: 0.4 }] });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #16 / #2 / REV6-C] Business: ONE bad full run straddling midnight over two daily priority runs makes NO task (three run ids, one bad run)", async () => {
    await setPlan("business");
    for (let i = 0; i <= 13; i += 1) {
      const date = day(D, -i);
      if (i === 4 || i === 3) await metric("chatgpt", date, { parts: [{ run: date, cells: 20, present: 18 }, { run: "full", cells: 10, present: 0 }] }); // the full run's two halves, none present
      else if (i === 10) await metric("chatgpt", date, { parts: [{ run: date, cells: 20, present: 18 }, { run: "full-good", cells: 20, present: 18 }] });
      else await metric("chatgpt", date, { cells: 20, present: 18 });
    }
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #14 / #3 / control] runs that share NO date still fire: a genuine drop in both scheduled runs and a deep scan on a date of its own", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 30, sov: 0.2 });
    await metric(STARTER_ENGINE, day(D, -5), { cells: 30, sov: 0.2, run: "deep-scan" });
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
  });
  it("[STORY-063 #16 / control] Business: genuine daily drops still fire although a full run shares two of the dates (each run is judged on its own cells)", async () => {
    await setPlan("business");
    for (let i = 0; i <= 13; i += 1) {
      const date = day(D, -i);
      const bad = i <= 6;
      if (i === 4 || i === 3) await metric("chatgpt", date, { parts: [{ run: date, cells: 20, present: 8 }, { run: "full", cells: 10, present: 4 }] });
      else await metric("chatgpt", date, { cells: 20, present: bad ? 8 : 18 });
    }
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toContain("TG-PRESENCE-LOSS");
  });

  // ---- a run is judged on ITS OWN cells (round 7): the date is neither the unit of evidence nor a reason to discard it -----------------------

  /** R7C-A / R7C-A mirror: a run's two halves are different prompt subsets, so a half can sit far from the run's rate. The whole run is the unit. */
  for (const [label, head, tail] of [
    ["a small weak head, then the strong rest", { cells: 5, present: 1 }, { cells: 25, present: 14 }],
    ["a strong rest, then a small weak tail", { cells: 25, present: 14 }, { cells: 5, present: 1 }],
  ] as const) {
    it(`[STORY-063 #2 / #16 / R7C-A] Starter: ONE bad run beside a good run that straddles local midnight as ${label} makes NO task (the good run is 15/30, as in the prior window)`, async () => {
      await setPlan("starter");
      await metric(STARTER_ENGINE, day(D, -25), { cells: 30, present: 15 });
      await metric(STARTER_ENGINE, day(D, -17), { cells: 30, present: 15 });
      await metric(STARTER_ENGINE, day(D, -11), { ...head, run: "good" });
      await metric(STARTER_ENGINE, day(D, -10), { ...tail, run: "good" });
      await metric(STARTER_ENGINE, day(D, -2), { cells: 30, present: 8 });
      await generate();
      expect(await taskRows()).toHaveLength(0);
    });
  }
  it("[STORY-063 #16 / R7C-A control] Starter: the same straddling good run on ONE date, and the bad run beside it, also makes no task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 30, present: 8 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #16 / #3] Starter: a run straddling local midnight whose halves have DIFFERENT rates is judged whole, and two such bad runs fire", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -11), { cells: 5, present: 3, run: "a" }); // a strong head ...
    await metric(STARTER_ENGINE, day(D, -10), { cells: 25, present: 5, run: "a" }); // ... a weak rest: 8/30 over the run
    await metric(STARTER_ENGINE, day(D, -2), { cells: 30, present: 8 });
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-PRESENCE-LOSS"]);
  });

  /** Enterprise: hourly priority runs plus a daily full run, so every local date holds 25 runs (migration 0027: `{"full":30,"priority":720}`). */
  async function enterpriseDays(spec: (day: number, run: number) => { present: number; sov: number; cells?: number }): Promise<void> {
    await setPlan("enterprise");
    for (let i = 0; i <= 13; i += 1) {
      const parts: RunPart[] = [];
      for (let k = 0; k < 25; k += 1) parts.push({ run: k === 0 ? `full-${i}` : `h-${i}-${k}`, cells: 50, ...spec(i, k) });
      await metric("chatgpt", day(D, -i), { parts });
    }
  }
  it("[STORY-063 #1 / AC3 / R7PROBE enterprise] Enterprise (hourly priority runs plus a daily full run, 25 runs on every date): a Visibility sustained fall makes TG-SOV-DROP-ENGINE", async () => {
    await enterpriseDays((i) => ({ present: 25, sov: i <= 6 ? 0.2 : 0.4 }));
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toContain("TG-SOV-DROP-ENGINE");
  }, 120_000);
  it("[STORY-063 #1 / AC3 / R7C-B] Enterprise: a presence fall from 90% to 30% makes TG-PRESENCE-LOSS", async () => {
    await enterpriseDays((i) => ({ present: i <= 6 ? 15 : 45, sov: 0.4 }));
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toContain("TG-PRESENCE-LOSS");
  }, 120_000);
  it("[STORY-063 #2 / R7C-B control] Enterprise: TWO huge bad runs among 173 good ones move the week's presence by 29 points but are two runs, not three: NO task", async () => {
    await enterpriseDays((i, k) => (i === 0 && (k === 3 || k === 4) ? { cells: 2000, present: 0, sov: 0.4 } : { present: 45, sov: 0.4 }));
    await generate();
    expect(await taskRows()).toHaveLength(0);
  }, 120_000);
  it("[STORY-063 #1 / AC3 / R7PROBE business] Business: daily runs that each straddle local midnight (every date is shared by two runs) still fire on a sustained fall", async () => {
    await setPlan("business");
    const sovOf = (run: number): number => (run < 7 ? 0.2 : 0.4);
    for (let i = 0; i <= 13; i += 1) {
      // Date D-i holds run i's head and run i+1's tail.
      await metric("chatgpt", day(D, -i), { parts: [{ run: `r${i}`, cells: 10, sov: sovOf(i) }, { run: `r${i + 1}`, cells: 10, sov: sovOf(i + 1) }] });
    }
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toContain("TG-SOV-DROP-ENGINE");
  });
  it("[STORY-063 #2 / #16 / R7PROBE business control] Business: the same midnight-straddling daily runs with TWO bad runs (a 28% fall in the aggregate) make NO task", async () => {
    await setPlan("business");
    for (let i = 0; i <= 13; i += 1) {
      await metric("chatgpt", day(D, -i), { parts: [{ run: `r${i}`, cells: 10, sov: i === 2 || i === 4 ? 0 : 0.4 }, { run: `r${i + 1}`, cells: 10, sov: i + 1 === 2 || i + 1 === 4 ? 0 : 0.4 }] });
    }
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  // ---- round 8: only FINISHED, REPRESENTATIVE runs count, and "sustained" spans DATES ------------------------------------------------
  //
  // The hourly rollup enqueues task.generate while the next run is still being captured, and an outage leaves a run with a handful of
  // measured cells. Neither is a run. A run's sample floor is relative to the run's own size (at least half the cells it planned for
  // the engine) and to the plan's cadence (`ceil(min_n / runs expected in the window)`: 17 cells at Starter, 9 at Growth, 5 at Business).

  it("[STORY-063 #2 / #15 / R8-A] Starter: ONE complete bad run plus the first 3 cells of the next run (still in progress at the hourly rollup) makes NO task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, sov: 0.2 }); // the one bad run
    await metric(STARTER_ENGINE, D, { cells: 3, sov: 0, planned: 30, inProgress: true }); // 3 of 30 cells captured so far
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #2 / #15 / R8-A2] Starter: ONE bad run plus a finished run in which 27 of 30 cells FAILED (3 measured) makes NO task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 30, sov: 0.2 }); // the one bad run
    await metric(STARTER_ENGINE, day(D, -10), { cells: 3, sov: 0.1, planned: 30 }); // an outage run: 3 measured cells
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #2 / #15 / R8-B] Starter presence: ONE bad run plus a 3-cell in-progress fragment makes NO TG-PRESENCE-LOSS", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, present: 27 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, present: 27 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, D, { cells: 3, present: 0, planned: 30, inProgress: true });
    await generate();
    expect(await taskRows("TG-PRESENCE-LOSS")).toHaveLength(0);
  });
  it("[STORY-063 #2 / #15 / R8-C] Growth (14-day window): ONE complete bad run of 40 cells plus a 5-cell in-progress fragment of the next run makes NO task", async () => {
    for (const offset of [24, 20, 16, 12, 8]) await metric("chatgpt", day(D, -offset), { cells: 40, sov: 0.4 });
    await metric("chatgpt", day(D, -4), { cells: 40, sov: 0.2 });
    await metric("chatgpt", D, { cells: 5, sov: 0, planned: 40, inProgress: true });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #2 / R8-control] Starter: the same bad run plus a 2-cell in-progress fragment makes no task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, sov: 0.2 });
    await metric(STARTER_ENGINE, D, { cells: 2, sov: 0, planned: 30, inProgress: true });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #3 / #14 / R8-control] Starter: the same two bad runs fire once the newest run has FINISHED (an in-progress run is neither a run nor a breach, a finished one is both)", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, sov: 0.4 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, sov: 0.2 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 30, sov: 0.2 });
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
  });
  it("[STORY-063 #2 / R8OWN-P1] Starter: one moderately bad full run plus a finished 3-measured-cell remnant (27 cells failed, planned 30) makes NO task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, present: 11 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 3, present: 0 }); // planned defaults to the 3 it wrote: the cadence floor (17) alone rejects it
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #2 / R8OWN-P1b] Starter control: the same bad run plus a 3-cell run that does NOT drop makes NO task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, present: 11 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 3, present: 2 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #4 / #2] Starter: the cadence floor is 15 cells a run (30 over the 2 runs a 14-day window can hold): a 14-cell second run is no run, a 15-cell one is", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, present: 8 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 14, present: 4 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
    await reset();
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, present: 15 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, present: 8 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 15, present: 4 });
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-PRESENCE-LOSS"]);
  });
  it("[STORY-063 #14 / #4 / R9-S1] Starter with 16 prompts: four runs of 16 cells, both current runs drop (15/16 to 6/16), two runs and 32 cells a window, makes a task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 16, present: 15 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 16, present: 15 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 16, present: 6 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 16, present: 6 });
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-PRESENCE-LOSS"]);
  });
  it("[STORY-063 #14 / #4 / R9B-S2] Starter with 15 prompts: both runs drop (14/15 to 9/15), n = 30 a window, makes a task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 15, present: 14 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 15, present: 14 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 15, present: 9 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 15, present: 9 });
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-PRESENCE-LOSS"]);
  });
  it("[STORY-063 #3 / R9B-THRESHOLD] a change EXACTLY at the threshold counts: Starter presence 27/30 to 24/30 in both runs (0.9 - 0.8 is 0.0999... in floating point) makes a task", async () => {
    await setPlan("starter");
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, present: 27 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, present: 27 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, present: 24 });
    await metric(STARTER_ENGINE, day(D, -2), { cells: 30, present: 24 });
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-PRESENCE-LOSS"]);
    await reset();
    await metric(STARTER_ENGINE, day(D, -25), { cells: 30, present: 27 });
    await metric(STARTER_ENGINE, day(D, -17), { cells: 30, present: 27 });
    await metric(STARTER_ENGINE, day(D, -10), { cells: 30, present: 25 }); // 7 points: under it
    await metric(STARTER_ENGINE, day(D, -2), { cells: 30, present: 25 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  /** Business: a bad day is 8 of 20 cells present against 18 of 20; exactly the three most recent days are bad (`sustained_days` is 3). */
  async function businessDays(overrides: Readonly<Record<number, MetricSpec>>): Promise<void> {
    await setPlan("business");
    for (let i = 0; i <= 13; i += 1) await metric("chatgpt", day(D, -i), { cells: 20, present: i <= 2 ? 8 : 18, ...overrides[i] });
  }
  it("[STORY-063 #2 / #4] a run's floor is relative to ITS OWN size: a run that measured under half of what it planned is not a breach (Business: 6 of 20 planned), exactly half is", async () => {
    await businessDays({ 1: { cells: 6, present: 2, planned: 20 } });
    await generate();
    expect(await taskRows()).toHaveLength(0);
    await reset();
    await businessDays({ 1: { cells: 6, present: 2, planned: 12 } }); // 6 >= 12 / 2
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-PRESENCE-LOSS"]);
    await reset();
    await businessDays({ 1: { cells: 6, present: 2, planned: 13 } }); // 6 < 13 / 2
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });
  it("[STORY-063 #2 / #15] Business: a bad run still in progress is neither a run nor a breach: two finished bad runs and an in-progress one make NO task", async () => {
    await businessDays({ 0: { cells: 20, present: 8, inProgress: true } });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #14 / #3] Growth keeps no 7-day window: its 1.87 runs a week make the window 14 days (owner decision 2026-10-19), and a drop in all three recent runs, 40 cells each, fires", async () => {
    for (const offset of [24, 20, 16]) await metric("chatgpt", day(D, -offset), { cells: 40, sov: 0.4 });
    for (const offset of [12, 8, 4]) await metric("chatgpt", day(D, -offset), { cells: 40, sov: 0.25 });
    await generate();
    const tasks = await taskRows();
    expect(tasks.map((t) => t.rule_code)).toEqual(["TG-SOV-DROP-ENGINE"]);
    expect(tasks[0].description).toContain("last 14 days against the 14 days before");
  });
  it("[STORY-063 #2 / #15] Growth (14 days): one bad run of three makes NO task, the newest or the oldest of them", async () => {
    for (const bad of [4, 12]) {
      await reset();
      for (const offset of [24, 20, 16]) await metric("chatgpt", day(D, -offset), { cells: 40, sov: 0.4 });
      for (const offset of [12, 8, 4]) await metric("chatgpt", day(D, -offset), { cells: 40, sov: offset === bad ? 0.05 : 0.4 });
      await generate();
      expect(await taskRows()).toHaveLength(0);
    }
  });

  // Sustained spans DATES. Enterprise holds 25 runs on every local date, so counting runs alone made 3 hours of one day "sustained".
  it("[STORY-063 #2 / #15 / R8OWN-P2] Enterprise: ONE bad day (25 runs) among 14 good days makes NO task", async () => {
    await enterpriseDays((i) => ({ present: i === 3 ? 5 : 45, sov: 0.4 }));
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual([]);
  }, 120_000);
  it("[STORY-063 #2 / #15] Enterprise: TWO bad days make no task either (sustained is three distinct dates), and the same fall over THREE days does", async () => {
    await enterpriseDays((i) => ({ present: i === 1 || i === 2 ? 5 : 45, sov: 0.4 }));
    await generate();
    expect(await taskRows()).toHaveLength(0);
    await reset();
    await enterpriseDays((i) => ({ present: i <= 2 ? 5 : 45, sov: 0.4 }));
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-PRESENCE-LOSS"]);
  }, 240_000);

  // A date is judged on the cells of ALL the runs that start on it, pooled: one noisy hour among 25 cannot make a date count.
  it("[STORY-063 #2 / #15 / R9B-E1b] Enterprise: ONE bad day plus one ordinary 39/50 hour on each of two other days makes NO task", async () => {
    await enterpriseDays((i, k) => ({ present: i === 3 ? 5 : (i === 1 || i === 5) && k === 7 ? 39 : 45, sov: 0.4 }));
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual([]);
  }, 120_000);
  it("[STORY-063 #2 / R9B-E1b control] Enterprise: the same two noisy hours without the bad day make no task", async () => {
    await enterpriseDays((i, k) => ({ present: (i === 1 || i === 5) && k === 7 ? 39 : 45, sov: 0.4 }));
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual([]);
  }, 120_000);
  it("[STORY-063 #2 / #15 / R9-E1] Enterprise: TWO bad days plus one noisy hour on a third date make NO task", async () => {
    await enterpriseDays((i, k) => ({ present: i === 1 || i === 2 ? 5 : i === 5 && k === 7 ? 39 : 45, sov: 0.4 }));
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual([]);
  }, 120_000);

  // ---- a count is per measured CELL: a split or a resized run keeps its rate ---------------------------------------------------------

  it("[STORY-063 #16 / #17] Business (7-day window): a STABLE run straddling midnight plus ONE run with no owned citations makes NO task (halves keep the run's per-cell rate)", async () => {
    await setPlan("business");
    await metric("chatgpt", day(D, -11), { cells: 20, sov: 0.4, owned: 10 });
    await metric("chatgpt", day(D, -8), { cells: 20, sov: 0.4, owned: 10 });
    await metric("chatgpt", day(D, -4), { cells: 10, sov: 0.4, owned: 5, run: "s" });
    await metric("chatgpt", day(D, -3), { cells: 10, sov: 0.4, owned: 5, run: "s" });
    await metric("chatgpt", D, { cells: 20, sov: 0.4, owned: 0 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #17] Business (7-day window): trimming prompts from 40 to 28 with the per-prompt citations unchanged is a configuration edit, not a loss: NO task", async () => {
    await setPlan("business");
    await metric("chatgpt", day(D, -11), { cells: 40, sov: 0.4, owned: 20 });
    await metric("chatgpt", day(D, -8), { cells: 40, sov: 0.4, owned: 20 });
    await metric("chatgpt", day(D, -4), { cells: 28, sov: 0.4, owned: 14 });
    await metric("chatgpt", day(D, -1), { cells: 28, sov: 0.4, owned: 14 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #17] (Business, 7-day window) a count with an extra run in the PRIOR window is not a drop: three prior runs against two current runs at the same per-cell rate", async () => {
    await setPlan("business");
    for (const offset of [12, 10, 8]) await metric("chatgpt", day(D, -offset), { cells: 20, sov: 0.4, owned: 10 });
    for (const offset of [4, 1]) await metric("chatgpt", day(D, -offset), { cells: 20, sov: 0.4, owned: 10 });
    await generate();
    expect(await taskRows()).toHaveLength(0);
  });

  it("[STORY-063 #17] (Business, 7-day window) a count with an extra run in the CURRENT window does not hide a real 40% per-cell drop", async () => {
    await setPlan("business");
    await metric("chatgpt", day(D, -10), { cells: 35, sov: 0.4, owned: 17 });
    for (const offset of [5, 3, 1]) await metric("chatgpt", day(D, -offset), { cells: 35, sov: 0.4, owned: 10 });
    await generate();
    expect((await taskRows()).map((t) => t.rule_code)).toEqual(["TG-CITATION-LOSS"]);
  });

  it("[STORY-063 hazard] a SOFT-DELETED task absorbs nothing, by either key: the finding and the gap are planned again, as the dedupe itself would", async () => {
    await auxFinding("AUX-R-001", "critical");
    await actionable("deleted.example");
    await generate();
    const first = (await taskRows()).filter((t) => t.rule_code === "TG-AUX-R-001" || t.rule_code === "TG-SOURCE-ABSENCE");
    expect(first).toHaveLength(2);
    await db.query("UPDATE tasks SET deleted_at = now() WHERE id = ANY($1::uuid[])", [first.map((t) => t.id)]);
    await db.query("UPDATE task_generation_rules SET cooldown_days = 0");
    await generate();
    const live = (await taskRows()).filter((t) => t.deleted_at === null);
    expect(live.map((t) => t.rule_code).sort()).toEqual(["TG-AUX-R-001", "TG-SOURCE-ABSENCE"]);
  });

  // ---- round 3: a refresh absorbs the event it counted, whatever became of the task afterwards ------------------------------------------

  it("[STORY-063 hazard] a regression refreshed onto its task is not planned AGAIN when the user then completes the task", async () => {
    const finding = await auxFinding("AUX-R-001", "critical");
    await generate(realToday());
    const [task] = await auxTasks("TG-AUX-R-001");
    await db.query("UPDATE tasks SET created_at = now() - interval '2 hours' WHERE id = $1", [task.id]);
    await db.query("UPDATE aux_findings SET status = 'regressed', regressed_at = now() - interval '1 hour' WHERE id = $1", [finding]);
    await generate(realToday()); // refreshes the open task: the regression is counted once
    expect((await auxTasks("TG-AUX-R-001"))[0].recurrence_count).toBe(1);
    await db.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1", [task.id]);
    await generate(realToday());
    await generate(day(realToday(), 1));
    expect(await auxTasks("TG-AUX-R-001")).toHaveLength(1);
  });

  it("[STORY-063 hazard] a gap whose re-verification was refreshed onto its task is not planned AGAIN when the user then completes the task", async () => {
    await verifiedGap("reddit.com", "1 day");
    await generate(realToday());
    const [task] = await taskRows("TG-SOURCE-ABSENCE");
    await db.query("UPDATE tasks SET created_at = now() - interval '40 days' WHERE id = $1", [task.id]);
    await db.query("UPDATE project_source_index SET verified_at = now() - interval '1 hour' WHERE project_id = $1", [projectId]);
    await refreshIndex(realToday());
    await generate(realToday()); // refreshes the open task once
    expect((await taskRows("TG-SOURCE-ABSENCE"))[0].recurrence_count).toBe(1);
    await db.query("UPDATE tasks SET status = 'done', completed_at = now() - interval '35 days' WHERE id = $1", [task.id]);
    await refreshIndex(day(realToday(), 1));
    await generate(day(realToday(), 1));
    expect(await taskRows("TG-SOURCE-ABSENCE")).toHaveLength(1);
  });

  it("[STORY-063 hazard] a discrete event is absorbed through the task's fingerprint when its finding link is gone: the counter does not climb on every run", async () => {
    const finding = await auxFinding("AUX-R-001", "critical");
    await generate(realToday());
    const [task] = await auxTasks("TG-AUX-R-001");
    // The link a SET NULL leaves behind: the task still exists under its fingerprint, but source_finding_id is NULL.
    await db.query("UPDATE tasks SET source_finding_id = NULL, created_at = now() - interval '2 hours' WHERE id = $1", [task.id]);
    await db.query("UPDATE aux_findings SET status = 'regressed', regressed_at = now() - interval '1 hour' WHERE id = $1", [finding]);
    for (const date of [realToday(), realToday(), day(realToday(), 1), day(realToday(), 2)]) await generate(date);
    const after = await auxTasks("TG-AUX-R-001");
    expect(after).toHaveLength(1);
    expect(after[0].recurrence_count).toBe(1);
  });

  it("[STORY-063 hazard] a re-verified gap is absorbed through the task's fingerprint when its domain link is gone: the counter does not climb on every run", async () => {
    await verifiedGap("reddit.com", "1 day");
    await generate(realToday());
    const [task] = await taskRows("TG-SOURCE-ABSENCE");
    await db.query("UPDATE tasks SET source_domain_id = NULL, created_at = now() - interval '40 days' WHERE id = $1", [task.id]);
    await db.query("UPDATE project_source_index SET verified_at = now() - interval '1 hour' WHERE project_id = $1", [projectId]);
    for (let i = 1; i <= 4; i += 1) {
      await refreshIndex(day(realToday(), i));
      await generate(day(realToday(), i));
    }
    const rows = await taskRows("TG-SOURCE-ABSENCE");
    expect(rows).toHaveLength(1);
    expect(rows[0].recurrence_count).toBe(1);
  });

  it("[STORY-063 hazard] a gap that MOVES into critical with no new verification (its context weight rose) is planned, driven by the real index writer", async () => {
    const cite = async (domain: string, n: number, from = 0): Promise<void> => {
      for (let i = from; i < from + n; i += 1) {
        const url = `https://${domain}/p/${String(i)}`;
        await db.query(
          `INSERT INTO citation_facts (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url,
                                       url_hash, domain, is_owned, is_competitor, http_status, position_weight)
           VALUES ($1,$2,$3,$4,'gemini', now() - interval '1 day', 1, $5, $5, $6, $7, false, false, 200, 1)`,
          [workspaceId, projectId, randomUUID(), promptId, url, createHash("sha256").update(url).digest(), domain],
        );
      }
    };
    await cite("reddit.com", 1);
    await cite("other.example", 30); // reddit holds ~3% of the weight: medium, not critical
    await refreshIndex(realToday());
    await db.query(
      `UPDATE project_source_index psi SET brand_present_on_domain = false, verified_at = now() - interval '10 days'
         FROM source_domains sd WHERE sd.id = psi.source_domain_id AND psi.project_id = $1 AND sd.domain = 'reddit.com'`,
      [projectId],
    );
    await refreshIndex(realToday());
    const severity = async () =>
      (await db.query(
        `SELECT psi.gap_severity FROM project_source_index psi JOIN source_domains sd ON sd.id = psi.source_domain_id
          WHERE psi.project_id = $1 AND sd.domain = 'reddit.com' AND psi.engine_key = 'all' AND psi.window_days = 90`,
        [projectId],
      )).rows[0].gap_severity;
    expect(await severity()).not.toBe("critical");
    await generate(realToday());
    expect(await taskRows("TG-SOURCE-ABSENCE")).toHaveLength(0);
    await cite("reddit.com", 40, 1); // no new verification: only the weight moved
    await refreshIndex(realToday());
    expect(await severity()).toBe("critical");
    await generate(realToday());
    expect(await taskRows("TG-SOURCE-ABSENCE")).toHaveLength(1);
    await generate(day(realToday(), 1));
    expect(await taskRows("TG-SOURCE-ABSENCE")).toHaveLength(1);
  });

  it("[STORY-063 hazard] linking a displacement is scoped to its workspace: another workspace's id changes nothing", async () => {
    await auxFinding("AUX-R-001", "critical");
    await generate(realToday());
    const [task] = await auxTasks("TG-AUX-R-001");
    const id = await displacement({ citationGap: [] });
    await linkDisplacementToTask(db, otherWorkspaceId, id, task.id);
    expect((await db.query("SELECT task_id FROM displacement_events WHERE id = $1", [id])).rows[0].task_id).toBeNull();
    await linkDisplacementToTask(db, workspaceId, id, task.id);
    expect((await db.query("SELECT task_id FROM displacement_events WHERE id = $1", [id])).rows[0].task_id).toBe(task.id);
  });

  // ---- the catalog is configuration every tenant trusts ---------------------------------------------------------

  it("[STORY-063 hazard] the runtime roles can only READ the catalog: no UPDATE, INSERT or DELETE under nominara_app or nominara_worker", async () => {
    const grants = (await db.query(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'task_generation_rules' AND table_schema = 'public' AND grantee IN ('nominara_app','nominara_worker')
        ORDER BY grantee, privilege_type`,
    )).rows;
    expect(grants).toEqual([
      { grantee: "nominara_app", privilege_type: "SELECT" },
      { grantee: "nominara_worker", privilege_type: "SELECT" },
    ]);
    for (const role of ["nominara_worker", "nominara_app"]) {
      await db.query(`SET ROLE ${role}`);
      try {
        await expect(db.query("UPDATE task_generation_rules SET title_template = 'phish', enabled = false")).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("DELETE FROM task_generation_rules")).rejects.toMatchObject({ code: "42501" });
        await expect(
          db.query(`INSERT INTO task_generation_rules (code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight, effort_band, rule_version)
                    VALUES ('TG-X','monitoring','t','d','sov_drop','{}'::jsonb,3,0.5,'m','1')`),
        ).rejects.toMatchObject({ code: "42501" });
        expect((await db.query("SELECT count(*)::int AS n FROM task_generation_rules")).rows[0].n).toBeGreaterThan(0);
      } finally {
        await db.query("RESET ROLE");
      }
    }
  });

  it("[STORY-063 hazard] under nominara_worker (production's role) the handler generates for its own workspace", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    const handler = createTaskGenerateHandler(context, { realtime: new NoopRealtimePublisher() });
    await db.query("SET ROLE nominara_worker");
    try {
      const summary = await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => handler(db, job({ metricDate: D })));
      expect(summary).toMatchObject({ created: 1 });
    } finally {
      await db.query("RESET ROLE");
    }
  });

  it("[STORY-063 hazard] under nominara_worker and ANOTHER workspace's context, every evaluator and the baseline read return nothing for this project", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await twoWindows("all", { sov: 0.4, visibility: 40 }, { sov: 0.3, visibility: 40 });
    await actionable("seed.com");
    await displacement({ citationGap: [gapEntry("seed.com")], impact: 90 });
    await auxFinding("AUX-R-001", "critical");
    const rules = (await db.query("SELECT code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight::float8 AS impact_weight, effort_band, opens_alignment, playbook_slug, cooldown_days, NULL::text AS enabled_since_date, enabled_since FROM task_generation_rules WHERE enabled")).rows;
    const ctxFor = (ws: string) => ({ tx: db, workspaceId: ws, projectId, metricDate: D, timezone: "UTC", scoringVersion: SCORING_VERSION });
    const run = async (ws: string) => {
      const out: Record<string, number> = {};
      await withTenantContext(db, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, async () => {
        for (const row of rules) {
          const condition = parseCondition(row);
          if (condition !== undefined) out[row.code] = (await evaluateRule(row, condition, ctxFor(ws))).length;
        }
        out.__baseline = (await captureBaseline(db, projectId, D, "gemini", SCORING_VERSION)).cells_total;
      });
      return out;
    };
    await db.query("SET ROLE nominara_worker");
    let foreign: Record<string, number>;
    let own: Record<string, number>;
    try {
      foreign = await run(otherWorkspaceId);
      own = await run(workspaceId);
    } finally {
      await db.query("RESET ROLE");
    }
    expect(Object.keys(foreign).length).toBeGreaterThan(5);
    for (const [code, n] of Object.entries(foreign)) expect(n, code).toBe(0);
    // The control: the same calls in the owning workspace do see facts, so the zeros above are RLS and not an empty fixture.
    expect(own["TG-SOV-DROP-ENGINE"]).toBe(1);
    expect(own["TG-DISPLACEMENT-RECOVER"]).toBeGreaterThan(0);
    expect(own["TG-AUX-R-001"]).toBe(1);
    expect(own.__baseline).toBeGreaterThan(0);
  });

  // ---- tenancy, observability -----------------------------------------------------------------------------------

  it("[STORY-063 hazard] under nominara_app, another workspace's context generates nothing for this project and reads none of its facts", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await db.query("SET ROLE nominara_app");
    try {
      const summary = await generate(D, otherWorkspaceId);
      expect(summary.created).toBe(0);
    } finally {
      await db.query("RESET ROLE");
    }
    expect(await taskRows()).toHaveLength(0);
    // The same call in the owning workspace, as the app role, generates.
    await db.query("SET ROLE nominara_app");
    try {
      expect((await generate(D, workspaceId)).created).toBeGreaterThan(0);
    } finally {
      await db.query("RESET ROLE");
    }
  });

  it("[STORY-063 hazard] the evaluator builds its SQL from the closed grammar: a threshold that is a SQL fragment never reaches the statement", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await db.query(
      `UPDATE task_generation_rules SET condition = jsonb_set(condition, '{threshold}', '"0.1; DROP TABLE tasks"'::jsonb) WHERE code = 'TG-SOV-DROP-ENGINE'`,
    );
    await generate();
    expect(await taskRows("TG-SOV-DROP-ENGINE")).toHaveLength(0);
    expect((await db.query("SELECT to_regclass('public.tasks') AS t")).rows[0].t).toBe("tasks");
  });

  it("[STORY-063 observability] generation emits a span, a metric and a log line that carries the workspace id and no task text", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    const logs: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(m));
    try {
      await generate();
    } finally {
      spy.mockRestore();
    }
    await provider.forceFlush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain("taskgen.evaluate");
    expect(logs).toContainEqual(expect.objectContaining({ metric: "nominara_taskgen_tasks_total", outcome: "created" }));
    const emitted = JSON.stringify(logs);
    expect(emitted).toContain(workspaceId);
    const [task] = await taskRows("TG-SOV-DROP-ENGINE");
    expect(emitted).not.toContain(task.title);
    await provider.shutdown();
  });
});
