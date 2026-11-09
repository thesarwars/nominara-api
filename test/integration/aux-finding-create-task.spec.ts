import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { taskFingerprint } from "../../src/lib/taskgen/fingerprint.js";
import { AuxService } from "../../src/modules/aux/aux.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { ProjectOutOfScopeException } from "../../src/tenancy/errors.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { taskSchema } from "../../contracts/tasks/index.js";

// POST /v1/aux-findings/{id}/create-task (STORY-194 AC5, api-specification.md "AUX"): a manual promotion of a finding to a task,
// through the ONE task-insert path (TasksService.createGeneratedTask), real SQL as `nominara_app` under RLS.
// Hazards: a second task for the same finding or fingerprint; a task that duplicates the rule-generated one; another
// tenant's finding; a scoped caller outside the project.
describe("STORY-194 AC5 · finding create-task", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;
  const exporter = new InMemorySpanExporter();
  const tasks = new TasksService(new NoopRealtimePublisher());
  const service = new AuxService(undefined, undefined, tasks);

  beforeAll(async () => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
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
    exporter.reset();
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
  const CTX = (workspaceId: string, actorId: string, scope?: string[]): TenantContext => ({ workspaceId, actorId, ...(scope === undefined ? {} : { scopeProjectIds: scope }) });

  async function createWorkspace(): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'business') RETURNING id", [`Workspace ${seq}`, `workspace-${seq}-${randomUUID()}`])).rows[0]!.id;
  }
  async function createUser(): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u${seq}-${randomUUID()}@example.com`])).rows[0]!.id;
  }
  async function createProject(workspaceId: string): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, $3, 'https://example.com', $4) RETURNING id`,
      [workspaceId, `Project ${seq}`, `project-${seq}`, `example-${seq}.com`])).rows[0]!.id;
  }
  async function createFinding(ws: string, project: string, ruleCode = "AUX-R-001", over: { status?: string; url?: string | null } = {}): Promise<{ id: string; fingerprint: Buffer }> {
    const audit = (await client.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer)
       VALUES ($1, $2, 'manual', ARRAY['https://example.com/'], 'v1', 'none') RETURNING id`, [ws, project])).rows[0]!.id;
    seq += 1;
    const fingerprint = createHash("sha256").update(`finding-${seq}-${randomUUID()}`).digest();
    const id = (await client.query<{ id: string }>(
      `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, severity, status, fingerprint, title, url, evidence, rule_version)
       VALUES ($1, $2, $3, $4, 'medium', $5, $6, 'robots.txt blocks a crawler', $7, '{}'::jsonb, 'v1') RETURNING id`,
      [ws, project, audit, ruleCode, over.status ?? "open", fingerprint, over.url === undefined ? "https://example.com/robots.txt" : over.url])).rows[0]!.id;
    return { id, fingerprint };
  }
  const promote = (ctx: TenantContext, findingId: string) => inTenant(ctx, () => service.createTaskFromFinding(findingId));
  const taskRows = async (project: string) => (await client.query("SELECT * FROM tasks WHERE project_id = $1 ORDER BY created_at", [project])).rows;

  it("[STORY-194 AC5] FT-1 promotes a finding: a todo manual task linked to the finding, carrying its title, URL and project, with a created event", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const project = await createProject(ws);
    const finding = await createFinding(ws, project);
    const task = await promote(CTX(ws, actor), finding.id);
    expect(taskSchema.safeParse(task).success).toBe(true);
    expect(task).toMatchObject({ project_id: project, origin: "manual", status: "todo", title: "robots.txt blocks a crawler", affected_url: "https://example.com/robots.txt", kind: "technical" });
    expect((await client.query("SELECT source_finding_id FROM tasks WHERE id = $1", [task.id])).rows[0].source_finding_id).toBe(finding.id);
    const events = await client.query("SELECT event, actor_id, actor_type FROM task_events WHERE task_id = $1", [task.id]);
    expect(events.rows).toEqual([{ event: "created", actor_id: actor, actor_type: "user" }]);
  });

  it("[STORY-194 AC5] FT-2 promoting the same finding twice returns the same task, writes no second row and consumes no reference", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const project = await createProject(ws);
    const finding = await createFinding(ws, project);
    const first = await promote(CTX(ws, actor), finding.id);
    const second = await promote(CTX(ws, actor), finding.id);
    expect(second.id).toBe(first.id);
    expect(await taskRows(project)).toHaveLength(1);
    expect((await client.query("SELECT count(*)::int AS n FROM task_events WHERE task_id = $1", [first.id])).rows[0].n).toBe(1);
    const next = await promote(CTX(ws, actor), (await createFinding(ws, project, "AUX-R-005")).id);
    expect(Number(next.short_ref.split("-").pop())).toBe(Number(first.short_ref.split("-").pop()) + 1);
  });

  it("[STORY-194 AC5] FT-3 does not duplicate an auto task with the finding's fingerprint: the rule's task is returned", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const project = await createProject(ws);
    const finding = await createFinding(ws, project, "AUX-R-001");
    const auto = await inTenant(CTX(ws, actor), () => tasks.createGeneratedTask({
      projectId: project, kind: "technical", origin: "auto", ruleCode: "TG-AUX-R-001",
      fingerprint: taskFingerprint("TG-AUX-R-001", project, finding.fingerprint.toString("hex")),
      title: "Fix: robots.txt blocks a crawler", description: "d", sourceDisplacementId: null, sourceDomainId: null, affectedUrl: null,
      generation: { sourceFindingId: finding.id, systemActor: true },
    }));
    const promoted = await promote(CTX(ws, actor), finding.id);
    expect(promoted.id).toBe(auto.task.id);
    expect(promoted.origin).toBe("auto");
    expect(await taskRows(project)).toHaveLength(1);
  });

  it("[STORY-194 AC5] FT-4 a manual promotion of a rule-covered finding takes the rule's fingerprint, so the generator finds it and makes no second task", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const project = await createProject(ws);
    const finding = await createFinding(ws, project, "AUX-R-001");
    await promote(CTX(ws, actor), finding.id);
    const row = (await taskRows(project))[0];
    expect(row.rule_code).toBe("TG-AUX-R-001");
    expect(Buffer.from(row.dedupe_fingerprint).equals(taskFingerprint("TG-AUX-R-001", project, finding.fingerprint.toString("hex")))).toBe(true);
    expect(row.source_finding_id).toBe(finding.id);
  });

  it("[STORY-194 AC5] FT-5 a finding whose rule has no generation rule still promotes, with no rule code, and still dedupes", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const project = await createProject(ws);
    const finding = await createFinding(ws, project, "AUX-R-005");
    const a = await promote(CTX(ws, actor), finding.id);
    const b = await promote(CTX(ws, actor), finding.id);
    expect(b.id).toBe(a.id);
    const rows = await taskRows(project);
    expect(rows).toHaveLength(1);
    expect(rows[0].rule_code).toBeNull();
  });

  it("[STORY-194 AC5] FT-6 after the task is done a new promotion makes a new task (the dedupe is over open tasks)", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const project = await createProject(ws);
    const finding = await createFinding(ws, project);
    const first = await promote(CTX(ws, actor), finding.id);
    await client.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1", [first.id]);
    const second = await promote(CTX(ws, actor), finding.id);
    expect(second.id).not.toBe(first.id);
    expect(await taskRows(project)).toHaveLength(2);
  });

  it("[STORY-194 AC5] FT-7 a finding with no URL promotes with a null affected_url", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const project = await createProject(ws);
    const finding = await createFinding(ws, project, "AUX-R-005", { url: null });
    expect((await promote(CTX(ws, actor), finding.id)).affected_url).toBeNull();
  });

  it("[STORY-194 AC5] FT-8 an unknown finding, another workspace's finding and a deleted project's finding are 404 and write nothing", async () => {
    const ws = await createWorkspace(); const other = await createWorkspace(); const actor = await createUser();
    const project = await createProject(ws); const otherProject = await createProject(other);
    const theirs = await createFinding(other, otherProject);
    await expect(promote(CTX(ws, actor), randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(promote(CTX(ws, actor), theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    const mine = await createFinding(ws, project);
    await client.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [project]);
    await expect(promote(CTX(ws, actor), mine.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await client.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n).toBe(0);
  });

  it("[STORY-194 AC5] FT-9 a caller scoped away from the finding's project is refused 403 and nothing is written", async () => {
    const ws = await createWorkspace(); const actor = await createUser();
    const project = await createProject(ws); const elsewhere = await createProject(ws);
    const finding = await createFinding(ws, project);
    await expect(promote(CTX(ws, actor, [elsewhere]), finding.id)).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect(await taskRows(project)).toHaveLength(0);
    expect((await promote(CTX(ws, actor, [project]), finding.id)).project_id).toBe(project);
  });

  it("[STORY-194 AC5] FT-10 two concurrent promotions of one finding make one task", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const project = await createProject(ws);
    const finding = await createFinding(ws, project);
    const [a, b] = await Promise.all([promote(CTX(ws, actor), finding.id), promote(CTX(ws, actor), finding.id)]);
    expect(a.id).toBe(b.id);
    expect(await taskRows(project)).toHaveLength(1);
  });

  it("[STORY-194 AC5] FT-11 emits a span, a metric and a log line with the workspace id and no finding text", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const project = await createProject(ws);
    const finding = await createFinding(ws, project);
    const logs: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(message));
    try { await promote(CTX(ws, actor), finding.id); await promote(CTX(ws, actor), finding.id); } finally { spy.mockRestore(); }
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain("aux.create_task_from_finding");
    expect(logs).toContainEqual(expect.objectContaining({ metric: "nominara_aux_finding_tasks_total", outcome: "created" }));
    expect(logs).toContainEqual(expect.objectContaining({ metric: "nominara_aux_finding_tasks_total", outcome: "existing" }));
    const line = logs.find((l) => (l as { message?: string }).message === "aux finding promoted to task") as Record<string, unknown>;
    expect(line).toMatchObject({ workspace_id: ws, finding_id: finding.id, task_id: expect.any(String) });
    expect(JSON.stringify(line)).not.toContain("robots.txt");
  });
});
