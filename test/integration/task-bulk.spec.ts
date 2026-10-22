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
import { bulkTaskRequestSchema, TASK_BULK_MAX } from "../../contracts/tasks/index.js";

// STORY-064 AC12 — bulk assign, status change and snooze, real SQL as the real `nominara_app` role.
// Tenant write path + task_events audit: a dangerous area. Every scenario below is RED before the endpoint exists.
describe("STORY-064 AC12 · TasksService.bulkUpdateTasks — real SQL", () => {
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
  const bulk = (ctx: TenantContext, body: Record<string, unknown>) =>
    inTenant(ctx, () => service.bulkUpdateTasks(bulkTaskRequestSchema.parse(body)));
  const events = async (taskId: string) =>
    (await client.query<{ event: string; actor_id: string | null; actor_type: string; from_value: string | null; to_value: string | null; payload: Record<string, unknown> | null }>(
      "SELECT event, actor_id, actor_type, from_value, to_value, payload FROM task_events WHERE task_id = $1 ORDER BY occurred_at, id", [taskId])).rows;
  const row = async (taskId: string) =>
    (await client.query<{ status: string; assignee_id: string | null; dismissed_reason: string | null; resurface_at: Date | null }>(
      "SELECT status, assignee_id, dismissed_reason, resurface_at FROM tasks WHERE id = $1", [taskId])).rows[0]!;
  const openCount = async (projectId: string) =>
    (await client.query<{ open_task_count: number }>("SELECT open_task_count FROM projects WHERE id = $1", [projectId])).rows[0]!.open_task_count;
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

  describe("the contract", () => {
    const ids = [randomUUID()];
    it("[STORY-064 #13] a snooze without a reason is refused", () => {
      expect(bulkTaskRequestSchema.safeParse({ action: "snooze", task_ids: ids, snooze_until: inDays(3) }).success).toBe(false);
      expect(bulkTaskRequestSchema.safeParse({ action: "snooze", task_ids: ids, reason: "   ", snooze_until: inDays(3) }).success).toBe(false);
    });
    it("[STORY-064 #13] a snooze without a date is refused, and so is a date with no offset", () => {
      expect(bulkTaskRequestSchema.safeParse({ action: "snooze", task_ids: ids, reason: "later" }).success).toBe(false);
      expect(bulkTaskRequestSchema.safeParse({ action: "snooze", task_ids: ids, reason: "later", snooze_until: "2027-01-01" }).success).toBe(false);
      expect(bulkTaskRequestSchema.safeParse({ action: "snooze", task_ids: ids, reason: "later", snooze_until: inDays(3) }).success).toBe(true);
    });
    it("an empty batch, an oversized batch, a duplicated id, an unknown action and a stray key are refused", () => {
      expect(bulkTaskRequestSchema.safeParse({ action: "status", task_ids: [], status: "todo" }).success).toBe(false);
      const many = Array.from({ length: TASK_BULK_MAX + 1 }, () => randomUUID());
      expect(bulkTaskRequestSchema.safeParse({ action: "status", task_ids: many, status: "todo" }).success).toBe(false);
      expect(bulkTaskRequestSchema.safeParse({ action: "status", task_ids: Array.from({ length: TASK_BULK_MAX }, () => randomUUID()), status: "todo" }).success).toBe(true);
      expect(bulkTaskRequestSchema.safeParse({ action: "status", task_ids: [ids[0], ids[0]], status: "todo" }).success).toBe(false);
      expect(bulkTaskRequestSchema.safeParse({ action: "delete", task_ids: ids }).success).toBe(false);
      expect(bulkTaskRequestSchema.safeParse({ action: "assign", task_ids: ids, assignee_id: null, reason: "x" }).success).toBe(false);
      expect(bulkTaskRequestSchema.safeParse({ action: "status", task_ids: ids, status: "todo", position: 1 }).success).toBe(false);
    });
    it("a bulk status of done or dismissed is refused: completion is its own endpoint and a dismissal is a snooze", () => {
      expect(bulkTaskRequestSchema.safeParse({ action: "status", task_ids: ids, status: "done" }).success).toBe(false);
      expect(bulkTaskRequestSchema.safeParse({ action: "status", task_ids: ids, status: "dismissed" }).success).toBe(false);
    });
  });

  it("bulk assign writes one assigned event per task with actor, from and to, and clears with null", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const assignee = await createUser(ws);
    const p1 = await createProject(ws); const p2 = await createProject(ws);
    const [a, b, c] = [await createTask(ws, p1), await createTask(ws, p2), await createTask(ws, p2)];
    const out = await bulk(CTX(ws, actor), { action: "assign", task_ids: [a, b, c], assignee_id: assignee });
    expect(out.updated).toBe(3);
    expect(out.tasks.map((t) => t.id)).toEqual([a, b, c]);
    expect(out.tasks.every((t) => t.assignee_id === assignee)).toBe(true);
    for (const t of [a, b, c]) {
      expect(await events(t)).toEqual([expect.objectContaining({ event: "assigned", actor_id: actor, actor_type: "user", from_value: null, to_value: assignee })]);
    }
    const cleared = await bulk(CTX(ws, actor), { action: "assign", task_ids: [a], assignee_id: null });
    expect(cleared.updated).toBe(1);
    expect((await events(a)).at(-1)).toMatchObject({ event: "assigned", from_value: assignee, to_value: null });
  });

  it("an assignee who is not an active member refuses the WHOLE batch", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const outsider = await createUser(null);
    const p = await createProject(ws);
    const [a, b] = [await createTask(ws, p), await createTask(ws, p)];
    await expect(bulk(CTX(ws, actor), { action: "assign", task_ids: [a, b], assignee_id: outsider })).rejects.toBeInstanceOf(ValidationFailedError);
    expect((await row(a)).assignee_id).toBeNull();
    expect(await events(a)).toEqual([]);
  });

  it("bulk status moves tasks, restores a dismissed task as 'reopened', and keeps the open count right per project", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws);
    const p1 = await createProject(ws); const p2 = await createProject(ws);
    const a = await createTask(ws, p1); const b = await createTask(ws, p1, "dismissed"); const c = await createTask(ws, p2, "dismissed");
    expect(await openCount(p1)).toBe(1); expect(await openCount(p2)).toBe(0);
    const out = await bulk(CTX(ws, actor), { action: "status", task_ids: [a, b, c], status: "in_progress" });
    expect(out.updated).toBe(3);
    expect((await events(a))[0]).toMatchObject({ event: "status_changed", from_value: "todo", to_value: "in_progress", actor_id: actor });
    expect((await events(b))[0]).toMatchObject({ event: "reopened", from_value: "dismissed", to_value: "in_progress" });
    expect(await row(b)).toMatchObject({ status: "in_progress", dismissed_reason: null, resurface_at: null });
    expect(await openCount(p1)).toBe(2); expect(await openCount(p2)).toBe(1);
  });

  it("a task already in the requested state is unchanged: no write, no event, and it is not counted as updated", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const [a, b] = [await createTask(ws, p), await createTask(ws, p, "in_progress")];
    const out = await bulk(CTX(ws, actor), { action: "status", task_ids: [a, b], status: "in_progress" });
    expect(out.updated).toBe(1);
    expect(await events(b)).toEqual([]);
  });

  it("[STORY-064 #5/#13] snooze dismisses with the reason and the caller's date, leaves the open count, and marks the event as a snooze", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const [a, b] = [await createTask(ws, p), await createTask(ws, p)]; await createTask(ws, p);
    expect(await openCount(p)).toBe(3);
    const until = inDays(30);
    const out = await bulk(CTX(ws, actor), { action: "snooze", task_ids: [a, b], reason: "after the release", snooze_until: until });
    expect(out.updated).toBe(2);
    expect(await openCount(p)).toBe(1);
    for (const t of [a, b]) {
      const r = await row(t);
      expect(r.status).toBe("dismissed");
      expect(r.dismissed_reason).toBe("after the release");
      expect(r.resurface_at!.toISOString()).toBe(new Date(until).toISOString());
      const ev = await events(t);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ event: "dismissed", actor_id: actor, actor_type: "user", from_value: "todo", to_value: "dismissed" });
      expect(ev[0]!.payload).toMatchObject({ snooze: true, reason: "after the release" });
    }
  });

  it("a snooze date in the past, or further out than a dismissal's 180 days, refuses the whole batch", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const a = await createTask(ws, p);
    for (const bad of [inDays(-1), new Date(Date.now() - 1000).toISOString(), inDays(181)]) {
      await expect(bulk(CTX(ws, actor), { action: "snooze", task_ids: [a], reason: "r", snooze_until: bad })).rejects.toBeInstanceOf(ValidationFailedError);
    }
    expect((await row(a)).status).toBe("todo");
    await expect(bulk(CTX(ws, actor), { action: "snooze", task_ids: [a], reason: "r", snooze_until: inDays(179) })).resolves.toMatchObject({ updated: 1 });
  });

  it("re-snoozing a snoozed task moves its date and writes a second event", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const a = await createTask(ws, p);
    await bulk(CTX(ws, actor), { action: "snooze", task_ids: [a], reason: "r", snooze_until: inDays(10) });
    const later = inDays(40);
    const out = await bulk(CTX(ws, actor), { action: "snooze", task_ids: [a], reason: "r", snooze_until: later });
    expect(out.updated).toBe(1);
    expect((await row(a)).resurface_at!.toISOString()).toBe(new Date(later).toISOString());
    expect(await events(a)).toHaveLength(2);
  });

  it("a done task in the batch refuses the whole batch with 409", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const a = await createTask(ws, p); const done = await createTask(ws, p, "done", { completed: true });
    await expect(bulk(CTX(ws, actor), { action: "status", task_ids: [a, done], status: "in_progress" })).rejects.toBeInstanceOf(ConflictError);
    await expect(bulk(CTX(ws, actor), { action: "snooze", task_ids: [done, a], reason: "r", snooze_until: inDays(5) })).rejects.toBeInstanceOf(ConflictError);
    expect((await row(a)).status).toBe("todo");
    expect(await events(a)).toEqual([]);
  });

  it("a mixed batch with an out-of-scope task is refused 403 and the in-scope task is NOT touched (all-or-nothing)", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws);
    const inScope = await createProject(ws); const outScope = await createProject(ws);
    const tIn = await createTask(ws, inScope); const tOut = await createTask(ws, outScope);
    const ctx = CTX(ws, actor, [inScope]);
    await expect(bulk(ctx, { action: "status", task_ids: [tIn, tOut], status: "in_progress" })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    await expect(bulk(ctx, { action: "snooze", task_ids: [tOut, tIn], reason: "r", snooze_until: inDays(5) })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect((await row(tIn)).status).toBe("todo"); expect((await row(tOut)).status).toBe("todo");
    expect(await events(tIn)).toEqual([]); expect(await openCount(inScope)).toBe(1);
    // the same caller may act on a wholly in-scope batch
    await expect(bulk(ctx, { action: "status", task_ids: [tIn], status: "in_progress" })).resolves.toMatchObject({ updated: 1 });
  });

  it("another tenant's task, an unknown id and a soft-deleted task are 404 for the whole batch, never a partial update", async () => {
    const wsA = await createWorkspace(); const wsB = await createWorkspace();
    const actorA = await createUser(wsA); const pA = await createProject(wsA); const pB = await createProject(wsB);
    const mine = await createTask(wsA, pA); const foreign = await createTask(wsB, pB);
    const gone = await createTask(wsA, pA);
    await client.query("UPDATE tasks SET deleted_at = now() WHERE id = $1", [gone]);
    for (const bad of [foreign, randomUUID(), gone]) {
      await expect(bulk(CTX(wsA, actorA), { action: "status", task_ids: [mine, bad], status: "in_progress" })).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await row(mine)).status).toBe("todo");
    expect((await row(foreign)).status).toBe("todo");
  });

  it("two overlapping batches in opposite id order both complete (rows are locked in one order, no deadlock)", async () => {
    const ws = await createWorkspace(); const actor = await createUser(ws); const p = await createProject(ws);
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await createTask(ws, p));
    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.all([
        bulk(CTX(ws, actor), { action: "status", task_ids: ids, status: round % 2 === 0 ? "in_progress" : "todo" }),
        bulk(CTX(ws, actor), { action: "status", task_ids: [...ids].reverse(), status: round % 2 === 0 ? "in_progress" : "todo" }),
      ]);
      expect(results.map((r) => r.updated).reduce((x, y) => x + y, 0)).toBe(ids.length);
    }
    expect(await openCount(p)).toBe(ids.length);
  });
});
