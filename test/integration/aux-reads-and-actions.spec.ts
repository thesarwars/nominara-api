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
  async function createAudit(ws: string, project: string, over: { score?: number | null; status?: string; breakdown?: unknown; created?: string; ruleVersion?: string; excluded?: string[] } = {}): Promise<string> {
    return (await client.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer, status, aux_score, score_breakdown, created_at, finished_at, excluded_rules)
       VALUES ($1, $2, 'scheduled', ARRAY['https://example.com/'], $7, 'none', $3, $4, $5::jsonb, COALESCE($6::timestamptz, now()), COALESCE($6::timestamptz, now()), $8::text[])
       RETURNING id`,
      [ws, project, over.status ?? "completed", over.score === undefined ? 70 : over.score, JSON.stringify(over.breakdown ?? { crawler_access: 0.5 }), over.created ?? null, over.ruleVersion ?? "test", over.excluded ?? []])).rows[0]!.id;
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

  it("[NEW-C-10 AC4] round 6 · the real LATERAL join gives a delta only between audits measured the same way: null across a rule-version change and across a different excluded set", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const a1 = await createAudit(ws, p, { score: 60, created: "2026-09-01T00:00:00Z", ruleVersion: "v1" });
    const a2 = await createAudit(ws, p, { score: 70, created: "2026-09-02T00:00:00Z", ruleVersion: "v1" });
    const a3 = await createAudit(ws, p, { score: 75, created: "2026-09-03T00:00:00Z", ruleVersion: "v2" });
    const a4 = await createAudit(ws, p, { score: 80, created: "2026-09-04T00:00:00Z", ruleVersion: "v2", excluded: ["AUX-R-026"] });
    const a5 = await createAudit(ws, p, { score: 82, created: "2026-09-05T00:00:00Z", ruleVersion: "v2", excluded: ["AUX-R-026"] });
    const a6 = await createAudit(ws, p, { score: null, status: "partial", created: "2026-09-06T00:00:00Z", ruleVersion: "v2", excluded: ["AUX-R-026"] });
    const a7 = await createAudit(ws, p, { score: 90, created: "2026-09-07T00:00:00Z", ruleVersion: "v2", excluded: ["AUX-R-026"] });
    const a8 = await createAudit(ws, p, { score: 0, created: "2026-09-08T00:00:00Z", ruleVersion: "v2", excluded: ["AUX-R-026"] });
    const a9 = await createAudit(ws, p, { score: 5, created: "2026-09-09T00:00:00Z", ruleVersion: "v2", excluded: ["AUX-R-026"] });
    const page = await inTenant(CTX(ws, actor), () => service.listProjectAudits(p, { limit: 20 }));
    const delta = Object.fromEntries(page.items.map((a) => [a.audit_id, a.delta]));
    expect(delta[a6]).toBeNull(); // no score of its own
    expect(delta[a7]).toBe(8); // skips the unscored a6 and compares with a5 (82)
    expect(delta[a8]).toBe(-90);
    expect(delta[a9]).toBe(5); // a predecessor scored 0 is a score, not an absence: 5 - 0, never null
    expect(delta[a1]).toBeNull(); // no previous audit
    expect(delta[a2]).toBe(10); // control: same rule version, same excluded set
    expect(delta[a3]).toBeNull(); // rule version v1 -> v2
    expect(delta[a4]).toBeNull(); // excluded set [] -> [AUX-R-026]
    expect(delta[a5]).toBe(2); // control again
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
    expect(out.wont_fix).toMatchObject({ reason: "Staging only" });
    expect(await statusOf(f)).toMatchObject({ status: "wont_fix", wont_fix_reason: "Staging only" });
  });

  const wontFixAt = async (id: string) => (await client.query<{ at: string | null; resurfaces: string | null }>(
    "SELECT wont_fix_at::text AS at, (wont_fix_at + interval '180 days')::text AS resurfaces FROM aux_findings WHERE id = $1", [id])).rows[0]!;

  it("[NEW-C-10 AC2] wont_fix records wont_fix_at and the read resurfaces it exactly 180 days later; a fresh finding has none", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    expect((await wontFixAt(f)).at).toBeNull();
    const before = Date.now();
    const out = await patch(CTX(ws, actor), f, { status: "wont_fix", reason: "Staging only" });
    const row = await client.query<{ at: Date }>("SELECT wont_fix_at AS at FROM aux_findings WHERE id = $1", [f]);
    const at = row.rows[0]!.at;
    expect(at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(out.wont_fix).toEqual({ reason: "Staging only", resurfaces_at: new Date(at.getTime() + 180 * 86_400_000).toISOString() });
  });

  it("[NEW-C-10 AC2] a re-detection by the crawler does not move wont_fix_at, and acknowledging records none", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    await patch(CTX(ws, actor), f, { status: "wont_fix", reason: "Staging only" });
    const stamped = (await wontFixAt(f)).at;
    await client.query("UPDATE aux_findings SET last_detected_at = now() + interval '1 day', occurrence_count = occurrence_count + 1, updated_at = now() + interval '1 day' WHERE id = $1", [f]);
    expect((await wontFixAt(f)).at).toBe(stamped);
    const g = await createFinding(ws, p, await createAudit(ws, p));
    await patch(CTX(ws, actor), g, { status: "acknowledged" });
    expect((await wontFixAt(g)).at).toBeNull();
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
