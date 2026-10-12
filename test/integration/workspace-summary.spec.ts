import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DEMO_SEED_MARKER } from "../../src/db/seed/demo/constants.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { BillingService } from "../../src/modules/billing/billing.service.js";
import { ProjectsService } from "../../src/modules/projects/projects.service.js";
import { WorkspaceSummaryService } from "../../src/modules/workspaces/workspace-summary.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-B-2 — GET /v1/workspaces/{id}/summary, real SQL as `nominara_app`.
// Tenant scoping is a dangerous area: a superuser connection would bypass RLS
// and pass vacuously, so every read here runs as the runtime role.
describe("NEW-B-2 · WorkspaceSummaryService — real SQL", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;

  const summary = new WorkspaceSummaryService(
    new ProjectsService(null as never, null as never, null as never),
    new BillingService(),
  );

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
      await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(resolvePassword(role, {}))}`);
    }
  });
  afterEach(async () => {
    await client.end();
  });

  async function inTenant<T>(context: TenantContext, fn: (queries: () => number, conn: Client) => Promise<T>): Promise<T> {
    const app = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
    });
    await app.connect();
    try {
      return await withTenantContext(app, context, async () => {
        let count = 0;
        const original = app.query.bind(app) as (...a: unknown[]) => unknown;
        (app as unknown as { query: unknown }).query = (...a: unknown[]) => {
          count += 1;
          return original(...a);
        };
        return await fn(() => count, app);
      });
    } finally {
      await app.end();
    }
  }

  async function createWorkspace(plan = "business"): Promise<string> {
    seq += 1;
    const r = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, $3) RETURNING id",
      [`Workspace ${seq}`, `workspace-${seq}-${randomUUID()}`, plan],
    );
    return r.rows[0]!.id;
  }

  async function createProject(workspaceId: string, deleted = false): Promise<string> {
    seq += 1;
    const r = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, prompts_active, deleted_at,
                             visibility_blended, sparkline_30d)
       VALUES ($1, $2, $3, 'https://example.com', $4, 4, $5, 61.5, '[1,2,3]'::jsonb) RETURNING id`,
      [workspaceId, `Project ${seq}`, `project-${seq}`, `example-${seq}.com`, deleted ? new Date() : null],
    );
    return r.rows[0]!.id;
  }

  const CTX = (workspaceId: string, scope?: readonly string[]): TenantContext => ({
    workspaceId,
    actorId: randomUUID(),
    ...(scope !== undefined ? { scopeProjectIds: scope } : {}),
  });

  it("FR-DASH-01: an unscoped caller gets every live project, with denormalised columns, in one payload", async () => {
    const ws = await createWorkspace();
    await createProject(ws);
    await createProject(ws);
    await createProject(ws, true);
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(out.projects).toHaveLength(2);
    expect(out.health.projects_used).toBe(2);
    expect(out.health.prompts_used).toBe(8);
    expect(out.projects[0]!.visibility_blended).toBe(61.5);
    expect(out.projects[0]!.sparkline_30d).toEqual([1, 2, 3]);
    expect(out.plan_key).toBe("business");
  });

  it("scoped role: only in-scope projects, and projects_used / prompts_used count the scoped set (no hint of the rest)", async () => {
    const ws = await createWorkspace();
    const a = await createProject(ws);
    await createProject(ws);
    await createProject(ws);
    const out = await inTenant(CTX(ws, [a]), () => summary.summary(ws));
    expect(out.projects.map((p) => p.id)).toEqual([a]);
    expect(out.health.projects_used).toBe(1);
    expect(out.health.prompts_used).toBe(4);
  });

  // STORY-175 - capture_runs fixtures. Inserted as the superuser; the read is as nominara_app.
  async function createRun(
    workspaceId: string,
    projectId: string,
    o: {
      status?: string;
      trigger?: string;
      planned?: number;
      captured?: number;
      failed?: number;
      skipped?: number;
      createdAt?: string;
      startedAt?: string | null;
      finishedAt?: string | null;
    } = {},
  ): Promise<string> {
    const r = await client.query<{ id: string }>(
      `INSERT INTO capture_runs (workspace_id, project_id, trigger, engine_keys, planned_cells, captured_cells,
                                 failed_cells, skipped_cells, status, started_at, finished_at, created_at)
       VALUES ($1,$2,$3,ARRAY['gemini'],$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        workspaceId,
        projectId,
        o.trigger ?? "manual",
        o.planned ?? 0,
        o.captured ?? 0,
        o.failed ?? 0,
        o.skipped ?? 0,
        o.status ?? "queued",
        o.startedAt ?? null,
        o.finishedAt ?? null,
        o.createdAt ?? new Date().toISOString(),
      ],
    );
    return r.rows[0]!.id;
  }

  async function writeRollup(workspaceId: string, projectId: string, computedAt: string, entityType = "brand", engineKey = "all"): Promise<void> {
    await client.query(
      `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, computed_at)
       VALUES ($1,$2,$3,$4,$5,'2026-10-12',$6)`,
      [workspaceId, projectId, engineKey, entityType, entityType === "brand" ? projectId : randomUUID(), computedAt],
    );
  }

  const lastScanOf = (out: Awaited<ReturnType<typeof summary.summary>>, id: string) => out.projects.find((p) => p.id === id)!.last_scan;

  it("STORY-175 scenario 1 (AC1): a project with no runs has last_scan null", async () => {
    const ws = await createWorkspace();
    const p = await createProject(ws);
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(lastScanOf(out, p)).toBeNull();
  });

  it("STORY-175 scenario 2 (AC1): a running run reports captured 11 of planned 17, no completed_at, not rolled up", async () => {
    const ws = await createWorkspace();
    const p = await createProject(ws);
    const runId = await createRun(ws, p, { status: "running", planned: 17, captured: 11, startedAt: "2026-10-12T13:00:00Z" });
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(lastScanOf(out, p)).toEqual({
      run_id: runId,
      status: "running",
      trigger: "manual",
      planned_cells: 17,
      settled_cells: 11,
      captured_cells: 11,
      started_at: "2026-10-12T13:00:00.000Z",
      completed_at: null,
      rolled_up: false,
    });
  });

  it("STORY-175 scenario 3 (AC1): a completed run with no rollup written is rolled_up false", async () => {
    const ws = await createWorkspace();
    const p = await createProject(ws);
    await createRun(ws, p, { status: "completed", planned: 17, captured: 17, startedAt: "2026-10-12T13:00:00Z", finishedAt: "2026-10-12T13:08:00Z" });
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(lastScanOf(out, p)).toMatchObject({ status: "completed", completed_at: "2026-10-12T13:08:00.000Z", rolled_up: false });
  });

  it("STORY-175 scenario 4 (AC1): a rollup computed at or after the run finished makes rolled_up true", async () => {
    const ws = await createWorkspace();
    const p = await createProject(ws);
    await createRun(ws, p, { status: "completed", planned: 17, captured: 17, startedAt: "2026-10-12T13:00:00Z", finishedAt: "2026-10-12T13:08:00Z" });
    await writeRollup(ws, p, "2026-10-12T13:08:05Z");
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(lastScanOf(out, p)).toMatchObject({ status: "completed", rolled_up: true });
  });

  it("STORY-175 AC1: a rollup computed BEFORE the run finished does not count (the older day's block is stale)", async () => {
    const ws = await createWorkspace();
    const p = await createProject(ws);
    await createRun(ws, p, { status: "completed", planned: 4, captured: 4, finishedAt: "2026-10-12T13:08:00Z" });
    await writeRollup(ws, p, "2026-10-12T13:07:59Z");
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(lastScanOf(out, p)!.rolled_up).toBe(false);
  });

  it("STORY-175 AC1: only the project's own cross-engine brand row proves the block was rewritten", async () => {
    const ws = await createWorkspace();
    const p = await createProject(ws);
    const q = await createProject(ws);
    await createRun(ws, p, { status: "completed", planned: 4, captured: 4, finishedAt: "2026-10-12T13:08:00Z" });
    await writeRollup(ws, p, "2026-10-12T13:09:00Z", "competitor");
    await writeRollup(ws, p, "2026-10-12T13:09:00Z", "brand", "gemini");
    await writeRollup(ws, q, "2026-10-12T13:09:00Z"); // a sibling project's rollup is not this project's
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(lastScanOf(out, p)!.rolled_up).toBe(false);
  });

  it("STORY-175 AC1: a terminal run that captured nothing has nothing to roll up, so it is rolled_up true; a running one is not", async () => {
    const ws = await createWorkspace();
    const done = await createProject(ws);
    const live = await createProject(ws);
    await createRun(ws, done, { status: "completed", planned: 3, captured: 0, skipped: 3, finishedAt: "2026-10-12T13:08:00Z" });
    await createRun(ws, live, { status: "running", planned: 3, captured: 0 });
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(lastScanOf(out, done)!.rolled_up).toBe(true);
    expect(lastScanOf(out, live)!.rolled_up).toBe(false);
  });

  it("STORY-175 scenario 5 (AC1): a failed run reports settled = captured + failed + skipped", async () => {
    const ws = await createWorkspace();
    const p = await createProject(ws);
    await createRun(ws, p, { status: "failed", planned: 10, captured: 3, failed: 5, skipped: 2, finishedAt: "2026-10-12T13:08:00Z" });
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(lastScanOf(out, p)).toMatchObject({ status: "failed", planned_cells: 10, captured_cells: 3, settled_cells: 10 });
  });

  it("STORY-175 AC1: the LATEST run per project wins (by created_at), and each project gets its own", async () => {
    const ws = await createWorkspace();
    const a = await createProject(ws);
    const b = await createProject(ws);
    await createRun(ws, a, { status: "failed", createdAt: "2026-10-10T10:00:00Z", finishedAt: "2026-10-10T10:05:00Z" });
    const newest = await createRun(ws, a, { status: "running", createdAt: "2026-10-12T10:00:00Z" });
    await createRun(ws, a, { status: "completed", createdAt: "2026-10-11T10:00:00Z", finishedAt: "2026-10-11T10:05:00Z" });
    const bRun = await createRun(ws, b, { status: "completed", trigger: "scheduled", createdAt: "2026-10-09T10:00:00Z", finishedAt: "2026-10-09T10:05:00Z" });
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(lastScanOf(out, a)).toMatchObject({ run_id: newest, status: "running" });
    expect(lastScanOf(out, b)).toMatchObject({ run_id: bRun, trigger: "scheduled" });
  });

  it("STORY-175 scenario 6 (AC3): another workspace's run never shows, even a row cross-wired onto this workspace's project", async () => {
    const mine = await createWorkspace();
    const theirs = await createWorkspace();
    const myProject = await createProject(mine);
    const theirProject = await createProject(theirs);
    const theirRun = await createRun(theirs, theirProject, { status: "running", planned: 9 });
    // Corrupt data: a run stamped with workspace B but pointing at A's project, newer than anything of A's.
    const crossWired = await createRun(theirs, myProject, { status: "running", planned: 99, createdAt: "2099-01-01T00:00:00Z" });
    const mineOnly = await inTenant(CTX(mine), () => summary.summary(mine));
    expect(lastScanOf(mineOnly, myProject)).toBeNull();
    expect(JSON.stringify(mineOnly)).not.toContain(theirRun);
    expect(JSON.stringify(mineOnly)).not.toContain(crossWired);
    const own = await createRun(mine, myProject, { status: "completed", planned: 2, captured: 2, finishedAt: "2026-10-12T13:08:00Z" });
    const withOwn = await inTenant(CTX(mine), () => summary.summary(mine));
    expect(lastScanOf(withOwn, myProject)).toMatchObject({ run_id: own, planned_cells: 2 });
  });

  it("STORY-175 scenario 7 (AC3): a scoped manager gets last_scan only for in-scope projects, and a hidden run id never appears", async () => {
    const ws = await createWorkspace();
    const inScope = await createProject(ws);
    const hidden = await createProject(ws);
    const mine = await createRun(ws, inScope, { status: "running", planned: 5, captured: 1 });
    const hiddenRun = await createRun(ws, hidden, { status: "running", planned: 7 });
    const scoped = await inTenant(CTX(ws, [inScope]), () => summary.summary(ws));
    expect(scoped.projects.map((p) => p.id)).toEqual([inScope]);
    expect(lastScanOf(scoped, inScope)).toMatchObject({ run_id: mine, planned_cells: 5 });
    expect(JSON.stringify(scoped)).not.toContain(hiddenRun);
    const all = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(lastScanOf(all, hidden)).toMatchObject({ run_id: hiddenRun });
  });

  it("STORY-175 AC2: last_scan is read with the rows - the statement count is the same with 12 scanned projects as with 1", async () => {
    const small = await createWorkspace();
    const one = await createProject(small);
    await createRun(small, one, { status: "running", planned: 3 });
    const big = await createWorkspace();
    for (let i = 0; i < 12; i += 1) {
      const p = await createProject(big);
      await createRun(big, p, { status: "completed", planned: 3, captured: 3, finishedAt: "2026-10-12T13:08:00Z" });
      await createRun(big, p, { status: "running", planned: 3 });
    }
    const smallCount = await inTenant(CTX(small), async (n) => {
      await summary.summary(small);
      return n();
    });
    const bigCount = await inTenant(CTX(big), async (n) => {
      const out = await summary.summary(big);
      expect(out.projects.every((p) => p.last_scan?.status === "running")).toBe(true);
      return n();
    });
    expect(bigCount).toBe(smallCount);
  });

  // STORY-175 - the Command Center card reads GET /v1/projects, which shares the row builder.
  describe("STORY-175 · GET /v1/projects list items carry last_scan", () => {
    const projectsService = new ProjectsService(null as never, null as never, null as never);
    const page = (limit = 50, cursor?: string) => projectsService.list({ limit, ...(cursor !== undefined ? { cursor } : {}) });

    it("STORY-175 AC1/AC2: list rows carry last_scan - null with no run, the latest run otherwise, rolled_up from the rollup", async () => {
      const ws = await createWorkspace();
      const none = await createProject(ws);
      const live = await createProject(ws);
      const done = await createProject(ws);
      const liveRun = await createRun(ws, live, { status: "running", planned: 17, captured: 11, startedAt: "2026-10-12T13:00:00Z" });
      await createRun(ws, done, { status: "completed", planned: 4, captured: 4, finishedAt: "2026-10-12T13:08:00Z" });
      await writeRollup(ws, done, "2026-10-12T13:09:00Z");
      const out = await inTenant(CTX(ws), () => page());
      const by = (id: string) => out.items.find((p) => p.id === id)!.last_scan;
      expect(by(none)).toBeNull();
      expect(by(live)).toMatchObject({ run_id: liveRun, status: "running", planned_cells: 17, settled_cells: 11, rolled_up: false });
      expect(by(done)).toMatchObject({ status: "completed", rolled_up: true });
    });

    it("STORY-175 scenario 6 (AC3): another workspace's run, even one cross-wired onto this workspace's project, never shows in the list", async () => {
      const mine = await createWorkspace();
      const theirs = await createWorkspace();
      const myProject = await createProject(mine);
      const theirProject = await createProject(theirs);
      const theirRun = await createRun(theirs, theirProject, { status: "running" });
      const crossWired = await createRun(theirs, myProject, { status: "running", createdAt: "2099-01-01T00:00:00Z" });
      const out = await inTenant(CTX(mine), () => page());
      expect(out.items.map((p) => p.last_scan)).toEqual([null]);
      expect(JSON.stringify(out)).not.toContain(theirRun);
      expect(JSON.stringify(out)).not.toContain(crossWired);
    });

    it("STORY-175 scenario 7 (AC3): a scoped manager's list carries last_scan only for in-scope projects", async () => {
      const ws = await createWorkspace();
      const inScope = await createProject(ws);
      const hidden = await createProject(ws);
      const mine = await createRun(ws, inScope, { status: "running" });
      const hiddenRun = await createRun(ws, hidden, { status: "running" });
      const scoped = await inTenant(CTX(ws, [inScope]), () => page());
      expect(scoped.items.map((p) => p.id)).toEqual([inScope]);
      expect(scoped.items[0]!.last_scan).toMatchObject({ run_id: mine });
      expect(JSON.stringify(scoped)).not.toContain(hiddenRun);
    });

    it("STORY-175 AC2: paging with a cursor still attaches each row's own run (the join does not disturb ordering)", async () => {
      const ws = await createWorkspace();
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const p = await createProject(ws);
        ids.push(p);
        await createRun(ws, p, { status: "completed", planned: i + 1, captured: i + 1, finishedAt: "2026-10-12T13:08:00Z" });
        await createRun(ws, p, { status: "running", planned: i + 10, createdAt: "2099-01-01T00:00:00Z" });
      }
      const first = await inTenant(CTX(ws), () => page(2));
      expect(first.items).toHaveLength(2);
      const second = await inTenant(CTX(ws), () => page(2, first.pagination.cursor_next!));
      const all = [...first.items, ...second.items];
      expect(all.map((p) => p.id)).toEqual(ids);
      expect(all.map((p) => p.last_scan?.planned_cells)).toEqual([10, 11, 12]);
    });
  });

  it("scoped role: the engine filter list is derived from the scoped set only", async () => {
    const ws = await createWorkspace("business");
    const a = await createProject(ws);
    await createProject(ws);
    const scoped = await inTenant(CTX(ws, [a]), () => summary.summary(ws));
    const all = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(scoped.engines.length).toBeGreaterThan(0);
    expect(scoped.engines).toEqual(all.engines); // same plan, same entitled engines
    // A workspace with no readable project reveals no engines at all.
    const none = await inTenant(CTX(ws, [randomUUID()]), () => summary.summary(ws));
    expect(none.projects).toEqual([]);
    expect(none.engines).toEqual([]);
  });

  // NEW-B-2 remaining audit item: a scoped member's summary covers ONLY their
  // projects, including the provenance that colours the engine filter list. A
  // demo capture in a project they cannot read must not turn their "live" into
  // "mixed" (that would be a hint of an unreadable project's contents).
  it("NEW-B-2 scoping: a scoped member's summary, counts and engine provenance cover only their projects", async () => {
    const ws = await createWorkspace();
    const inScope = await createProject(ws);
    const hidden = await createProject(ws);
    await client.query("INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,cache_ttl_seconds,volatility_band,min_plan_key,status) VALUES ('gemini','g','v','api','1.0.0',86400,'medium','free','active') ON CONFLICT DO NOTHING");
    for (const [projectId, normalizer] of [[inScope, "v1"], [hidden, DEMO_SEED_MARKER]] as const) {
      const prompt = await client.query<{ id: string }>(
        `INSERT INTO tracked_prompts (workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
         VALUES ($1,$2,'q',sha256('q'::bytea),'recommendation','consideration',false,'active') RETURNING id`,
        [ws, projectId],
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO answer_captures
           (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present)
         VALUES ($1,$2,$3,$4,$5,'gemini', now() - interval '2 hours','api','1.0.0',$6,$7,'{}'::jsonb,'{}','live','parsed',true)`,
        [id, ws, projectId, uuidV7(), prompt.rows[0]!.id, normalizer, createHash("sha256").update(id).digest()],
      );
    }
    await client.query(
      "UPDATE projects SET visibility_by_engine = '{\"gemini\":{\"score\":50,\"delta_30d\":null}}'::jsonb WHERE workspace_id = $1",
      [ws],
    );
    const scoped = await inTenant(CTX(ws, [inScope]), () => summary.summary(ws));
    expect(scoped.projects.map((p) => p.id)).toEqual([inScope]);
    expect(scoped.health.projects_used).toBe(1);
    expect(scoped.health.prompts_used).toBe(4);
    expect(scoped.engines.find((e) => e.engine_key === "gemini")?.data_source).toBe("live");
    expect(JSON.stringify(scoped)).not.toContain(hidden);
    // The unscoped caller sees both, and the engine is "mixed": the difference is exactly the hidden project.
    const all = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(all.engines.find((e) => e.engine_key === "gemini")?.data_source).toBe("mixed");
  });

  it("tenancy: another workspace's projects are never returned", async () => {
    const mine = await createWorkspace();
    const theirs = await createWorkspace();
    await createProject(mine);
    await createProject(theirs);
    await createProject(theirs);
    const out = await inTenant(CTX(mine), () => summary.summary(mine));
    expect(out.projects).toHaveLength(1);
  });

  it("AC: no per-project query — the statement count is the same for 1 project and for 12", async () => {
    const small = await createWorkspace();
    await createProject(small);
    const big = await createWorkspace();
    for (let i = 0; i < 12; i += 1) await createProject(big);

    const smallCount = await inTenant(CTX(small), async (n) => {
      await summary.summary(small);
      return n();
    });
    const bigCount = await inTenant(CTX(big), async (n) => {
      const out = await summary.summary(big);
      expect(out.projects).toHaveLength(12);
      return n();
    });
    expect(bigCount).toBe(smallCount);
  });

  // NEW-B-2 CP2 — the batched provenance read must keep projects apart: a demo
  // capture in one project may not colour another project's engine, and a
  // project another workspace owns is never read.
  it("data_source is per project and per engine under RLS: live, demo and nothing-measured never bleed across projects or workspaces", async () => {
    const ws = await createWorkspace();
    const other = await createWorkspace();
    const liveProject = await createProject(ws);
    const demoProject = await createProject(ws);
    const emptyProject = await createProject(ws);
    const foreignProject = await createProject(other);
    await client.query("INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,cache_ttl_seconds,volatility_band,min_plan_key,status) VALUES ('gemini','g','v','api','1.0.0',86400,'medium','free','active') ON CONFLICT DO NOTHING");
    async function capture(workspaceId: string, projectId: string, normalizer: string): Promise<void> {
      const prompt = await client.query<{ id: string }>(
        `INSERT INTO tracked_prompts (workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
         VALUES ($1,$2,'q',sha256('q'::bytea),'recommendation','consideration',false,'active') RETURNING id`,
        [workspaceId, projectId],
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO answer_captures
           (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present)
         VALUES ($1,$2,$3,$4,$5,'gemini', now() - interval '2 hours','api','1.0.0',$6,$7,'{}'::jsonb,'{}','live','parsed',true)`,
        [id, workspaceId, projectId, uuidV7(), prompt.rows[0]!.id, normalizer, createHash("sha256").update(id).digest()],
      );
    }
    await capture(ws, liveProject, "v1");
    await capture(ws, demoProject, DEMO_SEED_MARKER);
    await capture(other, foreignProject, DEMO_SEED_MARKER);
    await client.query(
      "UPDATE projects SET visibility_by_engine = '{\"gemini\":{\"score\":50,\"delta_30d\":null}}'::jsonb WHERE workspace_id = $1",
      [ws],
    );
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    const sourceOf = (id: string) => out.projects.find((p) => p.id === id)!.engine_scores?.[0]?.data_source;
    expect(sourceOf(liveProject)).toBe("live");
    expect(sourceOf(demoProject)).toBe("demo");
    expect(sourceOf(emptyProject)).toBeNull();
    expect(out.projects).toHaveLength(3);
    // The workspace-level filter list combines the three: live + demo = mixed. The foreign demo capture changes nothing.
    expect(out.engines.find((e) => e.engine_key === "gemini")?.data_source).toBe("mixed");
  });

  it("the tenant connection is the RLS-bound runtime role, and RLS alone hides another workspace's rows", async () => {
    const mine = await createWorkspace();
    const theirs = await createWorkspace();
    await createProject(mine);
    await createProject(theirs);
    const seen = await inTenant(CTX(mine), async (_n, conn) => {
      const who = await conn.query<{ u: string; super: boolean; bypass: boolean }>(
        `SELECT current_user AS u, r.rolsuper AS super, r.rolbypassrls AS bypass
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      // No workspace_id filter: only RLS can narrow this.
      const rows = await conn.query<{ workspace_id: string }>("SELECT workspace_id FROM projects");
      return { who: who.rows[0]!, workspaces: new Set(rows.rows.map((r) => r.workspace_id)) };
    });
    expect(seen.who).toEqual({ u: "nominara_app", super: false, bypass: false });
    expect([...seen.workspaces]).toEqual([mine]);
  });

  it("a workspace with no projects returns an empty matrix and no engines (the zero-project layout)", async () => {
    const ws = await createWorkspace();
    const out = await inTenant(CTX(ws), () => summary.summary(ws));
    expect(out.projects).toEqual([]);
    expect(out.health.projects_used).toBe(0);
  });
});
