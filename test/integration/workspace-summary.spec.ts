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
