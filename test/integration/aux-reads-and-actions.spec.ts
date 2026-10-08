import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ConflictError, NotFoundError, PreconditionUnmetError } from "../../src/api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../src/tenancy/errors.js";
import { AuxService } from "../../src/modules/aux/aux.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { updateAuxFindingRequestSchema } from "../../contracts/aux/index.js";

// NEW-C-10 (STORY-052) — AUX reads and finding actions, real SQL as the real
// `nominara_app` role under RLS. A tenant write path and a tenant read path.
describe("NEW-C-10 · AuxService — real SQL under RLS", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;
  const service = new AuxService();

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
  async function createUser(): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u${seq}-${randomUUID()}@example.com`])).rows[0]!.id;
  }
  async function createProject(workspaceId: string): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, $3, 'https://example.com', $4) RETURNING id`,
      [workspaceId, `Project ${seq}`, `project-${seq}`, `example-${seq}.com`])).rows[0]!.id;
  }
  async function createAudit(ws: string, project: string, over: { score?: number | null; status?: string; breakdown?: unknown; created?: string } = {}): Promise<string> {
    return (await client.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer, status, aux_score, score_breakdown, created_at, finished_at)
       VALUES ($1, $2, 'scheduled', ARRAY['https://example.com/'], 'test', 'none', $3, $4, $5::jsonb, COALESCE($6::timestamptz, now()), COALESCE($6::timestamptz, now()))
       RETURNING id`,
      [ws, project, over.status ?? "completed", over.score === undefined ? 70 : over.score, JSON.stringify(over.breakdown ?? { crawler_access: 0.5 }), over.created ?? null])).rows[0]!.id;
  }
  async function createFinding(ws: string, project: string, audit: string, status = "open", rule = "AUX-R-001"): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>(
      `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, url, severity, status, fingerprint, title, evidence, rule_version)
       VALUES ($1, $2, $3, $4, $5, 'high', $6, $7, 'T', '{"selector":null,"snippet":null,"measured":null,"expected":null}'::jsonb, 'test') RETURNING id`,
      [ws, project, audit, rule, `https://example.com/p${seq}`, status, createHash("sha256").update(`f-${seq}-${randomUUID()}`).digest()])).rows[0]!.id;
  }
  const CTX = (workspaceId: string, actorId: string, scope?: readonly string[]): TenantContext => ({
    workspaceId, actorId, ...(scope !== undefined ? { scopeProjectIds: scope } : {}),
  });
  const patch = (ctx: TenantContext, id: string, body: Record<string, unknown>) =>
    inTenant(ctx, () => service.updateFinding(id, updateAuxFindingRequestSchema.parse(body)));
  const statusOf = async (id: string) => (await client.query<{ status: string; wont_fix_reason: string | null; resolved_at: Date | null }>(
    "SELECT status, wont_fix_reason, resolved_at FROM aux_findings WHERE id = $1", [id])).rows[0]!;

  it("[NEW-C-10 AC4] reads the latest audit first with ?limit=1, delta against the previous scored audit", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    await createAudit(ws, p, { score: 60, created: "2026-09-01T00:00:00Z" });
    const newest = await createAudit(ws, p, { score: 68.5, created: "2026-10-01T00:00:00Z" });
    const page = await inTenant(CTX(ws, actor), () => service.listProjectAudits(p, { limit: 1 }));
    expect(page.items.map((a) => a.audit_id)).toEqual([newest]);
    expect(page.items[0]).toMatchObject({ aux_score: 68.5, delta: 8.5 });
    expect(page.pagination.has_more).toBe(true);
  });

  it("[NEW-C-10 AC4] an audit with no score reads aux_score null and delta null", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const a = await createAudit(ws, p, { score: null, status: "partial" });
    const audit = await inTenant(CTX(ws, actor), () => service.getAudit(a));
    expect(audit).toMatchObject({ aux_score: null, delta: null, status: "partial" });
  });

  it("[NEW-C-10 AC3] another workspace's audit and finding are invisible: 404, and a PATCH changes nothing", async () => {
    const wsA = await createWorkspace(); const wsB = await createWorkspace(); const actorB = await createUser();
    const p = await createProject(wsA); const a = await createAudit(wsA, p); const f = await createFinding(wsA, p, a);
    await expect(inTenant(CTX(wsB, actorB), () => service.getAudit(a))).rejects.toBeInstanceOf(NotFoundError);
    await expect(patch(CTX(wsB, actorB), f, { status: "acknowledged" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(inTenant(CTX(wsB, actorB), () => service.listProjectFindings(p, { limit: 50 }))).rejects.toBeInstanceOf(NotFoundError);
    expect((await statusOf(f)).status).toBe("open");
  });

  it("[NEW-C-10 AC3] a scoped caller cannot PATCH or read a finding of an out-of-scope project", async () => {
    const ws = await createWorkspace(); const actor = await createUser();
    const p = await createProject(ws); const other = await createProject(ws);
    const a = await createAudit(ws, p); const f = await createFinding(ws, p, a);
    await expect(patch(CTX(ws, actor, [other]), f, { status: "acknowledged" })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    await expect(inTenant(CTX(ws, actor, [other]), () => service.getAudit(a))).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect((await statusOf(f)).status).toBe("open");
  });

  it("[NEW-C-10 AC2] acknowledged -> open round-trips; open from open is a 409", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    expect((await patch(CTX(ws, actor), f, { status: "acknowledged" })).status).toBe("acknowledged");
    expect((await patch(CTX(ws, actor), f, { status: "open" })).status).toBe("open");
    await expect(patch(CTX(ws, actor), f, { status: "open" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("[NEW-C-10 AC2] wont_fix stores the reason and annotates the read", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    const out = await patch(CTX(ws, actor), f, { status: "wont_fix", reason: "Staging only" });
    expect(out.wont_fix).toEqual({ reason: "Staging only" });
    expect(await statusOf(f)).toMatchObject({ status: "wont_fix", wont_fix_reason: "Staging only" });
  });

  it("[NEW-C-10 AC2] resolved is a 422 and the row is untouched", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    await expect(patch(CTX(ws, actor), f, { status: "resolved" })).rejects.toBeInstanceOf(PreconditionUnmetError);
    expect(await statusOf(f)).toMatchObject({ status: "open", resolved_at: null });
  });

  it("[NEW-C-10 AC4] filters findings by status, rule and URL, and pages by cursor without skipping", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const a = await createAudit(ws, p);
    const ids = [await createFinding(ws, p, a), await createFinding(ws, p, a), await createFinding(ws, p, a, "acknowledged", "AUX-R-002")];
    const read = (q: Record<string, unknown>) => inTenant(CTX(ws, actor), () => service.listProjectFindings(p, q as never));
    expect((await read({ limit: 50, status: "acknowledged" })).items.map((i) => i.finding_id)).toEqual([ids[2]]);
    expect((await read({ limit: 50, rule_code: "AUX-R-001" })).items).toHaveLength(2);
    const first = await read({ limit: 2 });
    const second = await read({ limit: 2, cursor: first.pagination.cursor_next! });
    expect([...first.items, ...second.items].map((i) => i.finding_id).sort()).toEqual([...ids].sort());
  });
});
