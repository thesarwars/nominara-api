import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { measuredImpactSchema, MEASURED_IMPACT_CAVEAT } from "../../contracts/tasks/task-verification.schema.js";
import { completeTaskResponseSchema, createTaskRequestSchema } from "../../contracts/tasks/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import type { ScheduledRun } from "../../src/lib/capture/scheduler.js";
import { cancelTaskVerifications, findDueVerifications, verificationHorizons } from "../../src/lib/impact/verification-schedule.js";
import { runVerificationSweep } from "../../src/lib/impact/verification-sweep.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createCapturePlanHandler } from "../../src/lib/queue/handlers/capture-plan.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { reconcileDowngradePause } from "../../src/lib/billing/downgrade-pause.js";
import { softDeleteProject } from "../../src/workers/rollup/retention.js";
import { GrowthMapService } from "../../src/modules/analytics/growth-map.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { TEST_SIGNING_KEYS } from "../support/queue-test-harness.js";

// STORY-067 - the verification scheduler and measured impact, real SQL. One row of the story's test-scenario table per test.
// Tenant write path as `nominara_app`; the sweep as the owner connection (it must see across tenants).
const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.plan")!;
const DAY = 86_400_000;

describe("STORY-067 · verification scheduler and measured impact", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appDb: Client;
  let dispatched: ScheduledRun[];
  let seq = 0;
  const tasks = new TasksService(new NoopRealtimePublisher());
  const originalKey = process.env.GEMINI_API_KEY;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    appDb = new Client({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password });
    await appDb.connect();
  }, 300_000);
  afterAll(async () => {
    await appDb.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE answer_captures, tracked_prompts, project_engines, capture_runs, usage_counters, task_verifications, task_events, tasks, milestones, metric_daily, projects, workspaces CASCADE");
    process.env.GEMINI_API_KEY = "test-key-not-a-secret";
    dispatched = [];
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  });

  async function seed(): Promise<{ ws: string; project: string; actor: string; cluster: string }> {
    seq += 1;
    const ws = randomUUID();
    const project = randomUUID();
    const cluster = randomUUID();
    const actor = (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u${seq}-${randomUUID()}@example.com`])).rows[0]!.id;
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'W',$2,'business')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    await db.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,'manager','active')", [ws, actor]);
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit) VALUES ($1,$2,'P',$3,'https://e.test','e.test',10)`, [project, ws, `p-${randomUUID().slice(0, 8)}`]);
    // Two prompts in the cluster and three outside it.
    for (const [text, inCluster] of [["best crm", true], ["crm pricing", true], ["top crm for startups", false], ["crm reviews", false], ["crm demo", false]] as const) {
      await db.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status, cluster_id)
         VALUES ($1,$2,$3,$4,sha256($5::bytea),'recommendation','consideration',false,'active',$6)`,
        [randomUUID(), ws, project, text, Buffer.from(text), inCluster ? cluster : null],
      );
    }
    return { ws, project, actor, cluster };
  }

  const ctx = (ws: string, actor: string): TenantContext => ({ workspaceId: ws, actorId: actor });
  const inTenant = <T>(context: TenantContext, fn: () => Promise<T>): Promise<T> => withTenantContext(appDb, context, fn);

  /** Creates and completes a task whose cluster is `cluster` (or none). */
  async function completedTask(s: { ws: string; project: string; actor: string }, cluster: string | null) {
    const created = await inTenant(ctx(s.ws, s.actor), () => tasks.createTask(s.project, createTaskRequestSchema.parse({ title: "Ship FAQ" })));
    await db.query("UPDATE tasks SET prompt_cluster_id = $2 WHERE id = $1", [created.id, cluster]);
    const out = await inTenant(ctx(s.ws, s.actor), () => tasks.completeTask(created.id));
    return { taskId: created.id, out, milestoneId: out.milestone!.id, completedAt: new Date(out.milestone!.occurred_at) };
  }

  function processor() {
    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    const handler = createCapturePlanHandler(context, {
      cache: new InMemoryCacheAdapter(),
      dispatch: async (scheduled) => {
        dispatched.push(scheduled);
      },
    });
    return createJobProcessor(ENTRY, { keys: TEST_SIGNING_KEYS, getClient: () => appDb, process: handler });
  }
  function verificationJob(ws: string, project: string, verificationId: string): Job {
    const envelope = signQueueJobPayload({ workspaceId: ws, kid: TEST_SIGNING_KEYS.current.kid, projectId: project, trigger: "verification", verificationId }, TEST_SIGNING_KEYS.current.key);
    return { data: envelope } as unknown as Job;
  }
  const verifications = async (taskId: string) =>
    (await db.query<{ id: string; horizon: string; status: string; due_at: Date; prompt_cluster_id: string | null; cancel_reason: string | null; outcome: string | null; run_id: string | null }>(
      "SELECT id, horizon, status, due_at, prompt_cluster_id, cancel_reason, outcome, run_id FROM task_verifications WHERE task_id = $1 ORDER BY due_at", [taskId])).rows;
  /** Runs one verification through the handler (it must already be due) and lets the after-commit dispatch settle. */
  async function runHandler(s: { ws: string; project: string }, verificationId: string) {
    await processor()(verificationJob(s.ws, s.project, verificationId));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  /** Makes a verification due now, whatever its horizon. */
  const makeDue = (id: string) => db.query("UPDATE task_verifications SET due_at = least(due_at, now() - interval '1 minute') WHERE id = $1", [id]);

  const dayOf = (instant: Date, offset: number) => new Date(instant.getTime() + offset * DAY).toISOString().slice(0, 10);
  /** One metric_daily row per day in [from, to] (offsets from the completion day), `cells` cells and a wobbling score around `centre`. */
  async function scores(project: string, ws: string, completedAt: Date, from: number, to: number, centre: number, cells: number, version = "v1") {
    for (let offset = from; offset <= to; offset += 1) {
      await db.query(
        `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, cells_total, visibility_score, scoring_version)
         VALUES ($1,$2,'all','brand',$2,$3,$4,$5,$6)`,
        [ws, project, dayOf(completedAt, offset), cells, centre + (offset % 2 === 0 ? 1 : -1), version],
      );
    }
  }
  /** Marks the long verification `running` with no run (nothing capturable) so the sweep can settle it. */
  async function readyToSettle(taskId: string) {
    await db.query("UPDATE task_verifications SET status = 'running' WHERE task_id = $1 AND horizon = 'long'", [taskId]);
  }
  const settleAt = (completedAt: Date) => runVerificationSweep(db, undefined, new Date(completedAt.getTime() + 20 * DAY));
  const impactOf = async (milestoneId: string) => (await db.query<{ measured_impact: unknown }>("SELECT measured_impact FROM milestones WHERE id = $1", [milestoneId])).rows[0]!.measured_impact;

  it("[STORY-067 #1][AC1] completing records the completion, pins the milestone and schedules BOTH horizons at the documented defaults", async () => {
    const s = await seed();
    const { taskId, out, milestoneId, completedAt } = await completedTask(s, s.cluster);
    expect(completeTaskResponseSchema.parse(out)).toEqual(out);
    expect((await db.query("SELECT status FROM tasks WHERE id = $1", [taskId])).rows[0].status).toBe("done");
    expect((await db.query("SELECT kind FROM milestones WHERE id = $1", [milestoneId])).rows[0].kind).toBe("task_completed");
    const rows = await verifications(taskId);
    expect(rows.map((r) => [r.horizon, r.status])).toEqual([["short", "pending"], ["long", "pending"]]);
    expect(rows[0]!.due_at.getTime()).toBe(completedAt.getTime() + 48 * 3_600_000);
    expect(rows[1]!.due_at.getTime()).toBe(completedAt.getTime() + 14 * DAY);
    expect(out.verification).toEqual({ at_48h: rows[0]!.due_at.toISOString(), at_14d: rows[1]!.due_at.toISOString() });
  });

  it("[STORY-067 review] a due row in a workspace that cannot capture does not block another tenant's row from the head of the list", async () => {
    const stuck = await seed();
    const ok = await seed();
    await db.query("UPDATE workspaces SET status = 'past_due' WHERE id = $1", [stuck.ws]);
    const t1 = await completedTask(stuck, stuck.cluster);
    const t2 = await completedTask(ok, ok.cluster);
    // The stuck tenant's two rows are the OLDEST due rows, so with LIMIT 2 they are the whole batch unless they are filtered out.
    for (const v of await verifications(t1.taskId)) await db.query("UPDATE task_verifications SET due_at = now() - interval '10 days' WHERE id = $1", [v.id]);
    const okShort = (await verifications(t2.taskId))[0]!;
    await makeDue(okShort.id);
    const refs = await findDueVerifications(db, new Date(), 2);
    expect(refs.map((r) => r.id)).toEqual([okShort.id]);
  });

  it("[STORY-067 review] a fair-use refusal settles the row instead of leaving it pending to dead-letter every hour", async () => {
    const s = await seed();
    const first = await completedTask(s, s.cluster);
    const second = await completedTask(s, s.cluster);
    const firstShort = (await verifications(first.taskId))[0]!;
    await makeDue(firstShort.id);
    await runHandler(s, firstShort.id); // provisions the fair-use counter
    await db.query("UPDATE usage_counters SET used_value = limit_value, reserved_value = 0 WHERE workspace_id = $1 AND metric = 'fair_use_captures'", [s.ws]);
    const secondShort = (await verifications(second.taskId))[0]!;
    await makeDue(secondShort.id);
    await runHandler(s, secondShort.id);
    expect((await verifications(second.taskId))[0]).toMatchObject({ status: "done", outcome: "no_capture", run_id: null });
    expect((await db.query("SELECT 1 FROM capture_runs WHERE project_id = $1", [s.project])).rowCount).toBe(1);
  });

  it("[STORY-067 review] the run row records the cluster it measured (scope_ref)", async () => {
    const s = await seed();
    const { taskId } = await completedTask(s, s.cluster);
    const short = (await verifications(taskId))[0]!;
    await makeDue(short.id);
    await runHandler(s, short.id);
    expect((await db.query("SELECT scope_ref FROM capture_runs WHERE project_id = $1", [s.project])).rows).toEqual([{ scope_ref: s.cluster }]);
  });

  it("[STORY-067 review] windows that mix scoring versions yield NO delta rather than a formula change reported as impact", async () => {
    const s = await seed();
    const { taskId, milestoneId, completedAt } = await completedTask(s, null);
    await scores(s.project, s.ws, completedAt, -14, -1, 20, 40, "v0");
    await scores(s.project, s.ws, completedAt, 1, 14, 40, 40, "v1");
    await readyToSettle(taskId);
    await settleAt(completedAt);
    expect(await impactOf(milestoneId)).toBeNull();
    expect((await verifications(taskId)).find((v) => v.horizon === "long")).toMatchObject({ status: "done", outcome: "insufficient_sample" });
  });

  it("[STORY-067 review] the last window day is not frozen from a partial day: it waits for the closed-day rollup (00:20 local)", async () => {
    const s = await seed();
    const { taskId, milestoneId, completedAt } = await completedTask(s, null);
    await scores(s.project, s.ws, completedAt, -14, -1, 10, 40);
    await scores(s.project, s.ws, completedAt, 1, 14, 70, 40);
    await readyToSettle(taskId);
    const nextDay = dayOf(completedAt, 15);
    await runVerificationSweep(db, undefined, new Date(`${nextDay}T00:10:00Z`));
    expect(await impactOf(milestoneId)).toBeNull();
    expect((await verifications(taskId)).find((v) => v.horizon === "long")!.status).toBe("running");
    // The closed-day rollup rewrites the last day at 00:20; a sweep after it may settle, one before it may not.
    await db.query("UPDATE metric_daily SET computed_at = $2 WHERE project_id = $1 AND metric_date = $3", [s.project, new Date(`${nextDay}T00:25:00Z`), dayOf(completedAt, 14)]);
    await runVerificationSweep(db, undefined, new Date(`${nextDay}T00:30:00Z`));
    expect(await impactOf(milestoneId)).not.toBeNull();
  });

  it("[STORY-067 review] a different milestone at the very same instant still counts as nearby; only the seeded sibling is excluded", async () => {
    const s = await seed();
    const { taskId, milestoneId, completedAt } = await completedTask(s, null);
    await scores(s.project, s.ws, completedAt, -14, -1, 10, 40);
    await scores(s.project, s.ws, completedAt, 1, 14, 70, 40);
    for (let i = 0; i < 2; i += 1) await db.query(`INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title) VALUES ($1,$2,$3,'deployment','Deploy')`, [s.ws, s.project, completedAt]);
    await readyToSettle(taskId);
    await settleAt(completedAt);
    const impact = measuredImpactSchema.parse(await impactOf(milestoneId));
    expect(impact.other_milestones_nearby).toBe(2);
    expect(impact.confidence).toBe("low");
  });

  it("[STORY-067 AC10 review] a downgrade pause cancels the paused project's pending rows at once, and only that project's", async () => {
    const s = await seed();
    await db.query("UPDATE workspaces SET plan_key = 'starter' WHERE id = $1", [s.ws]);
    const other = randomUUID();
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit, created_at) VALUES ($1,$2,'Newer',$3,'https://n.test','n.test',10, now() + interval '1 hour')`, [other, s.ws, `p-${randomUUID().slice(0, 8)}`]);
    const kept = await completedTask(s, s.cluster);
    const created = await inTenant(ctx(s.ws, s.actor), () => tasks.createTask(other, createTaskRequestSchema.parse({ title: "Other" })));
    await inTenant(ctx(s.ws, s.actor), () => tasks.completeTask(created.id));
    await inTenant(ctx(s.ws, s.actor), () => reconcileDowngradePause(appDb, s.ws));
    expect((await verifications(created.id)).map((v) => [v.status, v.cancel_reason])).toEqual([["canceled", "project_paused"], ["canceled", "project_paused"]]);
    expect((await verifications(kept.taskId)).map((v) => v.status)).toEqual(["pending", "pending"]);
  });

  it("[STORY-067 AC10 review] deleting a project cancels its pending rows at once", async () => {
    const s = await seed();
    const { taskId } = await completedTask(s, s.cluster);
    await softDeleteProject(appDb, s.ws, s.project, s.actor);
    expect((await verifications(taskId)).map((v) => [v.status, v.cancel_reason])).toEqual([["canceled", "project_deleted"], ["canceled", "project_deleted"]]);
  });

  it("[STORY-067 #12][AC11] the completion event is on the timeline with the actor", async () => {
    const s = await seed();
    const { taskId } = await completedTask(s, s.cluster);
    const ev = (await db.query("SELECT event, actor_id FROM task_events WHERE task_id = $1 AND event = 'completed'", [taskId])).rows;
    expect(ev).toEqual([{ event: "completed", actor_id: s.actor }]);
  });

  it("[STORY-067 AC12] the horizons are configurable, default to the documented values, and a bad value is refused", () => {
    expect(verificationHorizons({})).toEqual({ shortMs: 48 * 3_600_000, longMs: 14 * DAY });
    expect(verificationHorizons({ TASK_VERIFICATION_SHORT_HOURS: "24", TASK_VERIFICATION_LONG_DAYS: "7" })).toEqual({ shortMs: 24 * 3_600_000, longMs: 7 * DAY });
    expect(() => verificationHorizons({ TASK_VERIFICATION_SHORT_HOURS: "0" })).toThrow();
    expect(() => verificationHorizons({ TASK_VERIFICATION_SHORT_HOURS: "48.5" })).toThrow();
    expect(() => verificationHorizons({ TASK_VERIFICATION_SHORT_HOURS: "500", TASK_VERIFICATION_LONG_DAYS: "7" })).toThrow();
  });

  it("[STORY-067 #2][AC2] a verification run has its OWN trigger and charges nothing", async () => {
    const s = await seed();
    const { taskId } = await completedTask(s, s.cluster);
    const short = (await verifications(taskId))[0]!;
    await makeDue(short.id);
    await runHandler(s, short.id);
    const runs = (await db.query("SELECT trigger, prompt_scope, status FROM capture_runs WHERE project_id = $1", [s.project])).rows;
    expect(runs).toEqual([{ trigger: "verification", prompt_scope: "cluster", status: "queued" }]);
    expect((await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [s.ws])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM usage_ledger WHERE workspace_id = $1 AND credits_charged <> 0", [s.ws])).rowCount).toBe(0);
    const after = (await verifications(taskId))[0]!;
    expect(after.status).toBe("running");
    expect(after.run_id).not.toBeNull();
    // It did not touch the project's schedule.
    expect((await db.query("SELECT next_run_at FROM projects WHERE id = $1", [s.project])).rows[0].next_run_at).toBeNull();
  });

  it("[STORY-067 #3][AC3] it is scoped to the affected cluster, not the whole project", async () => {
    const s = await seed();
    const { taskId } = await completedTask(s, s.cluster);
    const short = (await verifications(taskId))[0]!;
    await makeDue(short.id);
    await runHandler(s, short.id);
    expect(dispatched).toHaveLength(1);
    const promptIds = new Set(dispatched[0]!.plan.cells.map((cell) => cell.promptId));
    expect(promptIds.size).toBe(2);
    const inCluster = (await db.query<{ id: string }>("SELECT id FROM tracked_prompts WHERE project_id = $1 AND cluster_id = $2", [s.project, s.cluster])).rows.map((r) => r.id);
    expect([...promptIds].sort()).toEqual(inCluster.sort());
  });

  it("[STORY-067 #3][AC3] a task with no cluster captures nothing rather than falling back to the whole project", async () => {
    const s = await seed();
    const { taskId } = await completedTask(s, null);
    const short = (await verifications(taskId))[0]!;
    await makeDue(short.id);
    await runHandler(s, short.id);
    expect(dispatched).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM capture_runs WHERE project_id = $1", [s.project])).rowCount).toBe(0);
    expect((await verifications(taskId))[0]).toMatchObject({ status: "done", outcome: "no_capture" });
  });

  it("[STORY-067 #4][AC4] at the later horizon the before-and-after means are computed over aligned windows and written onto the milestone", async () => {
    const s = await seed();
    const { taskId, milestoneId, completedAt } = await completedTask(s, null);
    await scores(s.project, s.ws, completedAt, -14, -1, 20, 40);
    await scores(s.project, s.ws, completedAt, 1, 14, 40, 40);
    // Outside both windows: must not move either mean.
    await scores(s.project, s.ws, completedAt, -20, -15, 90, 40);
    await readyToSettle(taskId);
    await settleAt(completedAt);
    const impact = measuredImpactSchema.parse(await impactOf(milestoneId));
    expect(impact).toMatchObject({ window_days: 14, visibility_before: 20, visibility_after_14d: 40, delta: 20, n_before: 560, n_after: 560, scoring_version: "v1" });
    expect((await verifications(taskId)).find((v) => v.horizon === "long")).toMatchObject({ status: "done", outcome: "measured" });
  });

  it("[STORY-067 #5][AC5] another milestone inside the window makes confidence LOW whatever the delta looks like", async () => {
    const s = await seed();
    const { taskId, milestoneId, completedAt } = await completedTask(s, null);
    await scores(s.project, s.ws, completedAt, -14, -1, 10, 40);
    await scores(s.project, s.ws, completedAt, 1, 14, 70, 40); // a huge, perfectly clean separation
    for (const offset of [-3, 5]) {
      await db.query(`INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title) VALUES ($1,$2,$3,'deployment','Deploy')`, [s.ws, s.project, new Date(completedAt.getTime() + offset * DAY)]);
    }
    await readyToSettle(taskId);
    await settleAt(completedAt);
    const impact = measuredImpactSchema.parse(await impactOf(milestoneId));
    expect(impact.delta).toBe(60);
    expect(impact.confidence).toBe("low");
    expect(impact.other_milestones_nearby).toBe(2);
  });

  it("[STORY-067 #6] an isolated milestone with a clear separation gets higher confidence", async () => {
    const s = await seed();
    const { taskId, milestoneId, completedAt } = await completedTask(s, null);
    await scores(s.project, s.ws, completedAt, -14, -1, 10, 40);
    await scores(s.project, s.ws, completedAt, 1, 14, 70, 40);
    await readyToSettle(taskId);
    await settleAt(completedAt);
    expect(measuredImpactSchema.parse(await impactOf(milestoneId)).confidence).toBe("high");
  });

  it("[STORY-067 #7][AC7] an insufficient sample either side yields NO delta", async () => {
    for (const thin of ["before", "after"] as const) {
      const s = await seed();
      const { taskId, milestoneId, completedAt } = await completedTask(s, null);
      await scores(s.project, s.ws, completedAt, -14, -1, 10, thin === "before" ? 2 : 40); // 28 cells
      await scores(s.project, s.ws, completedAt, 1, 14, 70, thin === "after" ? 2 : 40);
      await readyToSettle(taskId);
      await settleAt(completedAt);
      expect(await impactOf(milestoneId), thin).toBeNull();
      expect((await verifications(taskId)).find((v) => v.horizon === "long")).toMatchObject({ status: "done", outcome: "insufficient_sample" });
    }
  });

  it("[STORY-067 AC4] nothing is computed until the after-window has closed", async () => {
    const s = await seed();
    const { taskId, milestoneId, completedAt } = await completedTask(s, null);
    await scores(s.project, s.ws, completedAt, -14, -1, 10, 40);
    await scores(s.project, s.ws, completedAt, 1, 14, 70, 40);
    await readyToSettle(taskId);
    await runVerificationSweep(db, undefined, new Date(completedAt.getTime() + 14 * DAY));
    expect(await impactOf(milestoneId)).toBeNull();
    expect((await verifications(taskId)).find((v) => v.horizon === "long")!.status).toBe("running");
  });

  it("[STORY-067 #8][AC8] the growth map and the task list read the IDENTICAL figure, and #9 both carry the caveat", async () => {
    const s = await seed();
    const { taskId, milestoneId, completedAt } = await completedTask(s, null);
    await scores(s.project, s.ws, completedAt, -14, -1, 10, 40);
    await scores(s.project, s.ws, completedAt, 1, 14, 70, 40);
    await readyToSettle(taskId);
    await settleAt(completedAt);
    const stored = measuredImpactSchema.parse(await impactOf(milestoneId));
    const map = await withTenantContext(db, ctx(s.ws, s.actor), () => new GrowthMapService().growthMap(s.project, { timeframe: "30d", granularity: "day" }));
    const fromMap = map.milestones.find((m) => m.milestone_id === milestoneId)!.measured_impact!;
    const list = await withTenantContext(db, ctx(s.ws, s.actor), () => tasks.portalTasks(s.project, { hideCompetitors: false, completedSince: null }));
    const fromList = list.completed[0]!.measured_impact as Record<string, unknown>;
    expect(fromMap).toMatchObject({ delta: stored.delta, confidence: stored.confidence, window_days: stored.window_days });
    expect(fromList).toEqual(stored);
    expect(fromMap.caveat).toBe(MEASURED_IMPACT_CAVEAT);
    expect(fromList["caveat"]).toBe(MEASURED_IMPACT_CAVEAT);
  });

  it("[STORY-067 #10][AC9] reopening the task before the horizon cancels its pending verification", async () => {
    const s = await seed();
    const { taskId } = await completedTask(s, s.cluster);
    expect(await inTenant(ctx(s.ws, s.actor), () => cancelTaskVerifications(appDb, { taskId }, "task_reopened"))).toBe(2);
    expect((await verifications(taskId)).map((v) => [v.status, v.cancel_reason])).toEqual([["canceled", "task_reopened"], ["canceled", "task_reopened"]]);
  });

  it("[STORY-067 #10][AC9] a task no longer done is cancelled by the handler, not measured", async () => {
    const s = await seed();
    const { taskId } = await completedTask(s, s.cluster);
    await db.query("UPDATE tasks SET status = 'todo' WHERE id = $1", [taskId]);
    const short = (await verifications(taskId))[0]!;
    await makeDue(short.id);
    await runHandler(s, short.id);
    expect((await verifications(taskId))[0]).toMatchObject({ status: "canceled", cancel_reason: "task_reopened" });
    expect(dispatched).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM capture_runs WHERE project_id = $1", [s.project])).rowCount).toBe(0);
  });

  it("[STORY-067 #11][AC10] pausing the project cancels cleanly: no run, no orphan job", async () => {
    const s = await seed();
    const { taskId } = await completedTask(s, s.cluster);
    const short = (await verifications(taskId))[0]!;
    await makeDue(short.id);
    await db.query("UPDATE projects SET status = 'paused' WHERE id = $1", [s.project]);
    await runHandler(s, short.id);
    expect((await verifications(taskId))[0]).toMatchObject({ status: "canceled", cancel_reason: "project_paused" });
    expect(dispatched).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM capture_runs WHERE project_id = $1", [s.project])).rowCount).toBe(0);
  });

  it("[STORY-067 #11][AC10] cancelling by project (a pause or delete) cancels every pending row, and a settled one is left alone", async () => {
    const s = await seed();
    const a = await completedTask(s, s.cluster);
    const b = await completedTask(s, s.cluster);
    await db.query("UPDATE task_verifications SET status = 'done', outcome = 'captured' WHERE task_id = $1 AND horizon = 'short'", [a.taskId]);
    expect(await inTenant(ctx(s.ws, s.actor), () => cancelTaskVerifications(appDb, { projectId: s.project }, "project_deleted"))).toBe(3);
    expect((await verifications(a.taskId)).map((v) => v.status)).toEqual(["done", "canceled"]);
    expect((await verifications(b.taskId)).map((v) => v.status)).toEqual(["canceled", "canceled"]);
  });

  it("[STORY-067 AC2] a duplicate delivery of a verification job plans one run", async () => {
    const s = await seed();
    const { taskId } = await completedTask(s, s.cluster);
    const short = (await verifications(taskId))[0]!;
    await makeDue(short.id);
    await runHandler(s, short.id);
    await runHandler(s, short.id);
    expect((await db.query("SELECT 1 FROM capture_runs WHERE project_id = $1", [s.project])).rowCount).toBe(1);
    expect(dispatched).toHaveLength(1);
  });

  it("[STORY-067 AC1] the sweep enqueues only what is due, once per row, and never another tenant's", async () => {
    const a = await seed();
    const b = await seed();
    const ta = await completedTask(a, a.cluster);
    await completedTask(b, b.cluster);
    await makeDue((await verifications(ta.taskId))[0]!.id);
    const sent: { workspaceId: string; verificationId: string; idempotencyKey: string }[] = [];
    const result = await runVerificationSweep(db, async (job) => { sent.push(job); }, new Date());
    expect(result).toMatchObject({ due: 1, enqueued: 1, failed: 0 });
    expect(sent).toEqual([{ workspaceId: a.ws, projectId: a.project, verificationId: (await verifications(ta.taskId))[0]!.id, idempotencyKey: `verification:${(await verifications(ta.taskId))[0]!.id}` }]);
  });

  it("[STORY-067] RLS: a verification row is invisible to another tenant", async () => {
    const a = await seed();
    const b = await seed();
    await completedTask(a, a.cluster);
    const seen = await inTenant(ctx(b.ws, b.actor), async () => (await appDb.query("SELECT 1 FROM task_verifications")).rowCount);
    expect(seen).toBe(0);
  });
});
