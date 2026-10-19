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
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { authorityTaskFingerprint } from "../../src/lib/analytics/displacement-recovery.js";
import { DisplacementService } from "../../src/modules/displacement/displacement.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import type { Job } from "bullmq";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import { createTaskGenerateHandler } from "../../src/lib/queue/handlers/task-generate.handler.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

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
  }

  async function metric(engine: string, date: string, spec: MetricSpec = {}): Promise<void> {
    const cells = spec.cells ?? 5;
    const present = spec.present ?? cells;
    const entity = spec.entity ?? "brand";
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
        spec.sov ?? 0.4, spec.mentions ?? 0, spec.negative ?? 0, spec.owned ?? 0, spec.visibility ?? 50,
      ],
    );
  }

  /** Seven days ending `end`, one row a day. */
  async function windowOf(engine: string, end: string, spec: MetricSpec | ((i: number) => MetricSpec)): Promise<void> {
    for (let i = 0; i < 7; i += 1) await metric(engine, day(end, -i), typeof spec === "function" ? spec(i) : spec);
  }

  /** A prior window at `prior` and a current window at `current` for one engine, ending at D. */
  async function twoWindows(engine: string, prior: MetricSpec | ((i: number) => MetricSpec), current: MetricSpec | ((i: number) => MetricSpec)): Promise<void> {
    await windowOf(engine, day(D, -7), prior);
    await windowOf(engine, D, current);
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
      `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, gap_severity)
       VALUES ($1,$2,$3,'all','2026-07-16',90,$4)`,
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
    for (const code of ["TG-RENDER-SCHEMA", "TG-ENTITY-NODE", "TG-DIVERGENCE", "TG-TOPIC-CONTENT"]) expect((await rule(code)).enabled, code).toBe(false);
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
    await twoWindows("chatgpt", { present: 5 }, { present: 4 });
    // TG-CITATION-LOSS: owned citations 40 -> 20 (50% down, >= 25%) on a third; presence/sov flat.
    await twoWindows("claude", { owned: 4 }, { owned: 2 });
    // TG-SENTIMENT-NEGATIVE: negative mention rate 0.02 -> 0.10 (>= 0.05 and up >= 0.03) on a fourth.
    await twoWindows("perplexity", { mentions: 100, negative: 2 }, { mentions: 100, negative: 10 });
    const summary = await generate();
    expect(summary.created).toBeGreaterThanOrEqual(4);
    const byRule = new Map((await taskRows()).map((t) => [t.rule_code, t]));
    expect(byRule.get("TG-SOV-DROP-ENGINE")!.affected_engines).toEqual(["gemini"]);
    expect(byRule.get("TG-PRESENCE-LOSS")!.affected_engines).toEqual(["chatgpt"]);
    expect(byRule.get("TG-CITATION-LOSS")!.affected_engines).toEqual(["claude"]);
    expect(byRule.get("TG-SENTIMENT-NEGATIVE")!.affected_engines).toEqual(["perplexity"]);
    // The unmoved engines made nothing: sov flat on chatgpt/claude/perplexity (0.4 -> 0.4).
    expect((await taskRows("TG-SOV-DROP-ENGINE")).length).toBe(1);
  });

  it("[STORY-063 #1] TG-SOV-DROP-GLOBAL needs the same drop across >= 3 engines; two engines make only the per-engine tasks", async () => {
    for (const engine of ["gemini", "chatgpt"]) await twoWindows(engine, { sov: 0.4 }, { sov: 0.3 });
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
    await twoWindows("chatgpt", { sov: 0.4 }, { sov: 0.3 });
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
    await twoWindows("chatgpt", { present: 5 }, { present: 4 });
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
    // Completion does not touch it either (STORY-064), and nothing here writes completion_metrics.
    expect(later.completion_metrics).toBeNull();
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
    await db.query("UPDATE task_generation_rules SET enabled = true WHERE code IN ('TG-TOPIC-CONTENT','TG-DIVERGENCE','TG-ENTITY-NODE','TG-RENDER-SCHEMA')");
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
    expect(calls).toEqual([{ ws: workspaceId, payload: { projectId, metricDate: D }, key: `taskgen:${projectId}:${D}:rollup-job-1` }]);
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
