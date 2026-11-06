import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ShareTokensService } from "../../src/modules/agency/share-tokens.service.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-098 part B — the pre-auth lookup (app.share_token_by_hash) and the gate's writes, as the REAL runtime
// roles. The HTTP harness connects as a superuser, which would pass every one of these vacuously.
describe("STORY-098 part B · the share-token gate under RLS", () => {
  let container: StartedPostgreSqlContainer;
  let admin: Client;
  let appPool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
  }, 120_000);
  afterAll(async () => {
    await container.stop();
  });
  beforeEach(async () => {
    admin = new Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS app CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await admin.query("DROP SCHEMA public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await migrateUp(admin);
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      await admin.query(`ALTER ROLE ${role} PASSWORD ${admin.escapeLiteral(resolvePassword(role, {}))}`);
    }
    appPool = asRole("nominara_app");
  });
  afterEach(async () => {
    await appPool.end();
    await admin.end();
  });

  const asRole = (role: string): Pool =>
    new Pool({ host: container.getHost(), port: container.getPort(), database: "nominara_test", user: role, password: resolvePassword(role, {}) });
  const service = (): ShareTokensService => new ShareTokensService(new AuditChainService());

  async function seed(): Promise<{ ws: string; project: string; tokenId: string; hash: Buffer }> {
    const [ws, project, user, tokenId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const hash = randomBytes(32);
    await admin.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1::uuid,$1::text,$1::text,'growth')", [ws]);
    await admin.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [user, `${user}@example.test`]);
    await admin.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://a.test','a.test')", [project, ws, `p-${project.slice(0, 8)}`]);
    await admin.query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_hash, password_required, scope_project_ids, created_by)
       VALUES ($1,$2,'SECRET LABEL',$3,'abcdefgh','$argon2id$stub',true,$4::uuid[],$5)`,
      [tokenId, ws, hash, [project], user],
    );
    return { ws, project, tokenId, hash };
  }

  it("STORY-098 s5 · as nominara_app with NO tenant context, the lookup by hash returns the one gate row, and an unknown hash returns nothing", async () => {
    const s = await seed();
    const found = await service().findForGate(appPool, s.hash);
    expect(found).toMatchObject({ id: s.tokenId, workspaceId: s.ws, passwordRequired: true, scopeProjectIds: [s.project], passwordHash: "$argon2id$stub" });
    expect(await service().findForGate(appPool, randomBytes(32))).toBeNull();
    // The table itself stays invisible without a context: RLS is unchanged.
    const direct = await appPool.query("SELECT id FROM share_tokens");
    expect(direct.rowCount).toBe(0);
  });

  it("STORY-098 s5 · the lookup function returns ONLY the gate columns: no hash, label, prefix or creator", async () => {
    const s = await seed();
    const r = await appPool.query("SELECT * FROM app.share_token_by_hash($1)", [s.hash]);
    const columns = r.fields.map((f) => f.name).sort();
    for (const forbidden of ["token_hash", "label", "token_prefix", "created_by", "created_at"]) expect(columns).not.toContain(forbidden);
    expect(columns).toEqual(expect.arrayContaining(["id", "workspace_id", "password_hash", "password_required", "scope_project_ids", "scope_tabs", "revoked_at", "expires_at", "max_views", "view_count", "locked_until"]));
  });

  it("STORY-098 · the lookup is a SECURITY DEFINER function with a pinned search_path, executable by nominara_app and by nobody else", async () => {
    const meta = await admin.query<{ secdef: boolean; config: string[] | null; pub: boolean; app: boolean; worker: boolean; report: boolean; portal: boolean }>(
      `SELECT p.prosecdef AS secdef, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
              has_function_privilege('nominara_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('nominara_worker', p.oid, 'EXECUTE') AS worker,
              has_function_privilege('nominara_report', p.oid, 'EXECUTE') AS report,
              has_function_privilege('nominara_portal', p.oid, 'EXECUTE') AS portal
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'share_token_by_hash'`,
    );
    expect(meta.rows).toHaveLength(1);
    const m = meta.rows[0]!;
    expect(m.secdef).toBe(true);
    expect((m.config ?? []).join(",")).toMatch(/search_path=/);
    expect([m.pub, m.app, m.worker, m.report, m.portal]).toEqual([false, true, false, false, false]);
    await expect(asRole("nominara_portal").query("SELECT * FROM app.share_token_by_hash($1)", [randomBytes(32)])).rejects.toMatchObject({ code: "42501" });
  });

  it("STORY-098 s6 · recording a failure under tenant A's context cannot touch tenant B's token, and the 5th failure locks and restarts the count", async () => {
    const a = await seed();
    const b = await seed();
    const svc = service();
    const client = await appPool.connect();
    try {
      for (let i = 1; i <= 4; i += 1) {
        const r = await withTenantContext(client, { workspaceId: a.ws, actorId: SYSTEM_ACTOR_ID }, () => svc.recordFailedPassword(a.tokenId));
        expect(r.lockedUntil).toBeNull();
      }
      const fifth = await withTenantContext(client, { workspaceId: a.ws, actorId: SYSTEM_ACTOR_ID }, () => svc.recordFailedPassword(a.tokenId));
      expect(fifth.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      // Tenant A's context naming tenant B's token id: RLS hides the row, nothing changes.
      await withTenantContext(client, { workspaceId: a.ws, actorId: SYSTEM_ACTOR_ID }, () => svc.recordFailedPassword(b.tokenId));
    } finally {
      client.release();
    }
    const rows = await admin.query<{ id: string; failed_attempts: number; locked_until: Date | null }>("SELECT id, failed_attempts, locked_until FROM share_tokens");
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(a.tokenId)!.failed_attempts).toBe(0);
    expect(byId.get(a.tokenId)!.locked_until).not.toBeNull();
    expect(byId.get(b.tokenId)!.failed_attempts).toBe(0);
    expect(byId.get(b.tokenId)!.locked_until).toBeNull();
  });

  it("STORY-098 s18 · consumeView increments and writes the view row under A's context; a foreign token id consumes nothing", async () => {
    const a = await seed();
    const b = await seed();
    const svc = service();
    const client = await appPool.connect();
    let mine: string | null;
    try {
      mine = await withTenantContext(client, { workspaceId: a.ws, actorId: SYSTEM_ACTOR_ID }, () =>
        svc.consumeView(a.tokenId, { ip: "203.0.113.9", userAgent: "UA", authenticated: true }),
      );
      expect(mine, "the new view row's id (owner decision 71 c)").toMatch(/^[0-9a-f-]{36}$/);
      const theirs = await withTenantContext(client, { workspaceId: a.ws, actorId: SYSTEM_ACTOR_ID }, () =>
        svc.consumeView(b.tokenId, { ip: "203.0.113.9", userAgent: "UA", authenticated: true }),
      );
      expect(theirs).toBeNull();
    } finally {
      client.release();
    }
    const counts = await admin.query<{ id: string; view_count: number }>("SELECT id, view_count FROM share_tokens");
    expect(new Map(counts.rows.map((r) => [r.id, r.view_count])).get(b.tokenId)).toBe(0);
    const written = await admin.query<{ id: string }>("SELECT id FROM share_token_views WHERE share_token_id = $1", [a.tokenId]);
    expect(written.rows.map((r) => r.id)).toEqual([mine]);
    expect((await admin.query("SELECT 1 FROM share_token_views WHERE share_token_id = $1", [b.tokenId])).rowCount).toBe(0);
  });

  it("STORY-098 s17 · isSessionLive: true for a live token, false once revoked or expired, false for another workspace's id", async () => {
    const a = await seed();
    const b = await seed();
    const svc = service();
    const client = await appPool.connect();
    const live = (ws: string, id: string) => withTenantContext(client, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, () => svc.isSessionLive(id));
    try {
      expect(await live(a.ws, a.tokenId)).toBe(true);
      expect(await live(a.ws, b.tokenId)).toBe(false);
      await admin.query("UPDATE share_tokens SET revoked_at = now() WHERE id = $1", [a.tokenId]);
      expect(await live(a.ws, a.tokenId)).toBe(false);
      await admin.query("UPDATE share_tokens SET revoked_at = NULL, expires_at = now() - interval '1 second' WHERE id = $1", [a.tokenId]);
      expect(await live(a.ws, a.tokenId)).toBe(false);
    } finally {
      client.release();
    }
  });
});
