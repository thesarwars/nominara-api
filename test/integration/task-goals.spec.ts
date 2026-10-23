import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../../src/api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../src/tenancy/errors.js";
import { GoalsService } from "../../src/modules/tasks/goals.service.js";
import type { Job } from "bullmq";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { refreshProjectGoals } from "../../src/lib/rollup/refresh-project-goals.js";
import { currentTenantStore, withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { createGoalRequestSchema, updateGoalRequestSchema } from "../../contracts/tasks/index.js";

const steps = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("../../src/lib/rollup/refresh-project-goals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/rollup/refresh-project-goals.js")>();
  return { ...actual, refreshProjectGoals: (...args: Parameters<typeof actual.refreshProjectGoals>) => { steps.order.push("goals"); return actual.refreshProjectGoals(...args); } };
});
vi.mock("../../src/lib/rollup/refresh-project-geo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/rollup/refresh-project-geo.js")>();
  return { ...actual, refreshProjectGeoWindows: (...args: Parameters<typeof actual.refreshProjectGeoWindows>) => { steps.order.push("geo"); return actual.refreshProjectGeoWindows(...args); } };
});
vi.mock("../../src/lib/rollup/refresh-project-source-index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/rollup/refresh-project-source-index.js")>();
  return { ...actual, refreshProjectSourceIndex: (...args: Parameters<typeof actual.refreshProjectSourceIndex>) => { steps.order.push("source_index"); return actual.refreshProjectSourceIndex(...args); } };
});

