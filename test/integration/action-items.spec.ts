import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import type { PaginationRequest } from "../../contracts/common/pagination.schema.js";

// STORY-169 (API step 2/3) — GET /v1/workspaces/{id}/action-items, real SQL.
// RLS and tenant context are one of the four dangerous areas
// (development-workflow.md) — connects as the ACTUAL `nominara_app` runtime
// role, never the superuser fixture connection, exactly like
// generated-rls-and-tenant-context.spec.ts's own documented reason: a
// Postgres superuser bypasses RLS by a different mechanism than FORCE ROW
// LEVEL SECURITY addresses, so asserting against the superuser client would
// pass vacuously.
//
// At the SERVICE seam, not over HTTP — same reasoning as
// test/integration/list-pagination.spec.ts: the property under test is the
// query (scope predicate, ordering, severity derivation, pagination), and
// driving it through the full composition root would add a container per
// test and prove nothing more about the thing that can actually be wrong.
describe("STORY-169 · TasksService.listActionItems — real SQL", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client; // superuser — fixture setup and catalog seeding ONLY
  let seq = 0;

  const service = new TasksService();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

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
      const password = resolvePassword(role, {});
      await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(password)}`);
    }
  });

  afterEach(async () => {
    await client.end();
  });

  // ---- helpers ----------------------------------------------------------

  async function openAppConnection(): Promise<Client> {
    const c = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
    });
    await c.connect();
    return c;
  }

  /** Runs `fn` inside a real tenant transaction, as `nominara_app` — the role the query actually runs as in production. */
  async function inTenant<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
    const app = await openAppConnection();
    try {
      return await withTenantContext(app, context, fn);
    } finally {
      await app.end();
    }
  }

  async function createWorkspace(): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'business') RETURNING id",
      [`Workspace ${seq}`, `workspace-${seq}-${randomUUID()}`],
    );
    return result.rows[0]!.id;
  }

  async function createProject(
    workspaceId: string,
    overrides: Partial<{ name: string; deletedAt: Date | null }> = {},
  ): Promise<string> {
    seq += 1;
    const { name = `Project ${seq}`, deletedAt = null } = overrides;
    const result = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, deleted_at)
       VALUES ($1, $2, $3, 'https://example.com', $4, $5)
       RETURNING id`,
      [workspaceId, name, `${name.toLowerCase().replace(/\s+/g, "-")}-${seq}`, `example-${seq}.com`, deletedAt],
    );
    return result.rows[0]!.id;
  }

  async function createAuxRule(code: string): Promise<void> {
    await client.query(
      `INSERT INTO aux_rule_catalog
         (code, category, title, description, rationale, severity_default, weight, rule_version)
       VALUES ($1, 'structured_data', 'Title', 'Description', 'engines cannot show your price', 'high', 0.5, 'v1')
       ON CONFLICT (code) DO NOTHING`,
      [code],
    );
  }

  async function createTaskGenerationRule(code: string): Promise<void> {
    await client.query(
      `INSERT INTO task_generation_rules
         (code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight, effort_band, rule_version)
       VALUES ($1, 'content', 'Title {{x}}', 'Description {{x}}', 'sov_drop', '{}'::jsonb, 3, 1.0, 'm', 'v1')
       ON CONFLICT (code) DO NOTHING`,
      [code],
    );
  }

  async function createAuxAudit(workspaceId: string, projectId: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer)
       VALUES ($1, $2, 'manual', ARRAY['https://example.com/'], 'v1', 'cl100k')
       RETURNING id`,
      [workspaceId, projectId],
    );
    return result.rows[0]!.id;
  }

  async function createAuxFinding(
    workspaceId: string,
    projectId: string,
    overrides: Partial<{ severity: string; ruleCode: string }> = {},
  ): Promise<string> {
    seq += 1;
    const { severity = "critical", ruleCode = "AUX-R-001" } = overrides;
    await createAuxRule(ruleCode);
    const auditId = await createAuxAudit(workspaceId, projectId);
    const result = await client.query<{ id: string }>(
      `INSERT INTO aux_findings
         (workspace_id, project_id, audit_id, rule_code, severity, status, fingerprint, title, evidence, rule_version)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, 'Title', '{}'::jsonb, 'v1')
       RETURNING id`,
      [workspaceId, projectId, auditId, ruleCode, severity, createHash("sha256").update(`finding-${seq}`).digest()],
    );
    return result.rows[0]!.id;
  }

  async function createSourceDomain(workspaceId: string): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      `INSERT INTO source_domains (workspace_id, domain) VALUES ($1, $2) RETURNING id`,
      [workspaceId, `source-${seq}.example.com`],
    );
    return result.rows[0]!.id;
  }

  /** `engine_key='all'`, `window_days=30` — the exact "current" reading TasksService reads. */
  async function createSourceIndexRow(
    workspaceId: string,
    projectId: string,
    sourceDomainId: string,
    gapSeverity: string | null,
    windowStart = "2026-08-01",
  ): Promise<void> {
    await client.query(
      `INSERT INTO project_source_index
         (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, gap_severity)
       VALUES ($1, $2, $3, 'all', $4, 30, $5)`,
      [workspaceId, projectId, sourceDomainId, windowStart, gapSeverity],
    );
  }

  interface TaskOverrides {
    shortRef: string;
    dedupeFingerprint: Buffer;
    status: string;
    deletedAt: Date | null;
    kind: string;
    impactScore: number;
    effortBand: string;
    ruleCode: string | null;
    sourceFindingId: string | null;
    sourceDomainId: string | null;
    sourceDisplacementId: string | null;
    playbookSlug: string | null;
    createdAt: string | null;
    title: string;
  }

  async function createTask(
    workspaceId: string,
    projectId: string,
    overrides: Partial<TaskOverrides> = {},
  ): Promise<string> {
    seq += 1;
    const {
      shortRef = `HUB-${seq}`,
      dedupeFingerprint = createHash("sha256").update(`fp-${seq}-${randomUUID()}`).digest(),
      status = "todo",
      deletedAt = null,
      kind = "content",
      impactScore = 50,
      effortBand = "m",
      ruleCode = null,
      sourceFindingId = null,
      sourceDomainId = null,
      sourceDisplacementId = null,
      playbookSlug = null,
      createdAt = null,
      title = `Task ${seq}`,
    } = overrides;
    if (ruleCode !== null) await createTaskGenerationRule(ruleCode);
    const result = await client.query<{ id: string }>(
      `INSERT INTO tasks
         (workspace_id, project_id, short_ref, kind, rule_code, dedupe_fingerprint, title, description, status,
          deleted_at, impact_score, effort_band, source_finding_id, source_domain_id, source_displacement_id,
          playbook_slug, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Description', $8, $9, $10, $11, $12, $13, $14, $15,
               COALESCE($16::timestamptz, now()))
       RETURNING id`,
      [
        workspaceId,
        projectId,
        shortRef,
        kind,
        ruleCode,
        dedupeFingerprint,
        title,
        status,
        deletedAt,
        impactScore,
        effortBand,
        sourceFindingId,
        sourceDomainId,
        sourceDisplacementId,
        playbookSlug,
        createdAt,
      ],
    );
    return result.rows[0]!.id;
  }

  const CTX = (workspaceId: string, scopeProjectIds?: readonly string[]): TenantContext => ({
    workspaceId,
    actorId: randomUUID(),
    ...(scopeProjectIds !== undefined ? { scopeProjectIds } : {}),
  });

  async function listAll(context: TenantContext, pagination: PaginationRequest = { limit: 50 } as PaginationRequest) {
    return inTenant(context, () => service.listActionItems(pagination));
  }

  // ---- ordering -----------------------------------------------------------

  it("orders impact DESC, then severity rank, then age (FR-GD-02 — reference over STORY-089's prose)", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);

    // Same impact (50): severity should break the tie, critical first.
    const lowSeverityFinding = await createAuxFinding(workspaceId, projectId, { severity: "low", ruleCode: "AUX-LOW" });
    const criticalFinding = await createAuxFinding(workspaceId, projectId, { severity: "critical", ruleCode: "AUX-CRIT" });
    const tiedLow = await createTask(workspaceId, projectId, { impactScore: 50, sourceFindingId: lowSeverityFinding, title: "tied-low" });
    const tiedCritical = await createTask(workspaceId, projectId, { impactScore: 50, sourceFindingId: criticalFinding, title: "tied-critical" });
    const highest = await createTask(workspaceId, projectId, { impactScore: 90, title: "highest-impact" });
    const lowest = await createTask(workspaceId, projectId, { impactScore: 10, title: "lowest-impact" });

    const page = await listAll(CTX(workspaceId));
    const ids = page.items.map((i) => i.id);

    expect(ids.indexOf(highest)).toBe(0);
    expect(ids.indexOf(tiedCritical)).toBeLessThan(ids.indexOf(tiedLow));
    expect(ids.indexOf(tiedLow)).toBeLessThan(ids.indexOf(lowest));
    expect(ids.indexOf(lowest)).toBe(ids.length - 1);
  });

  it("breaks a full tie (same impact, same severity) by age — older (earlier created_at) first", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const older = await createTask(workspaceId, projectId, { impactScore: 40, createdAt: "2026-08-01T00:00:00Z", title: "older" });
    const newer = await createTask(workspaceId, projectId, { impactScore: 40, createdAt: "2026-08-02T00:00:00Z", title: "newer" });

    const page = await listAll(CTX(workspaceId));
    const ids = page.items.map((i) => i.id);
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
  });

  // ---- severity derivation --------------------------------------------------

  describe("severity derivation", () => {
    it("aux_findings.severity via source_finding_id takes precedence over project_source_index.gap_severity", async () => {
      const workspaceId = await createWorkspace();
      const projectId = await createProject(workspaceId);
      const findingId = await createAuxFinding(workspaceId, projectId, { severity: "high" });
      const sourceDomainId = await createSourceDomain(workspaceId);
      await createSourceIndexRow(workspaceId, projectId, sourceDomainId, "low");

      const taskId = await createTask(workspaceId, projectId, { sourceFindingId: findingId, sourceDomainId });

      const page = await listAll(CTX(workspaceId));
      expect(page.items.find((i) => i.id === taskId)!.severity).toBe("high");
    });

    it("falls back to project_source_index.gap_severity via source_domain_id when no finding is linked", async () => {
      const workspaceId = await createWorkspace();
      const projectId = await createProject(workspaceId);
      const sourceDomainId = await createSourceDomain(workspaceId);
      await createSourceIndexRow(workspaceId, projectId, sourceDomainId, "medium");

      const taskId = await createTask(workspaceId, projectId, { sourceDomainId });

      const page = await listAll(CTX(workspaceId));
      expect(page.items.find((i) => i.id === taskId)!.severity).toBe("medium");
    });

    it("maps gap_severity = 'none' to null, never leaking the literal onto the wire", async () => {
      const workspaceId = await createWorkspace();
      const projectId = await createProject(workspaceId);
      const sourceDomainId = await createSourceDomain(workspaceId);
      await createSourceIndexRow(workspaceId, projectId, sourceDomainId, "none");

      const taskId = await createTask(workspaceId, projectId, { sourceDomainId });

      const page = await listAll(CTX(workspaceId));
      expect(page.items.find((i) => i.id === taskId)!.severity).toBeNull();
    });

    it("maps aux_findings.severity = 'info' to null — 'info' is a valid CHECK value but outside the 4-member contract enum", async () => {
      // The exact review violation: aux_findings.severity allows 'info'
      // (schemas/aux-and-geo-analysis.md), which is not one of the
      // contract's critical|high|medium|low. Before the fix this leaked
      // "info" straight onto the wire, and a strict client parse of the
      // page rejected the whole response.
      const workspaceId = await createWorkspace();
      const projectId = await createProject(workspaceId);
      const findingId = await createAuxFinding(workspaceId, projectId, { severity: "info" });

      const taskId = await createTask(workspaceId, projectId, { sourceFindingId: findingId });

      const page = await listAll(CTX(workspaceId));
      expect(page.items.find((i) => i.id === taskId)!.severity).toBeNull();
    });

    it("is null when the task derives neither (a manual task with no source link)", async () => {
      const workspaceId = await createWorkspace();
      const projectId = await createProject(workspaceId);
      const taskId = await createTask(workspaceId, projectId, {});

      const page = await listAll(CTX(workspaceId));
      expect(page.items.find((i) => i.id === taskId)!.severity).toBeNull();
    });
  });

  // ---- primary_action derivation — real SQL, not a mocked-row unit test -----
  //
  // The unit tests in tasks.service.spec.ts drive `derivePrimaryAction`
  // through a mocked pg client's rows, never through a real query. This
  // pins the SAME documented precedence (contracts/tasks/action-item-
  // response.schema.ts's `target` .describe(): playbook_slug checked FIRST,
  // even when the task also carries a finding or displacement id) against
  // rows `listActionItems` actually reads off disk.

  describe("primary_action derivation — real SQL", () => {
    it("open_playbook wins over a finding id when a task carries BOTH (an authority task an AUX finding recommended)", async () => {
      const workspaceId = await createWorkspace();
      const projectId = await createProject(workspaceId);
      const findingId = await createAuxFinding(workspaceId, projectId, { severity: "high" });
      const taskId = await createTask(workspaceId, projectId, {
        sourceFindingId: findingId,
        playbookSlug: "reddit-seeding",
      });

      const page = await listAll(CTX(workspaceId));
      const item = page.items.find((i) => i.id === taskId)!;
      expect(item.primary_action).toEqual({ kind: "open_playbook", target: "reddit-seeding" });
      // Still traced back to the AUX finding on `source`, even though the
      // primary action is the playbook — these are independent fields.
      expect(item.source).toBe("aux");
    });

    it("open_playbook wins over a displacement id when a task carries both", async () => {
      const workspaceId = await createWorkspace();
      const projectId = await createProject(workspaceId);
      const taskId = await createTask(workspaceId, projectId, {
        sourceDisplacementId: "0195e5b7-0000-7000-8000-0000000000e1",
        playbookSlug: "authority-backlink",
      });

      const page = await listAll(CTX(workspaceId));
      const item = page.items.find((i) => i.id === taskId)!;
      expect(item.primary_action).toEqual({ kind: "open_playbook", target: "authority-backlink" });
    });

    it("diagnose, targeting the displacement id, when no playbook_slug is set", async () => {
      const workspaceId = await createWorkspace();
      const projectId = await createProject(workspaceId);
      const taskId = await createTask(workspaceId, projectId, {
        sourceDisplacementId: "0195e5b7-0000-7000-8000-0000000000e2",
      });

      const page = await listAll(CTX(workspaceId));
      expect(page.items.find((i) => i.id === taskId)!.primary_action).toEqual({
        kind: "diagnose",
        target: "0195e5b7-0000-7000-8000-0000000000e2",
      });
    });

    it("copy_patch, targeting the finding id, when no playbook_slug or displacement id is set", async () => {
      const workspaceId = await createWorkspace();
      const projectId = await createProject(workspaceId);
      const findingId = await createAuxFinding(workspaceId, projectId, { severity: "critical", ruleCode: "AUX-R-001" });
      const taskId = await createTask(workspaceId, projectId, { sourceFindingId: findingId });

      const page = await listAll(CTX(workspaceId));
      expect(page.items.find((i) => i.id === taskId)!.primary_action).toEqual({
        kind: "copy_patch",
        target: findingId,
      });
    });

    it("open_task, targeting the task itself, when the task derives none of the above", async () => {
      const workspaceId = await createWorkspace();
      const projectId = await createProject(workspaceId);
      const taskId = await createTask(workspaceId, projectId, {});

      const page = await listAll(CTX(workspaceId));
      expect(page.items.find((i) => i.id === taskId)!.primary_action).toEqual({
        kind: "open_task",
        target: taskId,
      });
    });
  });

  // ---- code -----------------------------------------------------------------

  it("code is COALESCE(aux_findings.rule_code, tasks.rule_code)", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const findingId = await createAuxFinding(workspaceId, projectId, { ruleCode: "AUX-R-014" });
    const fromFinding = await createTask(workspaceId, projectId, { sourceFindingId: findingId, ruleCode: "TG-IGNORED" });
    const fromTask = await createTask(workspaceId, projectId, { ruleCode: "TG-SOV-DROP-ENGINE" });
    const neither = await createTask(workspaceId, projectId, {});

    const page = await listAll(CTX(workspaceId));
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(fromFinding)!.code).toBe("AUX-R-014");
    expect(byId.get(fromTask)!.code).toBe("TG-SOV-DROP-ENGINE");
    expect(byId.get(neither)!.code).toBeNull();
  });

  // ---- scope filter — FR-DASH-04 / ISO-08 -----------------------------------

  it("a scope filter hides an out-of-scope project's tasks, in the SAME workspace", async () => {
    const workspaceId = await createWorkspace();
    const inScope = await createProject(workspaceId, { name: "In scope" });
    const outOfScope = await createProject(workspaceId, { name: "Out of scope" });
    const visibleTask = await createTask(workspaceId, inScope, { title: "visible" });
    const hiddenTask = await createTask(workspaceId, outOfScope, { title: "hidden" });

    const page = await listAll(CTX(workspaceId, [inScope]));
    const ids = page.items.map((i) => i.id);

    expect(ids).toContain(visibleTask);
    expect(ids).not.toContain(hiddenTask);
  });

  it("an empty scope means UNSCOPED — every project's tasks are returned", async () => {
    const workspaceId = await createWorkspace();
    const projectA = await createProject(workspaceId);
    const projectB = await createProject(workspaceId);
    const taskA = await createTask(workspaceId, projectA);
    const taskB = await createTask(workspaceId, projectB);

    // No scopeProjectIds on the context at all — the unscoped, non-manager case.
    const page = await listAll(CTX(workspaceId));
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(taskA);
    expect(ids).toContain(taskB);
  });

  // ---- cross-workspace isolation — real RLS, not this query's own predicate --

  it("another workspace's tasks are invisible, enforced by RLS (connects as nominara_app, not the superuser)", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const projectA = await createProject(workspaceA);
    const projectB = await createProject(workspaceB);
    const taskA = await createTask(workspaceA, projectA, { title: "workspace A" });
    const taskB = await createTask(workspaceB, projectB, { title: "workspace B" });

    const page = await listAll(CTX(workspaceA));
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(taskA);
    expect(ids).not.toContain(taskB);
  });

  // ---- deleted / dismissed exclusion -----------------------------------------

  it("excludes tasks whose status is not todo/in_progress (done, dismissed)", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const open = await createTask(workspaceId, projectId, { status: "todo", title: "open" });
    const inProgress = await createTask(workspaceId, projectId, { status: "in_progress", title: "in-progress" });
    const done = await createTask(workspaceId, projectId, { status: "done", title: "done" });
    const dismissed = await createTask(workspaceId, projectId, { status: "dismissed", title: "dismissed" });

    const page = await listAll(CTX(workspaceId));
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(open);
    expect(ids).toContain(inProgress);
    expect(ids).not.toContain(done);
    expect(ids).not.toContain(dismissed);
  });

  it("excludes a soft-deleted task", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const alive = await createTask(workspaceId, projectId, { title: "alive" });
    const deletedTaskId = await createTask(workspaceId, projectId, { deletedAt: new Date(), title: "deleted" });

    const page = await listAll(CTX(workspaceId));
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(alive);
    expect(ids).not.toContain(deletedTaskId);
  });

  it("excludes every task of a soft-deleted project", async () => {
    const workspaceId = await createWorkspace();
    const aliveProject = await createProject(workspaceId);
    const deletedProject = await createProject(workspaceId, { deletedAt: new Date() });
    const aliveTask = await createTask(workspaceId, aliveProject, { title: "alive project" });
    const orphanTask = await createTask(workspaceId, deletedProject, { title: "deleted project" });

    const page = await listAll(CTX(workspaceId));
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(aliveTask);
    expect(ids).not.toContain(orphanTask);
  });

  // ---- pagination -------------------------------------------------------------

  it("pages every open task exactly once, skipping and repeating none, across a strictly descending impact score", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      created.push(await createTask(workspaceId, projectId, { impactScore: 90 - i, title: `task-${String(i)}` }));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await listAll(CTX(workspaceId), (cursor === undefined ? { limit: 2 } : { limit: 2, cursor }) as PaginationRequest);
      seen.push(...page.items.map((i) => i.id));
      if (!page.pagination.has_more) {
        expect(page.pagination.cursor_next).toBeNull();
        break;
      }
      expect(page.pagination.cursor_next).not.toBeNull();
      cursor = page.pagination.cursor_next!;
    }

    expect(seen).toHaveLength(created.length);
    expect(new Set(seen).size).toBe(created.length);
    expect(seen).toEqual(created); // strictly descending impact_score => same order as insertion here
  });

  it("pages correctly through a full 4-way tie (same impact AND same severity AND same instant)", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    // ONE transaction on the fixture connection: now() is transaction-start
    // time, so all rows share created_at exactly — the tie-break on `id` is
    // the only thing that can keep this from silently dropping rows at a
    // page boundary.
    await client.query("BEGIN");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const dedupeFingerprint = createHash("sha256").update(`tie-${String(i)}-${randomUUID()}`).digest();
      const result = await client.query<{ id: string }>(
        `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, impact_score)
         VALUES ($1, $2, $3, 'content', $4, 'Tied', 'Description', 30)
         RETURNING id`,
        [workspaceId, projectId, `TIE-${String(i)}`, dedupeFingerprint],
      );
      ids.push(result.rows[0]!.id);
    }
    await client.query("COMMIT");

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await listAll(CTX(workspaceId), (cursor === undefined ? { limit: 1 } : { limit: 1, cursor }) as PaginationRequest);
      seen.push(...page.items.map((i) => i.id));
      if (!page.pagination.has_more) break;
      cursor = page.pagination.cursor_next!;
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("an empty workspace is an empty array, not an error", async () => {
    const workspaceId = await createWorkspace();
    const page = await listAll(CTX(workspaceId));
    expect(page.items).toEqual([]);
    expect(page.pagination).toEqual({ cursor_next: null, has_more: false, limit: 50 });
  });
});
