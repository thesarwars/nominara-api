import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { grantSupportAccess, revokeSupportAccess } from "../../src/lib/support/support-grants.js";
import { SupportGrantsService } from "../../src/modules/trust/support-grants.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import type { SupportGrantCreateInput } from "../../contracts/trust/access-grant.schema.js";

// NEW-D-5 — support_grants is tenant-scoped. Runs as the real `nominara_app`
// role: a superuser connection would pass a cross-tenant assertion vacuously.
describe("NEW-D-5 · support grants under RLS, as nominara_app", () => {
  let container: StartedPostgreSqlContainer;
  let admin: Client;
  const service = new SupportGrantsService();

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

  async function workspace(): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1::uuid, $1::text, $1::text, 'business')", [id]);
    return id;
  }
  async function user(): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1, $2, now(), 'active')", [id, `${id}@example.test`]);
    return id;
  }
  async function inTenant<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const app = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
    });
    await app.connect();
    try {
      return await withTenantContext(app, { workspaceId, actorId: randomUUID() }, fn);
    } finally {
      await app.end();
    }
  }
  async function inTenantTx<T>(workspaceId: string, fn: (tx: import("pg").ClientBase) => Promise<T>): Promise<T> {
    const app = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
    });
    await app.connect();
    try {
      return await withTenantContext(app, { workspaceId, actorId: randomUUID() }, () => fn(app));
    } finally {
      await app.end();
    }
  }

  const input = (workspace_id: string, requested_by: string, approved_by: string, over: Partial<SupportGrantCreateInput> = {}): SupportGrantCreateInput => ({
    workspace_id,
    requested_by,
    approved_by,
    scope: "metadata",
    allow_write: false,
    justification: "investigating a failed capture",
    ticket_ref: "SUP-42",
    ttl_minutes: 60,
    operator: "alice",
    ...over,
  });
  const page = (limit = 50, cursor?: string) => service.list({ limit, ...(cursor === undefined ? {} : { cursor }) });

  it("NEW-D-5 AC4 · a grant on workspace B is invisible to workspace A (RLS only)", async () => {
    const [a, b, u1, u2] = [await workspace(), await workspace(), await user(), await user()];
    await inTenantTx(b, (tx) => grantSupportAccess(tx, input(b, u1, u2)));
    expect((await inTenant(a, () => page())).items).toEqual([]);
    expect((await inTenant(b, () => page())).items).toHaveLength(1);
  });

  it("NEW-D-5 AC1 · only active grants are listed: revoked and expired ones are not", async () => {
    const [a, u1, u2] = [await workspace(), await user(), await user()];
    const live = await inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u2, { ticket_ref: "LIVE", scope: "full", allow_write: true })));
    const gone = await inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u2, { ticket_ref: "GONE" })));
    await inTenantTx(a, (tx) => revokeSupportAccess(tx, { workspaceId: a, grantId: gone.id, operator: "alice" }));
    await admin.query(
      "INSERT INTO support_grants (workspace_id, requested_by, approved_by, scope, justification, ticket_ref, expires_at) VALUES ($1,$2,$3,'metadata','j','EXPIRED', now() - interval '1 second')",
      [a, u1, u2],
    );
    const listed = (await inTenant(a, () => page())).items;
    expect(listed.map((g) => g.id)).toEqual([live.id]);
    expect(listed[0]).toMatchObject({ scope: "full", allow_write: true, ticket_ref: "LIVE", justification: "investigating a failed capture" });
    expect(Object.keys(listed[0]!).sort()).toEqual(["allow_write", "created_at", "expires_at", "id", "justification", "scope", "ticket_ref"]);
  });

  it("NEW-D-5 AC1 · a grant expiring exactly now is not active (expires_at > now(), strict)", async () => {
    const [a, u1, u2] = [await workspace(), await user(), await user()];
    await admin.query(
      "INSERT INTO support_grants (workspace_id, requested_by, approved_by, scope, justification, ticket_ref, expires_at) VALUES ($1,$2,$3,'metadata','j','T', now())",
      [a, u1, u2],
    );
    expect((await inTenant(a, () => page())).items).toEqual([]);
  });

  it("NEW-D-5 AC1 · the list pages by cursor without skipping or repeating", async () => {
    const [a, u1, u2] = [await workspace(), await user(), await user()];
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u2, { ticket_ref: `T${String(i)}` })))).id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 5; guard += 1) {
      const p = await inTenant(a, () => page(2, cursor));
      seen.push(...p.items.map((g) => g.id));
      if (p.pagination.cursor_next === null) break;
      cursor = p.pagination.cursor_next;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("NEW-D-5 AC2 · ck_support_dual_control makes self-approval impossible, as the runtime role and as a superuser", async () => {
    const [a, u1] = [await workspace(), await user()];
    await expect(inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u1)))).rejects.toThrow();
    await expect(
      admin.query(
        "INSERT INTO support_grants (workspace_id, requested_by, approved_by, scope, justification, ticket_ref, expires_at) VALUES ($1,$2,$2,'metadata','j','T', now() + interval '1 hour')",
        [a, u1],
      ),
    ).rejects.toMatchObject({ constraint: "ck_support_dual_control" });
    expect((await admin.query("SELECT count(*)::int AS n FROM support_grants")).rows[0]).toEqual({ n: 0 });
  });

  it("NEW-D-5 AC2 · a TTL above 4 hours is refused by the write function, with nothing stored", async () => {
    const [a, u1, u2] = [await workspace(), await user(), await user()];
    await expect(inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u2, { ttl_minutes: 241 })))).rejects.toThrow();
    expect((await admin.query("SELECT count(*)::int AS n FROM support_grants")).rows[0]).toEqual({ n: 0 });
  });

  const rawInsert = (a: string, u1: string, u2: string, minutes: number) => (tx: import("pg").ClientBase) =>
    tx.query(
      "INSERT INTO support_grants (workspace_id, requested_by, approved_by, scope, justification, ticket_ref, expires_at) VALUES ($1,$2,$3,'metadata','j','T', now() + make_interval(mins => $4::int)) RETURNING id",
      [a, u1, u2, minutes],
    );

  it("NEW-D-5 audit · the 4 h ceiling is in the schema: a direct 241-minute INSERT as nominara_app is refused with 23514", async () => {
    const [a, u1, u2] = [await workspace(), await user(), await user()];
    await expect(inTenantTx(a, (tx) => rawInsert(a, u1, u2, 241)(tx))).rejects.toMatchObject({ code: "23514" });
    await expect(inTenantTx(a, (tx) => rawInsert(a, u1, u2, 240)(tx))).resolves.toBeDefined();
    expect((await admin.query("SELECT count(*)::int AS n FROM support_grants")).rows[0]).toEqual({ n: 1 });
  });

  it("NEW-D-5 audit · nominara_app cannot extend a grant: UPDATE of expires_at or created_at is refused (42501); revoking still works", async () => {
    const [a, u1, u2] = [await workspace(), await user(), await user()];
    const g = await inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u2, { ttl_minutes: 60 })));
    await expect(inTenantTx(a, (tx) => tx.query("UPDATE support_grants SET expires_at = now() + interval '10 hours' WHERE id = $1", [g.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(inTenantTx(a, (tx) => tx.query("UPDATE support_grants SET created_at = now() + interval '10 hours' WHERE id = $1", [g.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(inTenantTx(a, (tx) => revokeSupportAccess(tx, { workspaceId: a, grantId: g.id, operator: "alice" }))).resolves.toEqual({ revoked: true });
  });

  it("NEW-D-5 AC2 · expires_at is now() + the TTL, computed by the database clock", async () => {
    const [a, u1, u2] = [await workspace(), await user(), await user()];
    const g = await inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u2, { ttl_minutes: 240 })));
    const row = (await admin.query("SELECT extract(epoch FROM (expires_at - created_at)) AS s FROM support_grants WHERE id = $1", [g.id])).rows[0] as { s: string };
    expect(Number(row.s)).toBe(240 * 60);
  });

  it("NEW-D-5 AC3 · granting writes an audit row, in the same transaction, naming the grant but not carrying staff identities in clear text beyond ids", async () => {
    const [a, u1, u2] = [await workspace(), await user(), await user()];
    const g = await inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u2)));
    const rows = (await admin.query("SELECT action, resource_type, resource_id, actor_type, severity, after_state FROM audit_log WHERE workspace_id = $1", [a])).rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "support.grant_created", resource_type: "support_grant", resource_id: g.id, actor_type: "system" });
    expect(rows[0]!["after_state"]).toMatchObject({ scope: "metadata", ticket_ref: "SUP-42", operator: "alice" });
  });

  it("NEW-D-5 AC3 · a failed grant leaves no audit row (the insert and the audit row commit together)", async () => {
    const [a, u1] = [await workspace(), await user()];
    await expect(inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u1)))).rejects.toThrow();
    expect((await admin.query("SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = $1", [a])).rows[0]).toEqual({ n: 0 });
  });

  it("NEW-D-5 AC3 · revoking writes an audit row; the grant leaves the list at once; a second revoke is a no-op with no second audit row", async () => {
    const [a, u1, u2] = [await workspace(), await user(), await user()];
    const g = await inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u2)));
    expect(await inTenantTx(a, (tx) => revokeSupportAccess(tx, { workspaceId: a, grantId: g.id, operator: "bob" }))).toEqual({ revoked: true });
    expect((await inTenant(a, () => page())).items).toEqual([]);
    expect(await inTenantTx(a, (tx) => revokeSupportAccess(tx, { workspaceId: a, grantId: g.id, operator: "bob" }))).toEqual({ revoked: false });
    const rows = (await admin.query("SELECT action, resource_id FROM audit_log WHERE workspace_id = $1 ORDER BY seq", [a])).rows;
    expect(rows).toEqual([
      { action: "support.grant_created", resource_id: g.id },
      { action: "support.grant_revoked", resource_id: g.id },
    ]);
  });

  it("NEW-D-5 AC4 · workspace B's context cannot revoke workspace A's grant", async () => {
    const [a, b, u1, u2] = [await workspace(), await workspace(), await user(), await user()];
    const g = await inTenantTx(a, (tx) => grantSupportAccess(tx, input(a, u1, u2)));
    expect(await inTenantTx(b, (tx) => revokeSupportAccess(tx, { workspaceId: b, grantId: g.id, operator: "bob" }))).toEqual({ revoked: false });
    expect((await admin.query("SELECT revoked_at FROM support_grants WHERE id = $1", [g.id])).rows[0]).toEqual({ revoked_at: null });
  });
});