// STORY-065-A — goals: baseline captured at creation, progress as
// baseline/current/target, sample state, abandon. Real SQL as `nominara_app`
// (RLS in force). Tenant write path: dangerous area.
describe("STORY-065-A · goals — real SQL", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;
  const service = new GoalsService();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
  }, 120_000);
  afterAll(async () => { await container.stop(); });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client);
    seq = 0;
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(resolvePassword(role, {}))}`);
    }
  });
  afterEach(async () => { await client.end(); });

  async function inTenant<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
    const app = new Client({
      host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(),
      user: "nominara_app", password: resolvePassword("nominara_app", {}),
    });
    await app.connect();
    try { return await withTenantContext(app, context, fn); } finally { await app.end(); }
  }
  async function createWorkspace(): Promise<string> {
    seq += 1;
    const r = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'business') RETURNING id", [`Workspace ${seq}`, `workspace-${seq}-${randomUUID()}`]);
    return r.rows[0]!.id;
  }
  async function createUser(workspaceId: string): Promise<string> {
    seq += 1;
    const u = await client.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u${seq}-${randomUUID()}@example.com`]);
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'manager', 'active')", [workspaceId, u.rows[0]!.id]);
    return u.rows[0]!.id;
  }
  async function createProject(workspaceId: string, blended: number | null = 42.5, cells: number | null = 120): Promise<string> {
    seq += 1;
    const r = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, visibility_blended, cells_30d)
       VALUES ($1, $2, $3, 'https://example.com', $4, $5, $6) RETURNING id`,
      [workspaceId, `Project ${seq}`, `project-${seq}`, `example-${seq}.com`, blended, cells]);
    return r.rows[0]!.id;
  }
  async function createCluster(workspaceId: string, projectId: string, score: number | null = 31.25, label = "CRM"): Promise<string> {
    const r = await client.query<{ id: string }>(
      `INSERT INTO topic_clusters (workspace_id, project_id, label, visibility_score) VALUES ($1, $2, $3, $4) RETURNING id`, [workspaceId, projectId, label, score]);
    return r.rows[0]!.id;
  }
  const CTX = (workspaceId: string, actorId: string, scope?: readonly string[]): TenantContext => ({
    workspaceId, actorId, ...(scope !== undefined ? { scopeProjectIds: scope } : {}),
  });
  const engineGoal = (extra: Record<string, unknown> = {}) =>
    createGoalRequestSchema.parse({ title: "Lift visibility", kind: "engine_score", target: { metric: "visibility_score", target_value: 60 }, ...extra });
  const create = (ctx: TenantContext, projectId: string, body = engineGoal()) => inTenant(ctx, () => service.createGoal(projectId, body));
  const list = (ctx: TenantContext, projectId: string) => inTenant(ctx, async () => (await service.listGoals(projectId, { limit: 200 })).items);
  const abandon = (ctx: TenantContext, projectId: string, goalId: string) =>
    inTenant(ctx, () => service.updateGoal(projectId, goalId, updateGoalRequestSchema.parse({ status: "abandoned" })));

  it("[STORY-065 #1] an engine_score goal captures its baseline at creation from projects.visibility_blended (with n), and current starts equal to it", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 120);
    const goal = await create(CTX(ws, actor), p);
    expect(goal.kind).toBe("engine_score");
    expect(goal.baseline).toMatchObject({ value: 42.5, cells: 120 });
    expect(goal.current).toMatchObject({ value: 42.5, cells: 120 });
    expect(goal.status).toBe("active");
    // A later change to the live metric does not move the captured before.
    await client.query("UPDATE projects SET visibility_blended = 55 WHERE id = $1", [p]);
    expect((await list(CTX(ws, actor), p))[0]!.baseline).toMatchObject({ value: 42.5 });
  });

  it("[STORY-065 #1] a topic_authority goal captures its baseline from topic_clusters.visibility_score", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const c = await createCluster(ws, p, 31.25);
    const goal = await create(CTX(ws, actor), p, createGoalRequestSchema.parse({
      title: "Own CRM", kind: "topic_authority", target: { metric: "visibility_score", target_value: 50, prompt_cluster_id: c } }));
    expect(goal.baseline).toMatchObject({ value: 31.25 });
    expect(goal.target).toMatchObject({ target_value: 50, prompt_cluster_id: c });
  });

  it("[STORY-065 #9] a topic_authority goal never borrows the project's cell count: project n=500 with a cluster value is cells=null and sample_state=insufficient", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 500);
    const c = await createCluster(ws, p, 31.25);
    const goal = await create(CTX(ws, actor), p, createGoalRequestSchema.parse({
      title: "Own CRM", kind: "topic_authority", target: { metric: "visibility_score", target_value: 50, prompt_cluster_id: c } }));
    expect(goal.baseline).toMatchObject({ value: 31.25, cells: null });
    expect(goal.current).toMatchObject({ value: 31.25, cells: null });
    expect(goal.sample_state).toBe("insufficient");
    expect(goal.progress_pct).toBeNull();
  });

  it("[STORY-065 #1] topic_authority baseline fix: the baseline is the CLUSTER's score, never the project's — an unscored cluster under a measured project (42.5 / n=500) is value=null, insufficient, and a cluster scored higher than the project keeps its own number", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 500);
    const unscored = await createCluster(ws, p, null, "Unscored");
    const scored = await createCluster(ws, p, 77.5, "Scored");
    const mk = (c: string) => createGoalRequestSchema.parse({ title: "Own CRM", kind: "topic_authority", target: { metric: "visibility_score", target_value: 90, prompt_cluster_id: c } });
    const a = await create(CTX(ws, actor), p, mk(unscored));
    expect(a.baseline).toMatchObject({ value: null, cells: null });
    expect(a.current).toMatchObject({ value: null, cells: null });
    expect(a.sample_state).toBe("insufficient");
    expect(a.progress_pct).toBeNull();
    const b = await create(CTX(ws, actor), p, mk(scored));
    expect(b.baseline).toMatchObject({ value: 77.5, cells: null });
    // The engine_score goal on the same project still reads the project's own figure.
    const e = await create(CTX(ws, actor), p);
    expect(e.baseline).toMatchObject({ value: 42.5, cells: 500 });
  });

  it("[STORY-065 #1] a cluster of another project, a foreign tenant's cluster and an unknown cluster are refused (400), never a goal with a made-up baseline", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws); const q = await createProject(ws);
    const other = await createWorkspace(); const otherP = await createProject(other);
    const body = (c: string) => createGoalRequestSchema.parse({ title: "t", kind: "topic_authority", target: { metric: "visibility_score", target_value: 50, prompt_cluster_id: c } });
    await expect(create(CTX(ws, actor), p, body(await createCluster(ws, q)))).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(create(CTX(ws, actor), p, body(await createCluster(other, otherP)))).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(create(CTX(ws, actor), p, body(randomUUID()))).rejects.toBeInstanceOf(ValidationFailedError);
    expect((await client.query("SELECT 1 FROM goals")).rowCount).toBe(0);
  });

  it("[STORY-065 #3] a read carries baseline, current and target (all three) plus the task counts", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const goal = await create(CTX(ws, actor), p);
    await client.query(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, origin, dedupe_fingerprint, title, description, goal_id, status)
       VALUES ($1, $2, 'PRO-1', 'content', 'manual', '\\x01', 'a', '', $3, 'done'), ($1, $2, 'PRO-2', 'content', 'manual', '\\x02', 'b', '', $3, 'todo')`, [ws, p, goal.id]);
    const [read] = await list(CTX(ws, actor), p);
    expect(read!.baseline).not.toBeNull();
    expect(read!.current).not.toBeNull();
    expect(read!.target.target_value).toBe(60);
    expect(read!.tasks_total).toBe(2);
    expect(read!.tasks_done).toBe(1);
  });

  it("[STORY-065 #9] under-sampled (n=29), unmeasured (null) and unknown-n metrics show sample_state=insufficient and a null progress_pct, never a number", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws);
    for (const [blended, cells] of [[42.5, 29], [null, 120], [42.5, null]] as const) {
      const p = await createProject(ws, blended, cells);
      const goal = await create(CTX(ws, actor), p);
      expect(goal.sample_state, `${blended}/${cells}`).toBe("insufficient");
      expect(goal.progress_pct, `${blended}/${cells}`).toBeNull();
    }
  });

  it("[STORY-065 #9] the boundary n=30 is sufficient (scoring-models.md: low only when n < 30) and progress_pct is a number", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 30);
    const goal = await create(CTX(ws, actor), p);
    expect(goal.sample_state).toBe("sufficient");
    expect(goal.progress_pct).toBe(0);
  });

  it("[STORY-065 #12] reading twice recomputes nothing: a live metric change and the row's updated_at are untouched by reads", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    await create(CTX(ws, actor), p);
    const before = (await client.query("SELECT current, progress_pct, updated_at FROM goals")).rows[0];
    await client.query("UPDATE projects SET visibility_blended = 99, cells_30d = 500 WHERE id = $1", [p]);
    const first = await list(CTX(ws, actor), p);
    const second = await list(CTX(ws, actor), p);
    expect(second).toEqual(first);
    expect(first[0]!.current).toMatchObject({ value: 42.5 });
    expect((await client.query("SELECT current, progress_pct, updated_at FROM goals")).rows[0]).toEqual(before);
  });

  it("[STORY-065 #7] abandoning needs no reason, sets status=abandoned, and a second abandon is a 409 (an abandoned goal is retained)", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const goal = await create(CTX(ws, actor), p);
    const out = await abandon(CTX(ws, actor), p, goal.id);
    expect(out.status).toBe("abandoned");
    expect((await client.query("SELECT status FROM goals WHERE id = $1", [goal.id])).rows[0]!.status).toBe("abandoned");
    await expect(abandon(CTX(ws, actor), p, goal.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("an achieved goal cannot be abandoned (409) — it is a record", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const goal = await create(CTX(ws, actor), p);
    await client.query("UPDATE goals SET status = 'achieved', achieved_at = now() WHERE id = $1", [goal.id]);
    await expect(abandon(CTX(ws, actor), p, goal.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("[STORY-065 #7] 20 concurrent abandons of one goal: exactly one succeeds, the rest are ConflictError(current_state=abandoned), and the abandoned metric moves once (FOR UPDATE)", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const goal = await create(CTX(ws, actor), p);
    const spy = vi.spyOn(Logger.prototype, "log");
    try {
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => abandon(CTX(ws, actor), p, goal.id)));
      const ok = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(rejected).toHaveLength(19);
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(ConflictError);
        expect((r.reason as { details: unknown }).details).toMatchObject({ current_state: "abandoned" });
      }
      const abandonedMetric = spy.mock.calls.filter(([m]) => (m as { metric?: string } | undefined)?.metric === "nominara_goals_abandoned_total");
      expect(abandonedMetric).toHaveLength(1);
    } finally { spy.mockRestore(); }
  }, 60_000);

  it("[STORY-065 #8] two goals on one project both persist and both list", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    await create(CTX(ws, actor), p, engineGoal({ title: "one" }));
    await create(CTX(ws, actor), p, engineGoal({ title: "two" }));
    expect((await list(CTX(ws, actor), p)).map((g) => g.title).sort()).toEqual(["one", "two"]);
  });

  it("tenancy: another tenant's project is a 404 on list/create/abandon, a foreign goal cannot be abandoned, an out-of-scope project is the scope 403", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws); const q = await createProject(ws);
    const other = await createWorkspace(); const otherActor = await createUser(other);
    const goal = await create(CTX(ws, actor), p);
    await expect(list(CTX(other, otherActor), p)).rejects.toBeInstanceOf(NotFoundError);
    await expect(create(CTX(other, otherActor), p)).rejects.toBeInstanceOf(NotFoundError);
    await expect(abandon(CTX(other, otherActor), p, goal.id)).rejects.toBeInstanceOf(NotFoundError);
    // The goal belongs to p: addressing it through another project of the same tenant is also a 404.
    await expect(abandon(CTX(ws, actor), q, goal.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(list(CTX(ws, actor, [p]), q)).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect((await client.query("SELECT status FROM goals WHERE id = $1", [goal.id])).rows[0]!.status).toBe("active");
  });

  it("[STORY-065 soft-delete] a soft-deleted project's goals are a 404 on list, create and abandon, and nothing is written or changed", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const goal = await create(CTX(ws, actor), p);
    const before = (await client.query("SELECT updated_at, status FROM goals WHERE id = $1", [goal.id])).rows[0]!;
    await client.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [p]);
    await expect(list(CTX(ws, actor), p)).rejects.toBeInstanceOf(NotFoundError);
    await expect(create(CTX(ws, actor), p, engineGoal({ title: "after delete" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(abandon(CTX(ws, actor), p, goal.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await client.query("SELECT count(*)::int AS n FROM goals WHERE project_id = $1", [p])).rows[0]!.n).toBe(1);
    const after = (await client.query("SELECT updated_at, status FROM goals WHERE id = $1", [goal.id])).rows[0]!;
    expect(after.status).toBe("active");
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it("[STORY-065 #10] deleting the project cascades its goals", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    await create(CTX(ws, actor), p);
    await client.query("DELETE FROM projects WHERE id = $1", [p]);
    expect((await client.query("SELECT 1 FROM goals")).rowCount).toBe(0);
  });

  it("[STORY-065 #11] unlinking a task (clearing goal_id) leaves the task", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const goal = await create(CTX(ws, actor), p);
    await client.query(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, origin, dedupe_fingerprint, title, description, goal_id)
       VALUES ($1, $2, 'PRO-1', 'content', 'manual', '\\x01', 'a', '', $3)`, [ws, p, goal.id]);
    await client.query("UPDATE tasks SET goal_id = NULL WHERE project_id = $1", [p]);
    expect((await client.query("SELECT 1 FROM tasks")).rowCount).toBe(1);
  });

  it("[decision 2026-10-09 pm #3] listProjectGoals is cursor-paginated: a page boundary neither skips nor repeats, and the last page has no cursor", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    for (const t of ["a", "b", "c", "d", "e"]) await create(CTX(ws, actor), p, engineGoal({ title: t }));
    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const page = await inTenant(CTX(ws, actor), () => service.listGoals(p, { limit: 2, ...(cursor === undefined ? {} : { cursor }) }));
      expect(page.items).toBeDefined();
      sizes.push(page.items.length);
      seen.push(...page.items.map((g) => g.title));
      expect(page.pagination.has_more).toBe(page.pagination.cursor_next !== null);
      if (page.pagination.cursor_next === null) break;
      cursor = page.pagination.cursor_next;
    }
    expect(sizes).toEqual([2, 2, 1]);
    expect(seen.slice().sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(new Set(seen).size).toBe(5);
  });

  it("[decision 2026-10-09 pm #3] a foreign or malformed cursor is a validation failure, not a silent first page", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    await create(CTX(ws, actor), p, engineGoal({ title: "a" }));
    await expect(inTenant(CTX(ws, actor), () => service.listGoals(p, { limit: 2, cursor: "bm90LWEtY3Vyc29y" }))).rejects.toBeInstanceOf(ValidationFailedError);
  });
  // ---- STORY-065 AC1/AC2/AC6/AC11 — six kinds, the rollup refresh, achievement ------------------------------

  async function metricDay(ws: string, p: string, engine: string, date: string, o: Partial<{ cells: number; visibility: number; citationShare: number; rendering: number | null; sentiment: number | null; mentions: number }> = {}): Promise<void> {
    const { cells = 20, visibility = 50, citationShare = 0.2, rendering = null, sentiment = null, mentions = 0 } = o;
    await client.query(
      `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, cells_total, visibility_score, citation_share, rendering_quality, sentiment_score, mentions_total, scoring_version)
       VALUES ($1, $2, $3, 'brand', $2, $4::date, $5, $6, $7, $8, $9, $10, 'v1')`,
      [ws, p, engine, date, cells, visibility, citationShare, rendering, sentiment, mentions]);
  }
  async function trackedPrompt(ws: string, p: string, cluster: string | null, o: { deleted?: boolean } = {}): Promise<string> {
    seq += 1;
    const r = await client.query<{ id: string }>(
      `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, cluster_id, deleted_at)
       VALUES ($1, $2, $3, $4, 'recommendation', 'decision', $5, $6) RETURNING id`,
      [ws, p, `prompt ${seq}`, createHash("sha256").update(`p-${seq}-${randomUUID()}`).digest(), cluster, o.deleted ? new Date() : null]);
    return r.rows[0]!.id;
  }
  async function stability(ws: string, prompt: string, engine: string, windowStart: string, presence: number, samples: number): Promise<void> {
    await client.query(
      `INSERT INTO prompt_stability (workspace_id, prompt_id, engine_key, window_start, sample_count, presence_rate, sov_median, sov_iqr, entity_set_jsd)
       VALUES ($1, $2, $3, $4::date, $5, $6, 0, 0, 0)`, [ws, prompt, engine, windowStart, samples, presence]);
  }
  const kindGoal = (kind: string, metric: string, targetValue: number, extra: Record<string, unknown> = {}) =>
    createGoalRequestSchema.parse({ title: `${kind} goal`, kind, target: { metric, target_value: targetValue, ...extra } });
  const storedTarget = async (goalId: string) =>
    (await client.query<{ target: Record<string, unknown> }>("SELECT target FROM goals WHERE id = $1", [goalId])).rows[0]!.target;
  const refresh = (ctx: TenantContext, projectId: string) => inTenant(ctx, () => refreshProjectGoals(currentTenantStore()!.client, projectId));
  const row = async (goalId: string) =>
    (await client.query<{ status: string; achieved_at: Date | null; progress_pct: string; current: { value: number | null; cells: number | null; at: string } | null; updated_at: Date }>(
      "SELECT status, achieved_at, progress_pct, current, updated_at FROM goals WHERE id = $1", [goalId])).rows[0]!;

  describe("[STORY-065 #1] a goal of each kind captures its baseline at creation, from that kind's own metric", () => {
    it("citation_presence reads the cross-engine citation_share (a fraction, stated as a percentage) and the 30-day cell count", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
      await metricDay(ws, p, "all", "2026-09-26", { citationShare: 0.1, cells: 20 });
      await metricDay(ws, p, "all", "2026-09-27", { citationShare: 0.42, cells: 20 });
      await metricDay(ws, p, "gemini", "2026-09-27", { citationShare: 0.9, cells: 500 });
      const goal = await create(CTX(ws, actor), p, kindGoal("citation_presence", "citation_share", 60));
      expect(goal.baseline).toMatchObject({ value: 42, cells: 40 });
      expect(goal.current).toMatchObject({ value: 42, cells: 40 });
      expect(goal.target).toMatchObject({ metric: "citation_share", target_value: 60 });
    });

    it("an engine scope reads THAT engine's rows only, never the cross-engine blend or another engine", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 120);
      await metricDay(ws, p, "gemini", "2026-09-27", { visibility: 71.25, cells: 35 });
      await metricDay(ws, p, "gemini", "2026-09-26", { visibility: 10, cells: 5 });
      await metricDay(ws, p, "chatgpt", "2026-09-27", { visibility: 5, cells: 500 });
      const scoped = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 90, { engine_key: "gemini" }));
      expect(scoped.baseline).toMatchObject({ value: 71.25, cells: 40 });
      expect(scoped.target).toMatchObject({ engine_key: "gemini" });
      // an engine with no rows is unmeasured (null), never the project's figure
      const none = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 90, { engine_key: "google_ai_mode" }));
      expect(none.baseline).toMatchObject({ value: null, cells: null });
      expect(none.sample_state).toBe("insufficient");
      expect(none.progress_pct).toBeNull();
    });

    it("an unknown engine_key is a 400, never a goal on nothing", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
      await expect(create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 90, { engine_key: "nosuchengine" }))).rejects.toBeInstanceOf(ValidationFailedError);
      expect((await client.query("SELECT 1 FROM goals")).rowCount).toBe(0);
    });

    it("rendering_quality reads projects.rendering_quality with the ATTRIBUTE-CAPABLE engines' cells, not the project's whole n", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 500);
      await client.query("UPDATE projects SET rendering_quality = 61.5 WHERE id = $1", [p]);
      await metricDay(ws, p, "google_ai_mode", "2026-09-27", { cells: 40, rendering: 61.5 });
      await metricDay(ws, p, "chatgpt", "2026-09-27", { cells: 460 });
      const goal = await create(CTX(ws, actor), p, kindGoal("rendering_quality", "rendering_quality", 80));
      expect(goal.baseline).toMatchObject({ value: 61.5, cells: 40 });
      expect(goal.sample_state).toBe("sufficient");
    });

    it("sentiment_recovery reads the cross-engine day's sentiment with the MENTIONS behind it, never the cell count; no mentions reads as insufficient (never 50, never 0)", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 800);
      await metricDay(ws, p, "all", "2026-09-27", { cells: 800, sentiment: 35, mentions: 80 });
      const measured = await create(CTX(ws, actor), p, kindGoal("sentiment_recovery", "sentiment_score", 60));
      expect(measured.baseline).toMatchObject({ value: 35, cells: 80 });
      await client.query("DELETE FROM metric_daily WHERE project_id = $1", [p]);
      await metricDay(ws, p, "all", "2026-09-27", { cells: 800, sentiment: null, mentions: 0 });
      const unmeasured = await create(CTX(ws, actor), p, kindGoal("sentiment_recovery", "sentiment_score", 60));
      expect(unmeasured.baseline).toMatchObject({ value: null });
      expect(unmeasured.sample_state).toBe("insufficient");
      expect(unmeasured.progress_pct).toBeNull();
    });

    it("[STORY-065 #9] sentiment n is the mentions, not the cells: cells_30d=1200 with 4 mentions on the value's day is insufficient, project-wide and per engine, and 30 mentions is sufficient", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 1200);
      await metricDay(ws, p, "all", "2026-09-27", { cells: 40, sentiment: 80, mentions: 4 });
      await metricDay(ws, p, "all", "2026-09-26", { cells: 1160, sentiment: 10, mentions: 400 });
      await metricDay(ws, p, "gemini", "2026-09-27", { cells: 900, sentiment: 80, mentions: 4 });
      const wide = await create(CTX(ws, actor), p, kindGoal("sentiment_recovery", "sentiment_score", 60));
      expect(wide.baseline).toMatchObject({ value: 80, cells: 4 });
      expect(wide.sample_state).toBe("insufficient");
      const scoped = await create(CTX(ws, actor), p, kindGoal("sentiment_recovery", "sentiment_score", 90, { engine_key: "gemini" }));
      expect(scoped.baseline).toMatchObject({ value: 80, cells: 4 });
      expect(scoped.sample_state).toBe("insufficient");
      await client.query("UPDATE metric_daily SET mentions_total = 30 WHERE project_id = $1 AND metric_date = '2026-09-27' AND engine_key = 'all'", [p]);
      expect((await create(CTX(ws, actor), p, kindGoal("sentiment_recovery", "sentiment_score", 95))).sample_state).toBe("sufficient");
    });

    it("prompt_recommendation reads the presence rate of the cluster's prompts: latest window per prompt and engine, weighted by sample count, as a percentage", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
      const c = await createCluster(ws, p);
      const [p1, p2] = [await trackedPrompt(ws, p, c), await trackedPrompt(ws, p, c)];
      const outside = await trackedPrompt(ws, p, null); const gone = await trackedPrompt(ws, p, c, { deleted: true });
      await stability(ws, p1, "gemini", "2026-09-28", 0.5, 20);
      await stability(ws, p1, "gemini", "2026-09-21", 1, 20); // an older window: superseded
      await stability(ws, p2, "gemini", "2026-09-28", 0.25, 20);
      await stability(ws, p2, "chatgpt", "2026-09-28", 0.75, 10);
      await stability(ws, outside, "gemini", "2026-09-28", 1, 100);
      await stability(ws, gone, "gemini", "2026-09-28", 1, 100);
      const all = await create(CTX(ws, actor), p, kindGoal("prompt_recommendation", "presence_rate", 80, { prompt_cluster_id: c }));
      expect(all.baseline).toMatchObject({ value: 45, cells: 50 });
      const one = await create(CTX(ws, actor), p, kindGoal("prompt_recommendation", "presence_rate", 80, { prompt_cluster_id: c, engine_key: "gemini" }));
      expect(one.baseline).toMatchObject({ value: 37.5, cells: 40 });
    });

    it("prompt_recommendation on an empty or unmeasured cluster is value=null, insufficient; a foreign or unknown cluster is a 400", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws); const q = await createProject(ws);
      const c = await createCluster(ws, p);
      const goal = await create(CTX(ws, actor), p, kindGoal("prompt_recommendation", "presence_rate", 80, { prompt_cluster_id: c }));
      expect(goal.baseline).toMatchObject({ value: null, cells: null });
      expect(goal.sample_state).toBe("insufficient");
      const other = await createCluster(ws, q, 10, "Other");
      await expect(create(CTX(ws, actor), p, kindGoal("prompt_recommendation", "presence_rate", 80, { prompt_cluster_id: other }))).rejects.toBeInstanceOf(ValidationFailedError);
      await expect(create(CTX(ws, actor), p, kindGoal("prompt_recommendation", "presence_rate", 80, { prompt_cluster_id: randomUUID() }))).rejects.toBeInstanceOf(ValidationFailedError);
    });
  });

  describe("direction is fixed per metric (every goal metric is higher-is-better) and a target at or below a measured baseline is refused", () => {
    it("stores direction up for every metric, and refuses a target at or below a measured, sufficient baseline (nothing is inserted)", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 120);
      const up = await create(CTX(ws, actor), p, engineGoal());
      expect(await storedTarget(up.id)).toMatchObject({ direction: "up", metric: "visibility_score", target_value: 60 });
      for (const target of [30, 42.5]) {
        await expect(create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", target))).rejects.toBeInstanceOf(ValidationFailedError);
      }
      expect((await client.query("SELECT 1 FROM goals")).rowCount).toBe(1);
    });

    it("an unmeasured or under-sampled baseline cannot say the target is behind it, so the goal is created (direction up)", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws);
      const unmeasured = await create(CTX(ws, actor), await createProject(ws, null, null), engineGoal());
      expect(await storedTarget(unmeasured.id)).toMatchObject({ direction: "up" });
      const noisy = await create(CTX(ws, actor), await createProject(ws, 60, 29), kindGoal("engine_score", "visibility_score", 40));
      expect(await storedTarget(noisy.id)).toMatchObject({ direction: "up" });
      const boundary = await createProject(ws, 60, 30);
      await expect(create(CTX(ws, actor), boundary, kindGoal("engine_score", "visibility_score", 40))).rejects.toBeInstanceOf(ValidationFailedError);
    });
  });

  describe("[STORY-065 #2] the rollup step refreshes current and progress; a read never does", () => {
    it("moves current to the live metric, computes progress between baseline and target, and leaves a goal under n=30 as its sample state", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await client.query("UPDATE projects SET visibility_blended = 50, cells_30d = 150 WHERE id = $1", [p]);
      expect(await refresh(CTX(ws, actor), p)).toMatchObject({ refreshed: 1, achieved: [] });
      const stored = await row(goal.id);
      expect(stored.current).toMatchObject({ value: 50, cells: 150 });
      expect(Number(stored.progress_pct)).toBe(50);
      const [read] = await list(CTX(ws, actor), p);
      expect(read!.current).toMatchObject({ value: 50, cells: 150 });
      expect(read!.baseline).toMatchObject({ value: 40, cells: 100 });
      expect(read!.progress_pct).toBe(50);
      expect(read!.sample_state).toBe("sufficient");
      // under-sampled: current is refreshed (the customer sees the n), progress is not a number
      await client.query("UPDATE projects SET visibility_blended = 55, cells_30d = 29 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      const thin = (await list(CTX(ws, actor), p))[0]!;
      expect(thin.current).toMatchObject({ value: 55, cells: 29 });
      expect(thin.sample_state).toBe("insufficient");
      expect(thin.progress_pct).toBeNull();
    });

    it("progress is clamped to 0..100: a regression below the baseline is 0, never negative", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await client.query("UPDATE projects SET visibility_blended = 30 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      expect(Number((await row(goal.id)).progress_pct)).toBe(0);
    });

    it("a goal whose baseline was unmeasured shows no progress percentage (nothing to measure from), until it is achieved", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, null, null);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await client.query("UPDATE projects SET visibility_blended = 50, cells_30d = 100 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      const read = (await list(CTX(ws, actor), p))[0]!;
      expect(read.current).toMatchObject({ value: 50, cells: 100 });
      expect(read.sample_state).toBe("sufficient");
      expect(read.progress_pct).toBeNull();
      expect(read.status).toBe("active");
      await client.query("UPDATE projects SET visibility_blended = 61 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      const done = (await list(CTX(ws, actor), p))[0]!;
      expect(done.status).toBe("achieved");
      expect(done.progress_pct).toBe(100);
      expect(goal.id).toBe(done.id);
    });

    it("[STORY-065 #12] reading twice without a refresh recomputes nothing, even after the live metric moved", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await refresh(CTX(ws, actor), p);
      const before = await row(goal.id);
      await client.query("UPDATE projects SET visibility_blended = 99, cells_30d = 900 WHERE id = $1", [p]);
      const a = await list(CTX(ws, actor), p); const b = await list(CTX(ws, actor), p);
      expect(b).toEqual(a);
      expect(await row(goal.id)).toEqual(before);
    });

    it("an abandoned goal is not refreshed, and a project with no goals is a no-op", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100); const empty = await createProject(ws);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await abandon(CTX(ws, actor), p, goal.id);
      const before = await row(goal.id);
      await client.query("UPDATE projects SET visibility_blended = 99, cells_30d = 900 WHERE id = $1", [p]);
      expect(await refresh(CTX(ws, actor), p)).toMatchObject({ refreshed: 0, achieved: [] });
      expect(await row(goal.id)).toEqual(before);
      expect(await refresh(CTX(ws, actor), empty)).toMatchObject({ refreshed: 0, achieved: [] });
    });

    it("refreshes every kind from its own source in one pass (citation share and prompt presence)", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const c = await createCluster(ws, p); const pr = await trackedPrompt(ws, p, c);
      await metricDay(ws, p, "all", "2026-09-27", { citationShare: 0.2, cells: 40 });
      const cit = await create(CTX(ws, actor), p, kindGoal("citation_presence", "citation_share", 60));
      const rec = await create(CTX(ws, actor), p, kindGoal("prompt_recommendation", "presence_rate", 90, { prompt_cluster_id: c }));
      await metricDay(ws, p, "all", "2026-09-28", { citationShare: 0.3, cells: 40 });
      await stability(ws, pr, "gemini", "2026-09-28", 0.5, 40);
      await refresh(CTX(ws, actor), p);
      expect((await row(cit.id)).current).toMatchObject({ value: 30, cells: 80 });
      expect((await row(rec.id)).current).toMatchObject({ value: 50, cells: 40 });
    });
  });

  describe("[STORY-065 #6] reaching the target sets achieved and achieved_at, in the rollup step only, and the goal is retained", () => {
    it("observability: a span, the refreshed and achieved counters, and a log line carrying IDs and counts only (never the title)", async () => {
      const exporter = new InMemorySpanExporter();
      trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const goal = await create(CTX(ws, actor), p, createGoalRequestSchema.parse({ title: "SECRET GOAL TITLE", kind: "engine_score", target: { metric: "visibility_score", target_value: 60 } }));
      await client.query("UPDATE projects SET visibility_blended = 61 WHERE id = $1", [p]);
      const spy = vi.spyOn(Logger.prototype, "log");
      try {
        await refresh(CTX(ws, actor), p);
        const logged = JSON.stringify(spy.mock.calls);
        expect(logged).toContain("nominara_goals_refreshed_total");
        expect(logged).toContain("nominara_goals_achieved_total");
        expect(logged).toContain("goals.refresh.run");
        expect(logged).toContain(p);
        expect(logged).not.toContain("SECRET GOAL TITLE");
      } finally { spy.mockRestore(); }
      const span = exporter.getFinishedSpans().find((x) => x.name === "goals.refresh");
      expect(span).toBeDefined();
      expect(span!.attributes["nominara.goals_refresh.achieved"]).toBe(1);
      expect(goal.id).toBeDefined();
    });

    it("achieves at the target exactly (inclusive), stamps achieved_at, retains the goal, and writes a system-actor audit row", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      expect((await row(goal.id)).status).toBe("active");
      await client.query("UPDATE projects SET visibility_blended = 60 WHERE id = $1", [p]);
      expect(await refresh(CTX(ws, actor), p)).toMatchObject({ refreshed: 1, achieved: [goal.id] });
      const stored = await row(goal.id);
      expect(stored.status).toBe("achieved");
      expect(stored.achieved_at).not.toBeNull();
      expect(Number(stored.progress_pct)).toBe(100);
      const [read] = await list(CTX(ws, actor), p);
      expect(read).toMatchObject({ id: goal.id, status: "achieved", progress_pct: 100 });
      expect(read!.achieved_at).not.toBeNull();
      const audit = (await client.query<{ actor_type: string; actor_id: string | null; action: string; resource_type: string; resource_id: string; workspace_id: string; after_state: Record<string, unknown> }>(
        "SELECT actor_type, actor_id, action, resource_type, resource_id, workspace_id, after_state FROM audit_log WHERE action = 'goal.achieved'")).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_type: "system", action: "goal.achieved", resource_type: "goal", resource_id: goal.id, workspace_id: ws });
      expect(audit[0]!.after_state).toMatchObject({ status: "achieved" });
      expect(JSON.stringify(audit[0]!.after_state)).not.toContain(goal.title);
    });

    it("a value just short of the target is not achieved", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await client.query("UPDATE projects SET visibility_blended = 59.999 WHERE id = $1", [p]);
      expect(await refresh(CTX(ws, actor), p)).toMatchObject({ achieved: [] });
      expect((await row(goal.id)).status).toBe("active");
    });

    it("an under-sampled value past the target is NOT achieved (no achievement on precision theatre), and neither is an unmeasured one", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await client.query("UPDATE projects SET visibility_blended = 95, cells_30d = 29 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      expect((await row(goal.id)).status).toBe("active");
      await client.query("UPDATE projects SET visibility_blended = NULL, cells_30d = 500 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      expect((await row(goal.id)).status).toBe("active");
      await client.query("UPDATE projects SET visibility_blended = 95, cells_30d = 30 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      expect((await row(goal.id)).status).toBe("achieved");
    });

    it("[STORY-065 #6/#9] a sentiment goal is NOT achieved (no audit row) on a few mentions when the cell count is large, project-wide or per engine; it is once the mentions are sufficient", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 1200);
      await metricDay(ws, p, "all", "2026-09-27", { cells: 1200, sentiment: 30, mentions: 100 });
      await metricDay(ws, p, "gemini", "2026-09-27", { cells: 1200, sentiment: 30, mentions: 100 });
      const wide = await create(CTX(ws, actor), p, kindGoal("sentiment_recovery", "sentiment_score", 60));
      const scoped = await create(CTX(ws, actor), p, kindGoal("sentiment_recovery", "sentiment_score", 60, { engine_key: "gemini" }));
      await client.query("UPDATE projects SET sentiment_score = 90, cells_30d = 1200 WHERE id = $1", [p]);
      await client.query("UPDATE metric_daily SET sentiment_score = 90, mentions_total = 4 WHERE project_id = $1 AND metric_date = '2026-09-27'", [p]);
      expect(await refresh(CTX(ws, actor), p)).toMatchObject({ refreshed: 2, achieved: [] });
      expect((await row(wide.id)).status).toBe("active");
      expect((await row(scoped.id)).status).toBe("active");
      expect((await row(wide.id)).current).toMatchObject({ value: 90, cells: 4 });
      expect((await client.query("SELECT 1 FROM audit_log WHERE action = 'goal.achieved'")).rowCount).toBe(0);
      await client.query("UPDATE metric_daily SET mentions_total = 30 WHERE project_id = $1 AND metric_date = '2026-09-27'", [p]);
      expect((await refresh(CTX(ws, actor), p)).achieved).toHaveLength(2);
    });

    it("a regression is never recorded as achieved: a metric that gets worse than the baseline stays active at 0% progress, with no achieved_at and no audit row", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 60, 100);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 80));
      for (const worse of [59, 40, 0]) {
        await client.query("UPDATE projects SET visibility_blended = $2 WHERE id = $1", [p, worse]);
        expect(await refresh(CTX(ws, actor), p)).toMatchObject({ refreshed: 1, achieved: [] });
      }
      const after = await row(goal.id);
      expect(after.status).toBe("active");
      expect(after.achieved_at).toBeNull();
      expect(Number(after.progress_pct)).toBe(0);
      expect((await client.query("SELECT 1 FROM audit_log WHERE action = 'goal.achieved'")).rowCount).toBe(0);
    });

    it("a goal created on an under-sampled baseline already above its target is achieved only once measured on a sufficient sample", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 60, 10);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 40));
      await refresh(CTX(ws, actor), p);
      expect((await row(goal.id)).status).toBe("active");
      await client.query("UPDATE projects SET cells_30d = 30 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      expect((await row(goal.id)).status).toBe("achieved");
    });

    it("a goal whose baseline was thin (n<30) shows no progress percentage until achieved, though its current sample is sufficient", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 20, 10);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await client.query("UPDATE projects SET visibility_blended = 40, cells_30d = 100 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      const read = (await list(CTX(ws, actor), p))[0]!;
      expect(read).toMatchObject({ sample_state: "sufficient", status: "active" });
      expect(read.progress_pct).toBeNull();
      await client.query("UPDATE projects SET visibility_blended = 61 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      expect((await list(CTX(ws, actor), p))[0]).toMatchObject({ id: goal.id, status: "achieved", progress_pct: 100 });
    });

    it("the goal refresh is the LAST rollup step, so the audit-chain lock an achievement takes is held for no later step", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 120);
      steps.order.length = 0;
      const handler = createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, {
        enqueueVerifyPresence: async () => undefined, enqueueTaskGenerate: async () => undefined });
      await inTenant(CTX(ws, actor), () =>
        handler(currentTenantStore()!.client, { data: { payload: { workspaceId: ws, kid: "k", projectId: p } } } as unknown as Job));
      expect(steps.order).toEqual(["source_index", "geo", "goals"]);
    });

    it("direction comes from the metric, not from the stored jsonb: a stored `down` is ignored", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await client.query(`UPDATE goals SET target = jsonb_set(target, '{direction}', '"down"') WHERE id = $1`, [goal.id]);
      await client.query("UPDATE projects SET visibility_blended = 10 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      expect((await row(goal.id)).status).toBe("active");
    });

    it("[STORY-065 #11] the ROLLUP HANDLER (not the step alone) moves current and achieves a goal that has reached its target", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 42.5, 120);
      await metricDay(ws, p, "all", "2026-09-27", { citationShare: 0.42, cells: 40 });
      const goal = await create(CTX(ws, actor), p, kindGoal("citation_presence", "citation_share", 60));
      const before = await row(goal.id);
      await client.query("UPDATE metric_daily SET citation_share = 0.7 WHERE project_id = $1", [p]);
      const handler = createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, {
        enqueueVerifyPresence: async () => undefined, enqueueTaskGenerate: async () => undefined });
      await inTenant(CTX(ws, actor), () =>
        handler(currentTenantStore()!.client, { data: { payload: { workspaceId: ws, kid: "k", projectId: p } } } as unknown as Job));
      const after = await row(goal.id);
      expect(after.current!.value).toBe(70);
      expect(after.current!.at).not.toBe(before.current!.at);
      expect(after.status).toBe("achieved");
      expect(after.achieved_at).not.toBeNull();
      expect((await client.query("SELECT 1 FROM audit_log WHERE action = 'goal.achieved' AND workspace_id = $1", [ws])).rowCount).toBe(1);
    });

    it("is idempotent: a second refresh neither re-stamps achieved_at, nor writes a second audit row, nor moves an achieved goal's current", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await client.query("UPDATE projects SET visibility_blended = 70 WHERE id = $1", [p]);
      await refresh(CTX(ws, actor), p);
      const first = await row(goal.id);
      await client.query("UPDATE projects SET visibility_blended = 10 WHERE id = $1", [p]);
      expect(await refresh(CTX(ws, actor), p)).toMatchObject({ refreshed: 0, achieved: [] });
      expect(await row(goal.id)).toEqual(first);
      expect((await client.query("SELECT 1 FROM audit_log WHERE action = 'goal.achieved'")).rowCount).toBe(1);
    });

    it("one pass achieves each reaching goal and leaves the others active; a user cannot set achieved through abandon", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const a = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 55, {}));
      const b = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 90, {}));
      await client.query("UPDATE projects SET visibility_blended = 56 WHERE id = $1", [p]);
      expect(await refresh(CTX(ws, actor), p)).toMatchObject({ refreshed: 2, achieved: [a.id] });
      expect((await row(a.id)).status).toBe("achieved");
      expect((await row(b.id)).status).toBe("active");
      await expect(abandon(CTX(ws, actor), p, a.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it("tenancy: refreshing another tenant's project touches nothing (RLS), and the audit row lands in the project's own workspace chain", async () => {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws, 40, 100);
      const other = await createWorkspace(); const otherActor = await createUser(other);
      const goal = await create(CTX(ws, actor), p, kindGoal("engine_score", "visibility_score", 60));
      await client.query("UPDATE projects SET visibility_blended = 70 WHERE id = $1", [p]);
      expect(await refresh(CTX(other, otherActor), p)).toMatchObject({ refreshed: 0, achieved: [] });
      expect((await row(goal.id)).status).toBe("active");
      await refresh(CTX(ws, actor), p);
      expect((await client.query<{ workspace_id: string }>("SELECT workspace_id FROM audit_log WHERE action = 'goal.achieved'")).rows.map((r) => r.workspace_id)).toEqual([ws]);
    });
  });
});
