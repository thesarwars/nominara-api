import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { createTaskGenerateHandler } from "../../src/lib/queue/handlers/task-generate.handler.js";
import type { NotifyDispatchPayload } from "../../src/lib/notifications/routing.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-068 — the alert catalog evaluated after each rollup (scoring-models.md §15), end to end through `task.generate`:
// the alerts are raised from the SAME evaluation that generates the tasks (src/lib/taskgen), so the hysteresis —
// a window versus the prior window, a sample floor in both, a day-level sustain — is the generator's own, and the alert
// layer adds its cooldown and its event key. Scenario numbers are STORY-068's Test scenarios table.
//
// The fact fixtures below are COPIED from test/integration/task-generation.spec.ts (STORY-063), which hand-builds the
// windows the generator reads: one bad day, 29 cells, exactly the threshold. Window layout for D = 2026-10-14, 7 days:
// current 2026-10-08..14, prior 2026-10-01..07.
const D = "2026-10-14";
const NEXT = "2026-10-15";

describe("STORY-068 · alert rules raised after each rollup", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let ownerId: string;
  let catalog: unknown[];
  let enqueued: Array<{ workspaceId: string; payload: NotifyDispatchPayload; key: string }>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
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
      "TRUNCATE notification_emails, notification_reads, notifications, tasks, ref_counters, metric_daily, displacement_events, project_source_index, source_domains, aux_findings, aux_audits, answer_captures, tracked_prompts, competitors, projects, workspace_members, users, workspaces CASCADE",
    );
    await db.query("DELETE FROM task_generation_rules");
    await db.query("INSERT INTO task_generation_rules SELECT * FROM jsonb_populate_recordset(NULL::task_generation_rules, $1::jsonb)", [JSON.stringify(catalog)]);
    await db.query("UPDATE task_generation_rules SET enabled_since = NULL");
    runIds = new Map();
    enqueued = [];
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    ownerId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    await db.query("INSERT INTO users (id,email,email_verified_at) VALUES ($1,$2,now())", [ownerId, `o-${ownerId.slice(0, 8)}@example.com`]);
    await db.query("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, ownerId]);
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

  // ---- STORY-068 ------------------------------------------------------------------------------------------------

  const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
  const job = (payload: Record<string, unknown>): Job => ({ id: randomUUID(), data: { payload: { workspaceId, kid: "test-kid", projectId, ...payload } } }) as unknown as Job;
  /** One `task.generate` job for `date`, as the rollup queues it: the alerts ride the same evaluation as the tasks. */
  async function evaluate(date = D): Promise<void> {
    const handler = createTaskGenerateHandler(context, {
      realtime: new NoopRealtimePublisher(),
      enqueueNotify: async (_queue, ws, payload, options) => void enqueued.push({ workspaceId: ws, payload, key: options.idempotencyKey }),
    });
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => handler(db, job({ metricDate: date })));
    await new Promise((resolve) => setImmediate(resolve));
  }
  const alerts = async (kind?: string) =>
    (
      await db.query(
        `SELECT * FROM notifications WHERE kind LIKE 'alert.%' ${kind === undefined ? "" : "AND kind = $1"} ORDER BY created_at, id`,
        kind === undefined ? [] : [kind],
      )
    ).rows;
  const taskOf = async (ruleCode: string) => (await db.query("SELECT id FROM tasks WHERE rule_code = $1 ORDER BY created_at", [ruleCode])).rows;

  it("[STORY-068 #1 / AC1] each rule's condition fires at its documented severity, carrying the task it generated and a link to its surface", async () => {
    // sov_drop_engine: 0.40 -> 0.30 on gemini, n = 35 in both windows (warning, TG-SOV-DROP-ENGINE).
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    // stability_collapse: five unstable priority prompts (info, TG-PROMPT-UNSTABLE).
    for (let i = 0; i < 5; i += 1) {
      await db.query(
        `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status,stability_score)
         VALUES ($1,$2,$3,$4,sha256($4::text::bytea),'recommendation','consideration',true,'active',0.3)`,
        [randomUUID(), workspaceId, projectId, `unstable ${i}`],
      );
    }
    // aux_critical: a new critical crawler-access finding (critical, TG-AUX-R-001).
    const finding = await auxFinding("AUX-R-001", "critical");
    // source_gap_critical: a seedable domain at a critical gap (warning, TG-SOURCE-ABSENCE).
    await actionable("seed.com");
    await evaluate();

    const byKind = new Map((await alerts()).map((n) => [n.kind, n]));
    expect([...byKind.keys()].sort()).toEqual(["alert.aux_critical", "alert.source_gap_critical", "alert.sov_drop_engine", "alert.stability_collapse"]);
    expect(byKind.get("alert.sov_drop_engine")).toMatchObject({ severity: "warning", project_id: projectId, user_id: null });
    expect(byKind.get("alert.stability_collapse")!.severity).toBe("info");
    expect(byKind.get("alert.aux_critical")!.severity).toBe("critical");
    expect(byKind.get("alert.source_gap_critical")!.severity).toBe("warning");
    // The task each alert generated is the task the same evaluation created.
    expect(byKind.get("alert.sov_drop_engine")!.payload.task_id).toBe((await taskOf("TG-SOV-DROP-ENGINE"))[0].id);
    expect(byKind.get("alert.aux_critical")!.payload.task_id).toBe((await taskOf("TG-AUX-R-001"))[0].id);
    // AC13 — the link to the diagnosing surface, filters applied.
    expect(byKind.get("alert.sov_drop_engine")!.payload.deep_link).toEqual({ path: `/p/${projectId}/prompts`, query: { engines: "gemini", sort: "worst", tf: "7d" } });
    expect(byKind.get("alert.aux_critical")!.payload.deep_link).toEqual({ path: `/p/${projectId}/aux`, query: { finding } });
    expect(byKind.get("alert.source_gap_critical")!.payload.deep_link).toEqual({ path: `/p/${projectId}/sources`, query: { playbook: "seed.com" } });
    expect(byKind.get("alert.sov_drop_engine")!.title).toBe("Share of voice dropped on gemini");
  });

  it("[STORY-068 #2 / AC3] a single-sample change raises NO alert: one bad day inside an otherwise flat window", async () => {
    await twoWindows("gemini", { sov: 0.4 }, (i) => ({ sov: i === 0 ? 0 : 0.4 }));
    await evaluate();
    expect(await alerts()).toHaveLength(0);
  });

  it("[STORY-068 #2 / AC3] an insufficient sample (n = 29) raises no alert, however large the drop", async () => {
    await windowOf("gemini", day(D, -7), (i) => ({ sov: 0.4, cells: i === 0 ? 4 : i === 1 ? 0 : 5 })); // 4 + 0 + 5*5 = 29
    await windowOf("gemini", D, { sov: 0.1 }); // 35, a 75% drop
    await evaluate();
    expect(await alerts()).toHaveLength(0);
  });

  it("[STORY-068 #3 / AC3] a sustained change with an adequate sample raises the alert", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await evaluate();
    expect(await alerts("alert.sov_drop_engine")).toHaveLength(1);
  });

  it("[STORY-068 #4 / AC3] the same rule inside its cooldown is suppressed, and raises again once the cooldown has passed", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await evaluate(D);
    await evaluate(NEXT);
    expect(await alerts("alert.sov_drop_engine"), "the next day's evaluation is inside the 7-day cooldown").toHaveLength(1);
    await db.query("UPDATE notifications SET created_at = now() - interval '8 days'");
    await evaluate(NEXT);
    expect(await alerts("alert.sov_drop_engine"), "past the cooldown the still-holding condition alerts again").toHaveLength(2);
  });

  it("[STORY-068 #11 / AC11] a retried task.generate job raises no duplicate alert", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await db.query("UPDATE task_generation_rules SET cooldown_days = 0 WHERE code = 'TG-SOV-DROP-ENGINE'");
    await evaluate(D);
    await evaluate(D);
    await evaluate(D);
    expect(await alerts("alert.sov_drop_engine")).toHaveLength(1);
  });

  it("[STORY-068 #5 / AC4] two high-impact displacements in quick succession BOTH alert, immediately, with a link to each", async () => {
    const a = await displacement({ impact: 80 });
    const b = await displacement({ impact: 72 });
    await evaluate();
    const rows = await alerts("alert.displacement_detected");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.severity)).toEqual(["critical", "critical"]);
    expect(new Set(rows.map((r) => r.payload.deep_link.query.displacement))).toEqual(new Set([a, b]));
    // AC12 — critical is emailed at once: one outbox row per recipient per alert, each enqueued after commit.
    const emails = (await db.query("SELECT * FROM notification_emails WHERE kind = 'immediate' ORDER BY created_at")).rows;
    expect(emails).toHaveLength(2);
    expect(emails.every((e) => e.user_id === ownerId && e.status === "pending")).toBe(true);
    expect(enqueued.map((e) => e.payload)).toEqual(emails.map((e) => ({ kind: "email", emailId: e.id })));
    // A later evaluation (another rollup) does not alert on the same events again.
    await evaluate();
    expect(await alerts("alert.displacement_detected")).toHaveLength(2);
  });

  it("[STORY-068 AC4] the displacement bar is impact >= 60: 59.9 does not alert; a recovered event does not alert", async () => {
    await displacement({ impact: 59.9 });
    await displacement({ impact: 90, recovered: true });
    await evaluate();
    expect(await alerts("alert.displacement_detected")).toHaveLength(0);
  });

  it("[STORY-068 #12 / AC12] a warning alert waits for the digest: no immediate email is recorded or enqueued", async () => {
    await twoWindows("gemini", { sov: 0.4 }, { sov: 0.3 });
    await evaluate();
    const [row] = await alerts("alert.sov_drop_engine");
    expect(row.channels).toEqual(["in_app"]);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_emails")).rows[0].n).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it("[STORY-068 #6 / AC5] nothing in a full evaluation writes an engine_blackout customer notification, even with an engine dark for days", async () => {
    // No captures at all for any engine for the whole window: the blackout is ops' (BlackoutMonitor pages), never a customer alert.
    await displacement({ impact: 80 });
    await evaluate();
    expect((await db.query("SELECT count(*)::int AS n FROM notifications WHERE kind LIKE '%blackout%'")).rows[0].n).toBe(0);
  });

  it("[STORY-068 hazard] a rule that is switched off raises no alert, and its alert does not appear when it is switched back on for the period it was off", async () => {
    await db.query("UPDATE task_generation_rules SET enabled = false WHERE code = 'TG-DISPLACEMENT-RECOVER'");
    await displacement({ impact: 80 });
    await evaluate();
    expect(await alerts("alert.displacement_detected")).toHaveLength(0);
    await db.query("UPDATE task_generation_rules SET enabled = true WHERE code = 'TG-DISPLACEMENT-RECOVER'");
    await evaluate();
    expect(await alerts("alert.displacement_detected"), "an event detected while the rule was off is not alerted").toHaveLength(0);
  });
});
