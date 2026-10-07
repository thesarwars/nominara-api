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
import { createCommentRequestSchema, createTaskRequestSchema, taskEventListQuerySchema } from "../../contracts/tasks/index.js";

// STORY-064 (step C) — manual create (gapless short_ref), comments and the event
// timeline, real SQL as the real `nominara_app` role. Tenant write path: dangerous area.
describe("STORY-064-C · create / comment / events — real SQL", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;
  const service = new TasksService();

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
  const create = (ctx: TenantContext, projectId: string, body: Record<string, unknown>) =>
    inTenant(ctx, () => service.createTask(projectId, createTaskRequestSchema.parse(body)));
  const comment = (ctx: TenantContext, taskId: string, body: Record<string, unknown>) =>
    inTenant(ctx, () => service.createComment(taskId, createCommentRequestSchema.parse(body)));
  const timeline = (ctx: TenantContext, taskId: string, query: Record<string, unknown> = {}) =>
    inTenant(ctx, () => service.listTaskEvents(taskId, taskEventListQuerySchema.parse(query)));
  const refs = async (workspaceId: string) =>
    (await client.query<{ short_ref: string }>("SELECT short_ref FROM tasks WHERE workspace_id = $1", [workspaceId])).rows.map((r) => r.short_ref);
  const counter = async (workspaceId: string, prefix: string) =>
    (await client.query<{ next_value: number }>("SELECT next_value FROM ref_counters WHERE workspace_id = $1 AND prefix = $2", [workspaceId, prefix])).rows[0]?.next_value;

  it("[STORY-064 #9] N concurrent creates in one workspace+prefix yield gapless, unique short_refs", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const N = 25;
    const out = await Promise.all(Array.from({ length: N }, (_, i) => create(CTX(ws, actor), p, { title: `Task ${i}` })));
    const got = out.map((t) => t.short_ref).sort();
    const expected = Array.from({ length: N }, (_, i) => `PRO-${i + 1}`).sort();
    expect(got).toEqual(expected);
    expect(new Set(await refs(ws)).size).toBe(N);
    expect(await counter(ws, "PRO")).toBe(N + 1);
  }, 60_000);

  it("[STORY-064 #9] two projects sharing a prefix draw from one counter; a rolled-back create leaves no gap", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws);
    const p1 = await createProject(ws); const p2 = await createProject(ws);
    await Promise.all([create(CTX(ws, actor), p1, { title: "a" }), create(CTX(ws, actor), p2, { title: "b" })]);
    await expect(inTenant(CTX(ws, actor), async () => {
      await service.createTask(p1, createTaskRequestSchema.parse({ title: "doomed" }));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    const next = await create(CTX(ws, actor), p1, { title: "c" });
    expect((await refs(ws)).sort()).toEqual(["PRO-1", "PRO-2", "PRO-3"]);
    expect(next.short_ref).toBe("PRO-3");
  });

  it("creates origin=manual, todo, with a non-null fingerprint, an empty description, the default kind, and a 'created' event with the actor", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "  Write the FAQ  " });
    expect(t).toMatchObject({ title: "Write the FAQ", origin: "manual", status: "todo", kind: "content", description: "", project_id: p, goal_id: null });
    const row = (await client.query<{ fp: Buffer | null }>("SELECT dedupe_fingerprint AS fp FROM tasks WHERE id = $1", [t.id])).rows[0]!;
    expect(row.fp).not.toBeNull();
    const ev = await client.query<{ event: string; actor_id: string; actor_type: string; to_value: string | null }>("SELECT event, actor_id, actor_type, to_value FROM task_events WHERE task_id = $1", [t.id]);
    expect(ev.rows).toEqual([{ event: "created", actor_id: actor, actor_type: "user", to_value: "todo" }]);
    const open = (await client.query<{ open_task_count: number }>("SELECT open_task_count FROM projects WHERE id = $1", [p])).rows[0]!;
    expect(open.open_task_count).toBe(1);
  });

  it("two manual tasks with the same title are two tasks (the fingerprint never collapses them)", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const a = await create(CTX(ws, actor), p, { title: "same" }); const b = await create(CTX(ws, actor), p, { title: "same" });
    expect(a.id).not.toBe(b.id);
  });

  it("links a goal of the same project; refuses a goal of another project (422) and writes nothing", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws); const other = await createProject(ws);
    const own = await createGoal(ws, p); const foreign = await createGoal(ws, other);
    expect((await create(CTX(ws, actor), p, { title: "g", goal_id: own })).goal_id).toBe(own);
    await expect(create(CTX(ws, actor), p, { title: "g2", goal_id: foreign })).rejects.toBeInstanceOf(ValidationFailedError);
    expect(await refs(ws)).toHaveLength(1);
    expect(await counter(ws, "PRO")).toBe(2);
  });

  it("an unknown project and another tenant's project are 404; an out-of-scope project is the scope 403", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws); const q = await createProject(ws);
    const ws2 = await createWorkspace(); const p2 = await createProject(ws2);
    await expect(create(CTX(ws, actor), randomUUID(), { title: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(create(CTX(ws, actor), p2, { title: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(create(CTX(ws, actor, [p]), q, { title: "x" })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect((await create(CTX(ws, actor, [p]), p, { title: "ok" })).project_id).toBe(p);
  });

  it("[STORY-064 #8] a comment appears on the same timeline as status events, newest first", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    await client.query("UPDATE users SET full_name = 'Ada Lovelace' WHERE id = $1", [actor]);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    await inTenant(CTX(ws, actor), () => service.updateTask(t.id, { status: "in_progress" }));
    const posted = await comment(CTX(ws, actor), t.id, { body: "Looking into it" });
    expect(posted).toMatchObject({ event: "commented", comment_body: "Looking into it", task_id: t.id, actor: { id: actor, display_name: "Ada Lovelace", type: "user" } });
    const tl = await timeline(CTX(ws, actor), t.id);
    expect(tl.items.map((e) => e.event)).toEqual(["commented", "status_changed", "created"]);
    expect(tl.items[1]).toMatchObject({ from_value: "todo", to_value: "in_progress" });
  });

  it("the timeline paginates by cursor without skipping or repeating", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    for (let i = 0; i < 4; i += 1) await comment(CTX(ws, actor), t.id, { body: `c${i}` });
    const first = await timeline(CTX(ws, actor), t.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.pagination.has_more).toBe(true);
    const second = await timeline(CTX(ws, actor), t.id, { limit: 2, cursor: first.pagination.cursor_next });
    const third = await timeline(CTX(ws, actor), t.id, { limit: 2, cursor: second.pagination.cursor_next });
    const all = [...first.items, ...second.items, ...third.items];
    expect(new Set(all.map((e) => e.id)).size).toBe(5);
    expect(all.map((e) => e.comment_body)).toEqual(["c3", "c2", "c1", "c0", null]);
    expect(third.pagination.has_more).toBe(false);
  });

  it("a system event has actor.type=system; comments and timeline refuse another tenant's task (404) and out-of-scope (403)", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws); const q = await createProject(ws);
    const t = await create(CTX(ws, actor), p, { title: "T" });
    await client.query("INSERT INTO task_events (workspace_id, task_id, actor_id, actor_type, event) VALUES ($1,$2,NULL,'system','evidence_refreshed')", [ws, t.id]);
    const sys = (await timeline(CTX(ws, actor), t.id)).items.find((e) => e.event === "evidence_refreshed")!;
    expect(sys.actor).toEqual({ id: null, display_name: null, type: "system" });
    const ws2 = await createWorkspace(); const other = await createUser(ws2);
    await expect(comment(CTX(ws2, other), t.id, { body: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(timeline(CTX(ws2, other), t.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(comment(CTX(ws, actor, [q]), t.id, { body: "x" })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    await expect(timeline(CTX(ws, actor, [q]), t.id)).rejects.toBeInstanceOf(ProjectOutOfScopeException);
  });
});
