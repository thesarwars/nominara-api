import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ConflictError, NotFoundError } from "../../src/api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../src/tenancy/errors.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { completeTaskResponseSchema, createCommentRequestSchema, createTaskRequestSchema, taskEventListQuerySchema, updateTaskRequestSchema } from "../../contracts/tasks/index.js";

// STORY-064 (step C) — manual create (gapless short_ref), comments and the event
// timeline, real SQL as the real `nominara_app` role. Tenant write path: dangerous area.
describe("STORY-064-D · complete / realtime publish — real SQL", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;
  const publisher = new NoopRealtimePublisher();
  const service = new TasksService(publisher);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
  }, 120_000);
  afterAll(async () => { await container.stop(); });

  beforeEach(async () => {
    publisher.published.length = 0;
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
  const CTX = (workspaceId: string, actorId: string, scope?: readonly string[]): TenantContext => ({
    workspaceId, actorId, ...(scope !== undefined ? { scopeProjectIds: scope } : {}),
  });
  const create = (ctx: TenantContext, projectId: string, body: Record<string, unknown>) =>
    inTenant(ctx, () => service.createTask(projectId, createTaskRequestSchema.parse(body)));
  const complete = (ctx: TenantContext, taskId: string) => inTenant(ctx, () => service.completeTask(taskId));
  const patch = (ctx: TenantContext, taskId: string, body: Record<string, unknown>) =>
    inTenant(ctx, () => service.updateTask(taskId, updateTaskRequestSchema.parse(body)));
  const setBaseline = (taskId: string) =>
    client.query(`UPDATE tasks SET baseline_metrics = '{"visibility":12.5}'::jsonb WHERE id = $1`, [taskId]);

  it("[STORY-064-D] completing writes status, completed_at/by, a task_completed milestone pinned at completed_at, the 'completed' event and the open count", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "Ship FAQ" });
    const out = await complete(CTX(ws, actor), t.id);
    expect(completeTaskResponseSchema.parse(out)).toEqual(out);
    expect(out.verification).toBeNull();
    expect(out.task).toMatchObject({ id: t.id, status: "done" });
    expect(out.task.completed_at).not.toBeNull();
    const row = (await client.query(`SELECT status, completed_at, completed_by, milestone_id FROM tasks WHERE id = $1`, [t.id])).rows[0]!;
    expect(row.status).toBe("done");
    expect(row.completed_by).toBe(actor);
    const ms = (await client.query(`SELECT * FROM milestones WHERE project_id = $1`, [p])).rows;
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ id: out.milestone.id, kind: "task_completed", source_type: "task", source_id: t.id, workspace_id: ws, created_by: actor, severity: "positive" });
    expect(row.milestone_id).toBe(ms[0].id);
    expect(ms[0].occurred_at.getTime()).toBe(row.completed_at.getTime());
    expect(out.milestone.occurred_at).toBe(row.completed_at.toISOString());
    const ev = (await client.query(`SELECT event, actor_id, from_value, to_value FROM task_events WHERE task_id = $1 AND event = 'completed'`, [t.id])).rows;
    expect(ev).toEqual([{ event: "completed", actor_id: actor, from_value: "todo", to_value: "done" }]);
    expect((await client.query(`SELECT open_task_count FROM projects WHERE id = $1`, [p])).rows[0].open_task_count).toBe(0);
  });

  it("[STORY-064-D] baseline_metrics (captured at creation) is untouched; completion_metrics stays null", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    await setBaseline(t.id);
    await complete(CTX(ws, actor), t.id);
    const r = (await client.query(`SELECT baseline_metrics, completion_metrics FROM tasks WHERE id = $1`, [t.id])).rows[0]!;
    expect(r.baseline_metrics).toEqual({ visibility: 12.5 });
    expect(r.completion_metrics).toBeNull();
  });

  it("[STORY-064-D] an in_progress task completes, and the event records the from-status", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    await patch(CTX(ws, actor), t.id, { status: "in_progress" });
    await complete(CTX(ws, actor), t.id);
    const ev = (await client.query(`SELECT from_value FROM task_events WHERE task_id = $1 AND event = 'completed'`, [t.id])).rows;
    expect(ev).toEqual([{ from_value: "in_progress" }]);
  });

  it("[STORY-064-D] completing a done task is a 409 with current_state, and writes no second milestone or event", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    await complete(CTX(ws, actor), t.id);
    publisher.published.length = 0;
    const err = await complete(CTX(ws, actor), t.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as { details: unknown }).details).toMatchObject({ current_state: "done" });
    expect((await client.query(`SELECT 1 FROM milestones WHERE project_id = $1`, [p])).rows).toHaveLength(1);
    expect((await client.query(`SELECT 1 FROM task_events WHERE task_id = $1 AND event = 'completed'`, [t.id])).rows).toHaveLength(1);
    expect(publisher.published).toEqual([]);
  });

  it("[STORY-064-D] completing a dismissed task is a 409 with current_state=dismissed and changes nothing", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    await patch(CTX(ws, actor), t.id, { status: "dismissed", dismiss_reason: "not relevant" });
    const err = await complete(CTX(ws, actor), t.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as { details: unknown }).details).toMatchObject({ current_state: "dismissed" });
    expect((await client.query(`SELECT status, completed_at, milestone_id FROM tasks WHERE id = $1`, [t.id])).rows[0]).toEqual({ status: "dismissed", completed_at: null, milestone_id: null });
    expect((await client.query(`SELECT 1 FROM milestones WHERE project_id = $1`, [p])).rows).toHaveLength(0);
  });

  it("[STORY-064-D] two concurrent completions: exactly one wins, one milestone, one 409", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    const results = await Promise.allSettled([complete(CTX(ws, actor), t.id), complete(CTX(ws, actor), t.id), complete(CTX(ws, actor), t.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictError);
    expect((await client.query(`SELECT 1 FROM milestones WHERE project_id = $1`, [p])).rows).toHaveLength(1);
    expect(publisher.published.filter((e) => e.event === "task.moved")).toHaveLength(1);
  });

  it("[STORY-064-D] an unknown or foreign-tenant task is 404; an out-of-scope task is the scope 403; nothing is written", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws); const q = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    const ws2 = await createWorkspace(); const other = await createUser(ws2);
    await expect(complete(CTX(ws, actor), randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(complete(CTX(ws2, other), t.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(complete(CTX(ws, actor, [q]), t.id)).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect((await client.query(`SELECT status FROM tasks WHERE id = $1`, [t.id])).rows[0].status).toBe("todo");
    expect((await client.query(`SELECT 1 FROM milestones`)).rows).toHaveLength(0);
    expect(publisher.published.filter((e) => e.event === "task.moved")).toEqual([]);
  });

  it("[STORY-064-D] a rolled-back completion leaves no milestone, no event, and publishes NOTHING (publish is after commit)", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    publisher.published.length = 0;
    await expect(inTenant(CTX(ws, actor), async () => {
      await service.completeTask(t.id);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await client.query(`SELECT status, milestone_id FROM tasks WHERE id = $1`, [t.id])).rows[0]).toEqual({ status: "todo", milestone_id: null });
    expect((await client.query(`SELECT 1 FROM milestones`)).rows).toHaveLength(0);
    expect(publisher.published).toEqual([]);
  });

  it("[STORY-064-D] a successful completion publishes task.moved to the caller's workspace room only, with the catalogued payload", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    publisher.published.length = 0;
    await complete(CTX(ws, actor), t.id);
    expect(publisher.published).toEqual([
      { workspaceId: ws, event: "task.moved", payload: { task_id: t.id, project_id: p, from_status: "todo", to_status: "done", actor_id: actor } },
    ]);
  });

  it("[STORY-064-D realtime ids-only] neither task.created nor task.moved carries the task title (or any free text): a scoped member who cannot read the project learns ids, never content", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    publisher.published.length = 0;
    const secret = `Confidential-title-${randomUUID()}`;
    const t = await create(CTX(ws, actor), p, { title: secret });
    await patch(CTX(ws, actor), t.id, { status: "in_progress" });
    await complete(CTX(ws, actor), t.id);
    const events = publisher.published.filter((e) => e.event === "task.created" || e.event === "task.moved");
    expect(events.map((e) => e.event)).toEqual(["task.created", "task.moved", "task.moved"]);
    expect(JSON.stringify(publisher.published)).not.toContain(secret);
    for (const e of events) expect(Object.keys(e.payload as object)).not.toContain("title");
    expect(Object.keys(events[0]!.payload as object).sort()).toEqual(["project_id", "task_id"]);
  });

  it("[STORY-064-D] PATCH publishes task.moved on a status change (and only then); create publishes task.created; neither before commit", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    publisher.published.length = 0;
    const t = await create(CTX(ws, actor), p, { title: "Brand new" });
    expect(publisher.published).toEqual([
      { workspaceId: ws, event: "task.created", payload: { task_id: t.id, project_id: p } },
    ]);
    publisher.published.length = 0;
    await patch(CTX(ws, actor), t.id, { priority: 1 });
    await patch(CTX(ws, actor), t.id, { status: "todo" });
    expect(publisher.published).toEqual([]);
    await patch(CTX(ws, actor), t.id, { status: "in_progress" });
    expect(publisher.published).toEqual([
      { workspaceId: ws, event: "task.moved", payload: { task_id: t.id, project_id: p, from_status: "todo", to_status: "in_progress", actor_id: actor } },
    ]);
    publisher.published.length = 0;
    await expect(inTenant(CTX(ws, actor), async () => {
      await service.createTask(p, createTaskRequestSchema.parse({ title: "doomed" }));
      await service.updateTask(t.id, updateTaskRequestSchema.parse({ status: "todo" }));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(publisher.published).toEqual([]);
  });

  // Checkpoint-1 audit: the soft-delete guards were untested (a mutation removing
  // `t.deleted_at IS NULL` survived) and a task of a soft-deleted project was reachable.
  describe("soft-deleted task / project guards", () => {
    const createComment = (ctx: TenantContext, taskId: string) =>
      inTenant(ctx, () => service.createComment(taskId, createCommentRequestSchema.parse({ body: "hi" })));
    const listEvents = (ctx: TenantContext, taskId: string) =>
      inTenant(ctx, () => service.listTaskEvents(taskId, taskEventListQuerySchema.parse({})));
    const counts = async (taskId: string, projectId: string) => ({
      milestones: (await client.query(`SELECT 1 FROM milestones WHERE project_id = $1`, [projectId])).rows.length,
      events: (await client.query(`SELECT 1 FROM task_events WHERE task_id = $1`, [taskId])).rows.length,
      status: (await client.query(`SELECT status FROM tasks WHERE id = $1`, [taskId])).rows[0].status,
    });
    async function seed() {
      const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
      const t = await create(CTX(ws, actor), p, { title: "T" });
      publisher.published.length = 0;
      return { ws, actor, p, t, ctx: CTX(ws, actor) };
    }

    it("[STORY-064-D] completing a soft-deleted task is a 404 and writes nothing", async () => {
      const { p, t, ctx } = await seed();
      await client.query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [t.id]);
      const before = await counts(t.id, p);
      await expect(complete(ctx, t.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await counts(t.id, p)).toEqual(before);
      expect(publisher.published).toEqual([]);
    });

    it("[STORY-064-D] completing a task of a soft-deleted project is a 404 and writes nothing", async () => {
      const { p, t, ctx } = await seed();
      await client.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [p]);
      const before = await counts(t.id, p);
      await expect(complete(ctx, t.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await counts(t.id, p)).toEqual(before);
      expect(publisher.published).toEqual([]);
    });

    it("[STORY-064-C] commenting on a soft-deleted task is a 404 and writes nothing", async () => {
      const { p, t, ctx } = await seed();
      await client.query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [t.id]);
      const before = await counts(t.id, p);
      await expect(createComment(ctx, t.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await counts(t.id, p)).toEqual(before);
    });

    it("[STORY-064-C] commenting on a task of a soft-deleted project is a 404 and writes nothing", async () => {
      const { p, t, ctx } = await seed();
      await client.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [p]);
      const before = await counts(t.id, p);
      await expect(createComment(ctx, t.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await counts(t.id, p)).toEqual(before);
    });

    it("[STORY-064-C] listing the timeline of a soft-deleted task is a 404", async () => {
      const { t, ctx } = await seed();
      await client.query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [t.id]);
      await expect(listEvents(ctx, t.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("[STORY-064-C] listing the timeline of a task of a soft-deleted project is a 404", async () => {
      const { p, t, ctx } = await seed();
      await client.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [p]);
      await expect(listEvents(ctx, t.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("[STORY-064-C] creating a task on a soft-deleted project is a 404 and consumes no reference", async () => {
      const { ws, p, ctx } = await seed();
      await client.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [p]);
      const tasksBefore = (await client.query(`SELECT 1 FROM tasks WHERE project_id = $1`, [p])).rows.length;
      const refBefore = (await client.query(`SELECT next_value FROM ref_counters WHERE workspace_id = $1`, [ws])).rows;
      await expect(create(ctx, p, { title: "nope" })).rejects.toBeInstanceOf(NotFoundError);
      expect((await client.query(`SELECT 1 FROM tasks WHERE project_id = $1`, [p])).rows).toHaveLength(tasksBefore);
      expect((await client.query(`SELECT next_value FROM ref_counters WHERE workspace_id = $1`, [ws])).rows).toEqual(refBefore);
      expect(publisher.published).toEqual([]);
    });
  });
});
