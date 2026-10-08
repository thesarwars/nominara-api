import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../../src/api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../src/tenancy/errors.js";
import { GoalsService } from "../../src/modules/tasks/goals.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { createGoalRequestSchema, updateGoalRequestSchema } from "../../contracts/tasks/index.js";

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
  async function createCluster(workspaceId: string, projectId: string, score: number | null = 31.25): Promise<string> {
    const r = await client.query<{ id: string }>(
      `INSERT INTO topic_clusters (workspace_id, project_id, label, visibility_score) VALUES ($1, $2, 'CRM', $3) RETURNING id`, [workspaceId, projectId, score]);
    return r.rows[0]!.id;
  }
  const CTX = (workspaceId: string, actorId: string, scope?: readonly string[]): TenantContext => ({
    workspaceId, actorId, ...(scope !== undefined ? { scopeProjectIds: scope } : {}),
  });
  const engineGoal = (extra: Record<string, unknown> = {}) =>
    createGoalRequestSchema.parse({ title: "Lift visibility", kind: "engine_score", target: { metric: "visibility_score", target_value: 60 }, ...extra });
  const create = (ctx: TenantContext, projectId: string, body = engineGoal()) => inTenant(ctx, () => service.createGoal(projectId, body));
  const list = (ctx: TenantContext, projectId: string) => inTenant(ctx, () => service.listGoals(projectId));
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
        expect((r.reason as ConflictError).details).toMatchObject({ current_state: "abandoned" });
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
});
