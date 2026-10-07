import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { ShareTokensService, type AuditRequestMeta } from "../../src/modules/agency/share-tokens.service.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import type { MintShareTokenRequest } from "../../contracts/agency/index.js";

// STORY-098 ISO-09 — share_tokens is tenant-scoped and the service carries no
// workspace_id predicate for correctness, so RLS is the whole guarantee. Runs as
// the real `nominara_app` role: the HTTP harness uses a superuser connection,
// which would pass a cross-tenant assertion vacuously.
describe("STORY-098 ISO-09 · ShareTokensService under RLS, as nominara_app", () => {
  let container: StartedPostgreSqlContainer;
  let admin: Client;
  const service = new ShareTokensService(new AuditChainService());
  const meta: AuditRequestMeta = { ip: null, userAgent: null, requestId: "R" };

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
  });
  afterEach(async () => {
    await admin.end();
  });

  interface Tenant {
    readonly workspaceId: string;
    readonly actorId: string;
    readonly projectId: string;
    readonly themeId: string;
  }

  async function tenant(): Promise<Tenant> {
    const workspaceId = randomUUID();
    const actorId = randomUUID();
    const projectId = randomUUID();
    const themeId = randomUUID();
    await admin.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1::uuid, $1::text, $1::text, 'growth')", [workspaceId]);
    await admin.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1, $2, now(), 'active')", [actorId, `${actorId}@example.test`]);
    await admin.query(
      "INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://a.test','a.test')",
      [projectId, workspaceId, `p-${projectId.slice(0, 8)}`],
    );
    await admin.query("INSERT INTO brand_themes (id, workspace_id, name, is_default) VALUES ($1,$2,'T',true)", [themeId, workspaceId]);
    return { workspaceId, actorId, projectId, themeId };
  }

  async function inTenant<T>(t: Tenant, fn: () => Promise<T>): Promise<T> {
    const app = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
    });
    await app.connect();
    try {
      const context: TenantContext = { workspaceId: t.workspaceId, actorId: t.actorId };
      return await withTenantContext(app, context, fn);
    } finally {
      await app.end();
    }
  }

  const request = (over: Partial<MintShareTokenRequest> & Pick<MintShareTokenRequest, "scope_project_ids">): MintShareTokenRequest => ({
    label: "L",
    scope_tabs: ["overview"],
    hide_competitors: false,
    hide_costs: true,
    timeframe_lock: null,
    password: null,
    acknowledge_no_password: true,
    allowed_email_domains: [],
    max_views: null,
    expires_at: null,
    ...over,
  });

  it("workspace B cannot list, revoke or read the views of workspace A's token (404, not 403), and the token is left untouched", async () => {
    const a = await tenant();
    const b = await tenant();
    const minted = await inTenant(a, () => service.mint(request({ scope_project_ids: [a.projectId] }), meta));
    await admin.query("INSERT INTO share_token_views (workspace_id, share_token_id) VALUES ($1,$2)", [a.workspaceId, minted.token.id]);

    expect(await inTenant(b, () => service.list())).toEqual([]);
    await expect(inTenant(b, () => service.revoke(minted.token.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(inTenant(b, () => service.views(minted.token.id))).rejects.toBeInstanceOf(NotFoundError);
    const stored = await admin.query("SELECT revoked_at FROM share_tokens WHERE id = $1", [minted.token.id]);
    expect((stored.rows[0] as { revoked_at: unknown }).revoked_at).toBeNull();
    expect((await inTenant(a, () => service.list())).map((t) => t.id)).toEqual([minted.token.id]);
    expect(await inTenant(a, () => service.views(minted.token.id))).toHaveLength(1);
  });

  it("a project or theme of another workspace is not readable, so naming it in a mint is a validation failure that stores nothing", async () => {
    const a = await tenant();
    const b = await tenant();
    await expect(inTenant(a, () => service.mint(request({ scope_project_ids: [b.projectId] }), meta))).rejects.toMatchObject({ code: "validation_failed" });
    await expect(inTenant(a, () => service.mint(request({ scope_project_ids: [a.projectId, b.projectId] }), meta))).rejects.toMatchObject({ code: "validation_failed" });
    await expect(inTenant(a, () => service.mint(request({ scope_project_ids: [a.projectId], theme_id: b.themeId }), meta))).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect((await admin.query("SELECT count(*)::int AS n FROM share_tokens")).rows[0]).toEqual({ n: 0 });
    // the same request with the workspace's own theme is accepted
    const ok = await inTenant(a, () => service.mint(request({ scope_project_ids: [a.projectId], theme_id: a.themeId }), meta));
    expect(ok.token.theme_id).toBe(a.themeId);
  });

  it("concurrent mints at the active limit cannot both pass (advisory lock serialises the count)", async () => {
    const a = await tenant();
    // growth allows 10 active; fill 9 directly
    for (let i = 0; i < 9; i += 1) {
      await admin.query(
        "INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, password_required, scope_project_ids, created_by) VALUES ($1,'x',$2,'abcdefgh',false,$3,$4)",
        [a.workspaceId, Buffer.from(randomUUID()), [a.projectId], a.actorId],
      );
    }
    // Deterministic overlap: a test-only trigger holds every insert open for 400 ms, so
    // each of the 20 attempts has already counted 9 before any insert lands. Without the
    // advisory lock all 20 pass the count and all 20 insert; with it they are serialised
    // and exactly one gets in. (Unsynchronised mints only overlapped by timing, which let
    // a missing lock survive roughly one run in five.)
    await admin.query(`CREATE FUNCTION public.hold_share_token_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`);
    await admin.query("CREATE TRIGGER hold_insert BEFORE INSERT ON share_tokens FOR EACH ROW EXECUTE FUNCTION public.hold_share_token_insert()");
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => inTenant(a, () => service.mint(request({ scope_project_ids: [a.projectId] }), meta))),
    );
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason?.code === "entitlement_exceeded")).toBe(true);
    expect((await admin.query("SELECT count(*)::int AS n FROM share_tokens")).rows[0]).toEqual({ n: 10 });
  });
});
