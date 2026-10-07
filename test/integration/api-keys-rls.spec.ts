import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { ApiKeysService } from "../../src/modules/api-keys/api-keys.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import type { CreateApiKeyRequest } from "../../contracts/workspaces/api-key.schema.js";

// NEW-D-4 — api_keys is tenant-scoped and the service carries no
// workspace_id predicate for correctness, so RLS is the whole guarantee. Runs as
// the real `nominara_app` role: the HTTP harness uses a superuser connection,
// which would pass a cross-tenant assertion vacuously.
describe("NEW-D-4 · ApiKeysService under RLS, as nominara_app", () => {
  let container: StartedPostgreSqlContainer;
  let admin: Client;
  const service = new ApiKeysService();

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
  }

  async function tenant(plan = "business"): Promise<Tenant> {
    const workspaceId = randomUUID();
    const actorId = randomUUID();
    await admin.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1::uuid, $1::text, $1::text, $2)", [workspaceId, plan]);
    await admin.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1, $2, now(), 'active')", [actorId, `${actorId}@example.test`]);
    return { workspaceId, actorId };
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

  const request = (over: Partial<CreateApiKeyRequest> = {}): CreateApiKeyRequest => ({
    name: "k",
    permissions: ["project:read"],
    project_scope: null,
    expires_at: null,
    ...over,
  });

  it("NEW-D-4 AC5 · workspace B cannot list or revoke workspace A's key (404, not 403), and the key is left untouched", async () => {
    const a = await tenant();
    const b = await tenant();
    const created = await inTenant(a, () => service.create("owner", request()));

    expect(await inTenant(b, () => service.list())).toEqual([]);
    await expect(inTenant(b, () => service.revoke(created.key.id))).rejects.toBeInstanceOf(NotFoundError);
    const stored = await admin.query("SELECT revoked_at FROM api_keys WHERE id = $1", [created.key.id]);
    expect((stored.rows[0] as { revoked_at: unknown }).revoked_at).toBeNull();
    expect((await inTenant(a, () => service.list())).map((k) => k.id)).toEqual([created.key.id]);
  });

  it("NEW-D-4 AC5 · a project_scope naming another workspace's project is a validation failure that stores nothing", async () => {
    const a = await tenant();
    const b = await tenant();
    const foreign = randomUUID();
    await admin.query(
      "INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://b.test','b.test')",
      [foreign, b.workspaceId, `p-${foreign.slice(0, 8)}`],
    );
    await expect(inTenant(a, () => service.create("owner", request({ project_scope: [foreign] })))).rejects.toMatchObject({ code: "validation_failed" });
    expect((await admin.query("SELECT count(*)::int AS n FROM api_keys")).rows[0]).toEqual({ n: 0 });
  });

  it("NEW-D-4 AC4 · concurrent creates at the limit cannot both pass (advisory lock serialises the count)", async () => {
    const a = await tenant();
    // business allows 3; fill 2 directly
    for (let i = 0; i < 2; i += 1) {
      await admin.query(
        "INSERT INTO api_keys (workspace_id, name, key_prefix, key_hash, permissions, created_by) VALUES ($1,'x','nk_live_abcd',$2,'{project:read}',$3)",
        [a.workspaceId, Buffer.from(randomUUID()), a.actorId],
      );
    }
    const settled = await Promise.allSettled([1, 2, 3].map(() => inTenant(a, () => service.create("owner", request()))));
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason?.code === "entitlement_exceeded")).toBe(true);
    expect((await admin.query("SELECT count(*)::int AS n FROM api_keys")).rows[0]).toEqual({ n: 3 });
  });

  it("NEW-D-4 AC4 · an expired or revoked key does not count against the limit", async () => {
    const a = await tenant();
    await admin.query(
      "INSERT INTO api_keys (workspace_id, name, key_prefix, key_hash, permissions, created_by, expires_at) VALUES ($1,'x','nk_live_abcd',$2,'{project:read}',$3, now() - interval '1 day')",
      [a.workspaceId, Buffer.from(randomUUID()), a.actorId],
    );
    await admin.query(
      "INSERT INTO api_keys (workspace_id, name, key_prefix, key_hash, permissions, created_by, revoked_at) VALUES ($1,'x','nk_live_abcd',$2,'{project:read}',$3, now())",
      [a.workspaceId, Buffer.from(randomUUID()), a.actorId],
    );
    for (let i = 0; i < 3; i += 1) await inTenant(a, () => service.create("owner", request()));
    await expect(inTenant(a, () => service.create("owner", request()))).rejects.toMatchObject({ code: "entitlement_exceeded" });
  });
});
