import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../../src/api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../src/tenancy/errors.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { updateTaskRequestSchema } from "../../contracts/tasks/index.js";

// STORY-064 (step B) — PATCH /v1/tasks/{id}, real SQL as the real
// `nominara_app` role. Tenant write path + task_events audit: a dangerous area.
describe("STORY-064 · TasksService.updateTask — real SQL", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;
  const service = new TasksService(new NoopRealtimePublisher());

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
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'business') RETURNING id",
      [`Workspace ${seq}`, `workspace-${seq}-${randomUUID()}`]);
    return r.rows[0]!.id;
  }
  async function createUser(workspaceId: string | null, status = "active"): Promise<string> {
    seq += 1;
    const u = await client.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u${seq}-${randomUUID()}@example.com`]);
    if (workspaceId !== null) {
      await client.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'manager', $3)", [workspaceId, u.rows[0]!.id, status]);
    }
    return u.rows[0]!.id;
  }
  async function createProject(workspaceId: string): Promise<string> {
    seq += 1;
    const r = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, $3, 'https://example.com', $4) RETURNING id`,
      [workspaceId, `Project ${seq}`, `project-${seq}`, `example-${seq}.com`]);
    return r.rows[0]!.id;
  }
  async function createGoal(workspaceId: string, projectId: string): Promise<string> {
    const r = await client.query<{ id: string }>(
      `INSERT INTO goals (workspace_id, project_id, title, kind, target) VALUES ($1, $2, 'Goal', 'custom', '{}'::jsonb) RETURNING id`,
      [workspaceId, projectId]);
    return r.rows[0]!.id;
  }
  async function createTask(workspaceId: string, projectId: string, status = "todo", extra: { completed?: boolean } = {}): Promise<string> {
    seq += 1;
    const r = await client.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, dismissed_reason, resurface_at, completed_at)
       VALUES ($1, $2, $3, 'content', $4, 'T', 'D', $5, $6, $7, $8) RETURNING id`,
      [workspaceId, projectId, `HUB-${seq}`, createHash("sha256").update(`t-${seq}-${randomUUID()}`).digest(), status,
        status === "dismissed" ? "old reason" : null, status === "dismissed" ? "2027-01-01T00:00:00Z" : null,
        extra.completed ? new Date() : null]);
    await client.query("UPDATE projects SET open_task_count = (SELECT count(*) FROM tasks WHERE project_id = $1 AND status IN ('todo','in_progress')) WHERE id = $1", [projectId]);
    return r.rows[0]!.id;
  }

  const CTX = (workspaceId: string, actorId: string, scope?: readonly string[]): TenantContext => ({
    workspaceId, actorId, ...(scope !== undefined ? { scopeProjectIds: scope } : {}),
  });
  const patch = (ctx: TenantContext, taskId: string, body: Record<string, unknown>) =>
    inTenant(ctx, () => service.updateTask(taskId, updateTaskRequestSchema.parse(body)));
  const events = async (taskId: string) =>
    (await client.query<{ event: string; actor_id: string | null; actor_type: string; from_value: string | null; to_value: string | null; payload: unknown }>(
      "SELECT event, actor_id, actor_type, from_value, to_value, payload FROM task_events WHERE task_id = $1 ORDER BY occurred_at, id", [taskId])).rows;
  const openCount = async (projectId: string) =>
    (await client.query<{ open_task_count: number }>("SELECT open_task_count FROM projects WHERE id = $1", [projectId])).rows[0]!.open_task_count;

  it("[STORY-064 #4] dismissing without a reason is refused by the contract (400 validation_failed at the pipe)", () => {
    expect(updateTaskRequestSchema.safeParse({ status: "dismissed" }).success).toBe(false);
    expect(updateTaskRequestSchema.safeParse({ status: "dismissed", dismiss_reason: "   " }).success).toBe(false);
  });

  it("[STORY-064 #5] dismissing with a reason sets dismissed_reason, resurface_at = now + 180 d, and drops the open count", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await createTask(ws, p); await createTask(ws, p);
    expect(await openCount(p)).toBe(2);
    const out = await patch(CTX(ws, actor), t, { status: "dismissed", dismiss_reason: "not relevant" });
    expect(out.status).toBe("dismissed");
    expect(out.dismissed_reason).toBe("not relevant");
    const row = (await client.query<{ days: number }>("SELECT EXTRACT(EPOCH FROM (resurface_at - now())) / 86400 AS days FROM tasks WHERE id = $1", [t])).rows[0]!;
    expect(Number(row.days)).toBeGreaterThan(179.9);
    expect(Number(row.days)).toBeLessThanOrEqual(180);
    expect(await openCount(p)).toBe(1);
    const ev = await events(t);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event: "dismissed", actor_id: actor, actor_type: "user", from_value: "todo", to_value: "dismissed" });
  });

  it("reopening a dismissed task clears the reason and re-surface date, writes 'reopened', and restores the open count", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await createTask(ws, p, "dismissed");
    expect(await openCount(p)).toBe(0);
    const out = await patch(CTX(ws, actor), t, { status: "todo" });
    expect(out).toMatchObject({ status: "todo", dismissed_reason: null, resurface_at: null });
    expect(await openCount(p)).toBe(1);
    expect((await events(t))[0]).toMatchObject({ event: "reopened", from_value: "dismissed", to_value: "todo" });
  });

  it("[STORY-064 #7] status, assignee, priority, due date and goal each write one event with actor, from and to, in the same transaction", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const assignee = await createUser(ws); const goal = await createGoal(ws, p);
    const t = await createTask(ws, p);
    const due = "2026-12-01T00:00:00.000Z";
    await patch(CTX(ws, actor), t, { status: "in_progress", assignee_id: assignee, priority: 5, due_at: due, goal_id: goal });
    const ev = await events(t);
    const by = Object.fromEntries(ev.map((e) => [e.event, e]));
    expect(ev).toHaveLength(5);
    expect(ev.every((e) => e.actor_id === actor && e.actor_type === "user")).toBe(true);
    expect(by.status_changed).toMatchObject({ from_value: "todo", to_value: "in_progress" });
    expect(by.assigned).toMatchObject({ from_value: null, to_value: assignee });
    expect(by.priority_changed).toMatchObject({ from_value: "3", to_value: "5" });
    expect(by.due_changed).toMatchObject({ from_value: null });
    expect(new Date(by.due_changed!.to_value!).toISOString()).toBe(due);
    expect(by.goal_linked).toMatchObject({ from_value: null, to_value: goal });
    // null clears, and records the old value as from_value.
    await patch(CTX(ws, actor), t, { assignee_id: null, goal_id: null, due_at: null });
    const after = await events(t);
    expect(after).toHaveLength(8);
    expect(after.filter((e) => e.event === "assigned").at(-1)).toMatchObject({ from_value: assignee, to_value: null });
  });

  it("a field patched to its current value writes no event and changes nothing", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await createTask(ws, p);
    await patch(CTX(ws, actor), t, { priority: 3, status: "todo", assignee_id: null });
    expect(await events(t)).toEqual([]);
  });

  it("[STORY-064 #7] a refused patch is atomic: nothing is updated and no event is written", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const outsider = await createUser(null);
    const t = await createTask(ws, p);
    await expect(patch(CTX(ws, actor), t, { priority: 5, assignee_id: outsider })).rejects.toBeInstanceOf(ValidationFailedError);
    expect((await client.query("SELECT priority FROM tasks WHERE id = $1", [t])).rows[0]!.priority).toBe(3);
    expect(await events(t)).toEqual([]);
  });

  it("status=done through PATCH is refused with 409 conflict (completion is its own endpoint) and a done task cannot be moved by PATCH", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await createTask(ws, p);
    await expect(patch(CTX(ws, actor), t, { status: "done" })).rejects.toBeInstanceOf(ConflictError);
    const done = await createTask(ws, p, "done", { completed: true });
    await expect(patch(CTX(ws, actor), done, { status: "todo" })).rejects.toBeInstanceOf(ConflictError);
    expect(await events(t)).toEqual([]);
  });

  it("assignee must be an ACTIVE member of this workspace: a cross-tenant user, a suspended member and an unknown id are refused; an active member is accepted", async () => {
    const ws = await createWorkspace(); const other = await createWorkspace();
    const actor = await createUser(ws); const p = await createProject(ws);
    const foreign = await createUser(other); const suspended = await createUser(ws, "suspended"); const ok = await createUser(ws);
    const t = await createTask(ws, p);
    for (const bad of [foreign, suspended, randomUUID()]) {
      await expect(patch(CTX(ws, actor), t, { assignee_id: bad })).rejects.toBeInstanceOf(ValidationFailedError);
    }
    expect((await patch(CTX(ws, actor), t, { assignee_id: ok })).assignee_id).toBe(ok);
  });

  it("goal_id must be a goal of the task's own project", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws);
    const p1 = await createProject(ws); const p2 = await createProject(ws);
    const t = await createTask(ws, p1);
    const otherProjectGoal = await createGoal(ws, p2);
    await expect(patch(CTX(ws, actor), t, { goal_id: otherProjectGoal })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(patch(CTX(ws, actor), t, { goal_id: randomUUID() })).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("another tenant's task and an unknown id are 404 (RLS), never an update", async () => {
    const wsA = await createWorkspace(); const wsB = await createWorkspace();
    const actorA = await createUser(wsA); const pB = await createProject(wsB);
    const foreign = await createTask(wsB, pB);
    await expect(patch(CTX(wsA, actorA), foreign, { priority: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(patch(CTX(wsA, actorA), randomUUID(), { priority: 1 })).rejects.toBeInstanceOf(NotFoundError);
    expect((await client.query("SELECT priority FROM tasks WHERE id = $1", [foreign])).rows[0]!.priority).toBe(3);
  });

  it("a project-scoped manager may patch an in-scope task and is refused (403 out of scope) on an out-of-scope one", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws);
    const inScope = await createProject(ws); const outScope = await createProject(ws);
    const tIn = await createTask(ws, inScope); const tOut = await createTask(ws, outScope);
    const ctx = CTX(ws, actor, [inScope]);
    expect((await patch(ctx, tIn, { priority: 4 })).priority).toBe(4);
    await expect(patch(ctx, tOut, { priority: 4 })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect((await client.query("SELECT priority FROM tasks WHERE id = $1", [tOut])).rows[0]!.priority).toBe(3);
  });

  it("a soft-deleted task is 404", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await createTask(ws, p);
    await client.query("UPDATE tasks SET deleted_at = now() WHERE id = $1", [t]);
    await expect(patch(CTX(ws, actor), t, { priority: 2 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("concurrent patches of one task serialise: both events are written and the count stays consistent", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await createTask(ws, p); await createTask(ws, p);
    await Promise.all([
      patch(CTX(ws, actor), t, { status: "dismissed", dismiss_reason: "a" }),
      patch(CTX(ws, actor), t, { priority: 1 }),
    ]);
    expect((await events(t)).map((e) => e.event).sort()).toEqual(["dismissed", "priority_changed"]);
    expect(await openCount(p)).toBe(1);
  });

  // Two STATUS changes touch the same column, so only the row lock (FOR UPDATE)
  // makes the second see the first's result. Without it both record from_value
  // 'todo'. Looped so the race is actually hit.
  it("concurrent status changes form a from/to chain, ordered by occurred_at, ending at the final status", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    for (let i = 0; i < 10; i++) {
      const t = await createTask(ws, p);
      await Promise.all([
        patch(CTX(ws, actor), t, { status: "in_progress" }),
        patch(CTX(ws, actor), t, { status: "dismissed", dismiss_reason: "x" }),
      ]);
      const ev = await events(t); // ORDER BY occurred_at, id
      expect(ev).toHaveLength(2);
      expect(ev[0]!.from_value).toBe("todo");
      expect(ev[0]!.to_value).toBe(ev[1]!.from_value);
      const final = (await client.query<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [t])).rows[0]!.status;
      expect(ev[1]!.to_value).toBe(final);
    }
  });
});
