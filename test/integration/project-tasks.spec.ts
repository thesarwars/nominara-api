import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { taskListQuerySchema, type TaskListQuery } from "../../contracts/tasks/index.js";

// STORY-064 (task API, step A) — GET /v1/projects/{id}/tasks, real SQL as the
// real `nominara_app` role (RLS is a dangerous area; a superuser connection
// would pass vacuously). Service seam, same reasoning as action-items.spec.ts.
describe("STORY-064 · TasksService.listProjectTasks — real SQL", () => {
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
  async function createProject(workspaceId: string): Promise<string> {
    seq += 1;
    const r = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, $3, 'https://example.com', $4) RETURNING id`,
      [workspaceId, `Project ${seq}`, `project-${seq}`, `example-${seq}.com`]);
    return r.rows[0]!.id;
  }
  async function createGoal(workspaceId: string, projectId: string, createdAt: string): Promise<string> {
    const r = await client.query<{ id: string }>(
      `INSERT INTO goals (workspace_id, project_id, title, kind, target, created_at)
       VALUES ($1, $2, 'Goal', 'custom', '{}'::jsonb, $3) RETURNING id`, [workspaceId, projectId, createdAt]);
    return r.rows[0]!.id;
  }
  async function createGoalOf(workspaceId: string, projectId: string, createdAt: string, kind: string, target: Record<string, unknown>): Promise<string> {
    const r = await client.query<{ id: string }>(
      `INSERT INTO goals (workspace_id, project_id, title, kind, target, created_at)
       VALUES ($1, $2, 'Goal', $3, $4::jsonb, $5) RETURNING id`, [workspaceId, projectId, kind, JSON.stringify(target), createdAt]);
    return r.rows[0]!.id;
  }
  async function createRule(code: string, trigger: string): Promise<void> {
    await client.query(
      `INSERT INTO task_generation_rules (code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight, effort_band, rule_version)
       VALUES ($1, 'content', 'T', 'D', $2, '{}'::jsonb, 3, 1.0, 'm', 'v1') ON CONFLICT (code) DO NOTHING`, [code, trigger]);
  }
  async function createFinding(workspaceId: string, projectId: string, severity: string): Promise<string> {
    seq += 1;
    await client.query(
      `INSERT INTO aux_rule_catalog (code, category, title, description, rationale, severity_default, weight, rule_version)
       VALUES ('AUX-R-001', 'structured_data', 'T', 'D', 'r', 'high', 0.5, 'v1') ON CONFLICT (code) DO NOTHING`);
    const audit = await client.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer)
       VALUES ($1, $2, 'manual', ARRAY['https://example.com/'], 'v1', 'cl100k') RETURNING id`, [workspaceId, projectId]);
    const r = await client.query<{ id: string }>(
      `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, severity, status, fingerprint, title, evidence, rule_version)
       VALUES ($1, $2, $3, 'AUX-R-001', $4, 'open', $5, 'T', '{}'::jsonb, 'v1') RETURNING id`,
      [workspaceId, projectId, audit.rows[0]!.id, severity, createHash("sha256").update(`f-${seq}`).digest()]);
    return r.rows[0]!.id;
  }

  interface T { impact: number; priority: number; createdAt: string; status: string; goalId: string | null;
    findingId: string | null; deletedAt: Date | null; title: string;
    ruleCode: string | null; engines: string[]; clusterId: string | null }
  async function createTask(workspaceId: string, projectId: string, o: Partial<T> = {}): Promise<string> {
    seq += 1;
    const { impact = 50, priority = 3, createdAt = "2026-08-01T00:00:00Z", status = "todo", goalId = null,
      findingId = null, deletedAt = null, title = `Task ${seq}`, ruleCode = null, engines = [], clusterId = null } = o;
    const r = await client.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status,
          dismissed_reason, resurface_at, impact_score, priority, goal_id, source_finding_id, deleted_at, created_at,
          rule_code, affected_engines, prompt_cluster_id)
       VALUES ($1, $2, $3, 'content', $4, $5, 'D', $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15, $16::text[], $17) RETURNING id`,
      [workspaceId, projectId, `HUB-${seq}`, createHash("sha256").update(`t-${seq}-${randomUUID()}`).digest(), title,
        status, status === "dismissed" ? "noise" : null, status === "dismissed" ? "2027-02-01T00:00:00Z" : null,
        impact, priority, goalId, findingId, deletedAt, createdAt, ruleCode, engines, clusterId]);
    return r.rows[0]!.id;
  }

  const CTX = (workspaceId: string, scope?: readonly string[]): TenantContext => ({
    workspaceId, actorId: randomUUID(), ...(scope !== undefined ? { scopeProjectIds: scope } : {}),
  });
  const Q = (q: Record<string, unknown> = {}): TaskListQuery => taskListQuerySchema.parse(q);
  const list = (ctx: TenantContext, projectId: string, q: Record<string, unknown> = {}) =>
    inTenant(ctx, () => service.listProjectTasks(projectId, Q(q)));

  it("[STORY-064 #1] orders by impact_score DESC by default, priority then age breaking ties", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const low = await createTask(ws, p, { impact: 10 });
    const high = await createTask(ws, p, { impact: 90 });
    const tieLowPrio = await createTask(ws, p, { impact: 50, priority: 2 });
    const tieHighPrio = await createTask(ws, p, { impact: 50, priority: 5 });
    const page = await list(CTX(ws), p);
    expect(page.items.map((i) => i.id)).toEqual([high, tieHighPrio, tieLowPrio, low]);
  });

  it("[STORY-064 #2] sort=priority orders priority DESC then impact DESC", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const a = await createTask(ws, p, { priority: 1, impact: 99 });
    const b = await createTask(ws, p, { priority: 5, impact: 10 });
    const c = await createTask(ws, p, { priority: 5, impact: 60 });
    const page = await list(CTX(ws), p, { sort: "priority" });
    expect(page.items.map((i) => i.id)).toEqual([c, b, a]);
  });

  it("[STORY-064 #2] sort=age orders oldest first, id breaking an exact tie", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const newer = await createTask(ws, p, { createdAt: "2026-09-01T00:00:00Z", impact: 99 });
    const older = await createTask(ws, p, { createdAt: "2026-07-01T00:00:00Z", impact: 1 });
    const page = await list(CTX(ws), p, { sort: "age" });
    expect(page.items.map((i) => i.id)).toEqual([older, newer]);
  });

  it("[STORY-064 #2] sort=goal puts goal-linked tasks first, grouped by goal, impact DESC within, unlinked last", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const g1 = await createGoal(ws, p, "2026-01-01T00:00:00Z");
    const g2 = await createGoal(ws, p, "2026-02-01T00:00:00Z");
    const unlinked = await createTask(ws, p, { impact: 100 });
    const g2low = await createTask(ws, p, { goalId: g2, impact: 5 });
    const g1low = await createTask(ws, p, { goalId: g1, impact: 20 });
    const g1high = await createTask(ws, p, { goalId: g1, impact: 80 });
    const page = await list(CTX(ws), p, { sort: "goal" });
    expect(page.items.map((i) => i.id)).toEqual([g1high, g1low, g2low, unlinked]);
  });

  // ---- STORY-065 AC4/AC5 — contribution ordering inside a goal ------------------------------------------------
  //
  // "Contribution ordering uses the task's impact score relative to the goal's metric, so a task irrelevant to the goal ranks low
  // even if its absolute impact is high." TIERED (planner recommendation): inside a goal, tasks whose rule feeds the goal's metric
  // — and whose engine / cluster scope the goal covers — come first, by impact; everything else follows, by impact.
  describe("STORY-065 · contribution ordering (sort=goal)", () => {
    const VIS = { metric: "visibility_score", target_value: 60 };

    it("[STORY-065 #5] a high-impact task irrelevant to the goal ranks BELOW a lower-impact task that feeds the goal's metric", async () => {
      const ws = await createWorkspace(); const p = await createProject(ws);
      await createRule("TG-SOV", "sov_drop"); await createRule("TG-AUX", "aux_finding");
      const g = await createGoalOf(ws, p, "2026-01-01T00:00:00Z", "engine_score", VIS);
      const irrelevantHigh = await createTask(ws, p, { goalId: g, impact: 95, ruleCode: "TG-AUX" });
      const manual = await createTask(ws, p, { goalId: g, impact: 90 }); // no rule: no metric to contribute to
      const relevantLow = await createTask(ws, p, { goalId: g, impact: 20, ruleCode: "TG-SOV" });
      const relevantMid = await createTask(ws, p, { goalId: g, impact: 60, ruleCode: "TG-SOV" });
      const page = await list(CTX(ws), p, { sort: "goal" });
      expect(page.items.map((i) => i.id)).toEqual([relevantMid, relevantLow, irrelevantHigh, manual]);
    });

    it("[STORY-065 #4] grouping by goal is kept: every task of the older goal precedes the newer goal's, contribution orders within each, unlinked last", async () => {
      const ws = await createWorkspace(); const p = await createProject(ws);
      await createRule("TG-SOV", "sov_drop"); await createRule("TG-SENT", "sentiment_negative");
      const g1 = await createGoalOf(ws, p, "2026-01-01T00:00:00Z", "engine_score", VIS);
      const g2 = await createGoalOf(ws, p, "2026-02-01T00:00:00Z", "sentiment_recovery", { metric: "sentiment_score", target_value: 60 });
      const unlinked = await createTask(ws, p, { impact: 100, ruleCode: "TG-SOV" });
      const g2irrelevant = await createTask(ws, p, { goalId: g2, impact: 80, ruleCode: "TG-SOV" });
      const g2relevant = await createTask(ws, p, { goalId: g2, impact: 10, ruleCode: "TG-SENT" });
      const g1irrelevant = await createTask(ws, p, { goalId: g1, impact: 70, ruleCode: "TG-SENT" });
      const g1relevant = await createTask(ws, p, { goalId: g1, impact: 5, ruleCode: "TG-SOV" });
      const page = await list(CTX(ws), p, { sort: "goal" });
      expect(page.items.map((i) => i.id)).toEqual([g1relevant, g1irrelevant, g2relevant, g2irrelevant, unlinked]);
    });

    it("an engine-scoped goal counts a task that affects its engine or every engine, not one that affects only another engine", async () => {
      const ws = await createWorkspace(); const p = await createProject(ws);
      await createRule("TG-SOV", "sov_drop");
      const g = await createGoalOf(ws, p, "2026-01-01T00:00:00Z", "engine_score", { ...VIS, engine_key: "gemini" });
      const otherEngine = await createTask(ws, p, { goalId: g, impact: 80, ruleCode: "TG-SOV", engines: ["chatgpt"] });
      const projectWide = await createTask(ws, p, { goalId: g, impact: 20, ruleCode: "TG-SOV", engines: [] });
      const includes = await createTask(ws, p, { goalId: g, impact: 40, ruleCode: "TG-SOV", engines: ["chatgpt", "gemini"] });
      const page = await list(CTX(ws), p, { sort: "goal" });
      expect(page.items.map((i) => i.id)).toEqual([includes, projectWide, otherEngine]);
    });

    it("a cluster-scoped goal counts a task of its cluster or of no cluster, not one tied to another cluster", async () => {
      const ws = await createWorkspace(); const p = await createProject(ws);
      await createRule("TG-PRES", "presence_loss");
      const mine = randomUUID(); const theirs = randomUUID();
      const g = await createGoalOf(ws, p, "2026-01-01T00:00:00Z", "prompt_recommendation", { metric: "presence_rate", target_value: 50, prompt_cluster_id: mine });
      const other = await createTask(ws, p, { goalId: g, impact: 90, ruleCode: "TG-PRES", clusterId: theirs });
      const none = await createTask(ws, p, { goalId: g, impact: 10, ruleCode: "TG-PRES", clusterId: null });
      const same = await createTask(ws, p, { goalId: g, impact: 30, ruleCode: "TG-PRES", clusterId: mine });
      const page = await list(CTX(ws), p, { sort: "goal" });
      expect(page.items.map((i) => i.id)).toEqual([same, none, other]);
    });

    it("each metric is fed by its own rules: a citation goal counts citation_gap and source_absence, not sov_drop; a rendering goal counts render_downgrade and aux_finding", async () => {
      const ws = await createWorkspace(); const p = await createProject(ws);
      await createRule("TG-CIT", "citation_gap"); await createRule("TG-SRC", "source_absence"); await createRule("TG-SOV", "sov_drop");
      await createRule("TG-REN", "render_downgrade"); await createRule("TG-AUX", "aux_finding");
      const gc = await createGoalOf(ws, p, "2026-01-01T00:00:00Z", "citation_presence", { metric: "citation_share", target_value: 50 });
      const gr = await createGoalOf(ws, p, "2026-02-01T00:00:00Z", "rendering_quality", { metric: "rendering_quality", target_value: 50 });
      const cSov = await createTask(ws, p, { goalId: gc, impact: 99, ruleCode: "TG-SOV" });
      const cCit = await createTask(ws, p, { goalId: gc, impact: 10, ruleCode: "TG-CIT" });
      const cSrc = await createTask(ws, p, { goalId: gc, impact: 20, ruleCode: "TG-SRC" });
      const rSov = await createTask(ws, p, { goalId: gr, impact: 99, ruleCode: "TG-SOV" });
      const rAux = await createTask(ws, p, { goalId: gr, impact: 10, ruleCode: "TG-AUX" });
      const rRen = await createTask(ws, p, { goalId: gr, impact: 30, ruleCode: "TG-REN" });
      const page = await list(CTX(ws), p, { sort: "goal" });
      expect(page.items.map((i) => i.id)).toEqual([cSrc, cCit, cSov, rRen, rAux, rSov]);
    });

    it("a goal with no recognisable metric (an older goal, an empty target) orders its tasks by impact alone, as before", async () => {
      const ws = await createWorkspace(); const p = await createProject(ws);
      await createRule("TG-SOV", "sov_drop");
      const g = await createGoalOf(ws, p, "2026-01-01T00:00:00Z", "custom", {});
      const low = await createTask(ws, p, { goalId: g, impact: 5, ruleCode: "TG-SOV" });
      const high = await createTask(ws, p, { goalId: g, impact: 80 });
      const page = await list(CTX(ws), p, { sort: "goal" });
      expect(page.items.map((i) => i.id)).toEqual([high, low]);
    });

    it("contribution ordering pages without skipping or repeating a row (limit 2, ties across tiers)", async () => {
      const ws = await createWorkspace(); const p = await createProject(ws);
      await createRule("TG-SOV", "sov_drop"); await createRule("TG-AUX", "aux_finding");
      const g = await createGoalOf(ws, p, "2026-01-01T00:00:00Z", "engine_score", VIS);
      for (let i = 0; i < 9; i++) {
        await createTask(ws, p, { goalId: g, impact: (i % 3) * 10, ruleCode: i % 2 === 0 ? "TG-SOV" : "TG-AUX", createdAt: `2026-08-0${(i % 2) + 1}T00:00:00Z` });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 12; guard++) {
        const page = await list(CTX(ws), p, { sort: "goal", limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((i) => i.id));
        if (!page.pagination.has_more) break;
        cursor = page.pagination.cursor_next!;
      }
      const full = (await list(CTX(ws), p, { sort: "goal" })).items.map((i) => i.id);
      expect(seen).toEqual(full);
      expect(new Set(seen).size).toBe(9);
    });
  });

  it("paginates every sort without skipping or repeating a row (limit 2, 7 tasks with ties)", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const g = await createGoal(ws, p, "2026-01-01T00:00:00Z");
    for (let i = 0; i < 7; i++) {
      await createTask(ws, p, { impact: i % 3 * 10, priority: (i % 5) + 1, goalId: i % 2 === 0 ? g : null,
        createdAt: `2026-08-0${(i % 2) + 1}T00:00:00Z` });
    }
    for (const sort of ["impact", "priority", "age", "goal"]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await list(CTX(ws), p, { sort, limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((i) => i.id));
        if (!page.pagination.has_more) break;
        cursor = page.pagination.cursor_next!;
      }
      const full = (await list(CTX(ws), p, { sort })).items.map((i) => i.id);
      expect(seen, sort).toEqual(full);
      expect(new Set(seen).size, sort).toBe(7);
    }
  });

  it("status filter narrows; omitted returns all four statuses; soft-deleted rows never appear", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    for (const status of ["todo", "in_progress", "done", "dismissed"]) await createTask(ws, p, { status });
    await createTask(ws, p, { deletedAt: new Date() });
    expect((await list(CTX(ws), p)).items).toHaveLength(4);
    const dismissed = (await list(CTX(ws), p, { status: "dismissed" })).items;
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]!.dismissed_reason).toBe("noise");
    expect(dismissed[0]!.resurface_at).not.toBeNull();
  });

  it("only returns tasks of the requested project", async () => {
    const ws = await createWorkspace(); const p1 = await createProject(ws); const p2 = await createProject(ws);
    const mine = await createTask(ws, p1); await createTask(ws, p2);
    expect((await list(CTX(ws), p1)).items.map((i) => i.id)).toEqual([mine]);
  });

  it("empty project yields an empty page, not an error", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const page = await list(CTX(ws), p);
    expect(page.items).toEqual([]);
    expect(page.pagination.has_more).toBe(false);
  });

  it("derives severity from the finding, and null (not 'none') when there is no signal", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const withFinding = await createTask(ws, p, { findingId: await createFinding(ws, p, "high"), impact: 80 });
    const info = await createTask(ws, p, { findingId: await createFinding(ws, p, "info"), impact: 60 });
    const bare = await createTask(ws, p, { impact: 10 });
    const items = (await list(CTX(ws), p)).items;
    expect(items.find((i) => i.id === withFinding)!.severity).toBe("high");
    expect(items.find((i) => i.id === withFinding)!.source).toBe("aux");
    expect(items.find((i) => i.id === info)!.severity).toBeNull();
    expect(items.find((i) => i.id === bare)!.severity).toBeNull();
    expect(items.find((i) => i.id === bare)!.source).toBe("content");
  });

  it("[STORY-064 #12] a project-scoped caller sees an in-scope project's tasks and gets 404 for an out-of-scope project", async () => {
    const ws = await createWorkspace(); const inScope = await createProject(ws); const outScope = await createProject(ws);
    const mine = await createTask(ws, inScope); await createTask(ws, outScope);
    const ctx = CTX(ws, [inScope]);
    expect((await list(ctx, inScope)).items.map((i) => i.id)).toEqual([mine]);
    await expect(list(ctx, outScope)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404, not 403 or an empty list, for another tenant's project", async () => {
    const wsA = await createWorkspace(); const wsB = await createWorkspace();
    const foreign = await createProject(wsB); await createTask(wsB, foreign);
    await expect(list(CTX(wsA), foreign)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404 for a soft-deleted or nonexistent project", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    await client.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [p]);
    await expect(list(CTX(ws), p)).rejects.toBeInstanceOf(NotFoundError);
    await expect(list(CTX(ws), randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});
