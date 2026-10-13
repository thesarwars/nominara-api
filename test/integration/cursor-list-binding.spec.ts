import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { InvitationsService } from "../../src/modules/workspaces/invitations.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { ValidationFailedError } from "../../src/api/errors/domain-errors.js";

// STORY-117 AC6 / scenario 6 — "Replay a members cursor against the invitations list: Refused — never a silent
// rewind to the first row". Members, invitations and the workspace list are all keyed on a 2-tuple
// (timestamp, uuid), so an ARITY pin cannot tell their cursors apart; the cursor has to name its list.
describe("STORY-117 · scenario 6 — a cursor is bound to the list that issued it (same arity)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaces: WorkspacesService;
  let invitations: InvitationsService;

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
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
    const membership = new MembershipService(new MembershipCacheService());
    workspaces = new WorkspacesService(
      pool,
      new LocalDekProvisioner(Buffer.alloc(32, 5), "local:dev"),
      new AuditChainService(),
      membership,
      new SessionService(pool, membership, new InMemoryCacheAdapter()),
      new NoopRealtimePublisher(),
    );
    invitations = new InvitationsService(pool, new AuditChainService());
  });

  afterEach(async () => {
    await pool.end();
    await db.end();
  });

  async function createUser(): Promise<string> {
    const r = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID()}@example.com`]);
    return r.rows[0]!.id;
  }

  async function inTenant<T>(workspaceId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId }, fn);
    } finally {
      client.release();
    }
  }

  const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  it("STORY-117 scenario 6 — a members cursor is refused by invitations, and each list refuses the others' cursors, with a 400", async () => {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `W ${randomUUID()}` }, meta);
    // A second member and two pending invitations, so every list has a next page at limit 1.
    const second = await createUser();
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId: ws.id, actorId: ownerId }, async (tx) => {
        await tx.query("INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')", [randomUUID(), ws.id, second]);
      });
    } finally {
      client.release();
    }
    for (let i = 0; i < 2; i++) {
      await inTenant(ws.id, ownerId, () => invitations.create(ws.id, ownerId, { email: `i${i}-${randomUUID()}@example.com`, role: "viewer" }));
    }
    // The actor also JOINS a second workspace, so the workspace list has a next page at limit 1.
    const otherOwner = await createUser();
    const other = await workspaces.create(otherOwner, { name: `W2 ${randomUUID()}` }, meta);
    const c2 = await pool.connect();
    try {
      await withTenantContext(c2, { workspaceId: other.id, actorId: otherOwner }, async (tx) => {
        await tx.query("INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')", [randomUUID(), other.id, ownerId]);
      });
    } finally {
      c2.release();
    }

    const membersCursor = (await inTenant(ws.id, ownerId, () => workspaces.listMembers({ limit: 1 }))).pagination.cursor_next;
    const invitesCursor = (await inTenant(ws.id, ownerId, () => invitations.list(ws.id, { limit: 1 }))).pagination.cursor_next;
    expect(membersCursor).not.toBeNull();
    expect(invitesCursor).not.toBeNull();
    const listCursor = (await workspaces.listForActor(ownerId, { limit: 1 })).pagination.cursor_next;
    expect(listCursor).not.toBeNull();

    // Positive control: each list still accepts its OWN cursor, so the refusals below are about the binding.
    await expect(inTenant(ws.id, ownerId, () => workspaces.listMembers({ limit: 1, cursor: membersCursor! }))).resolves.toBeDefined();
    await expect(inTenant(ws.id, ownerId, () => invitations.list(ws.id, { limit: 1, cursor: invitesCursor! }))).resolves.toBeDefined();

    await expect(inTenant(ws.id, ownerId, () => invitations.list(ws.id, { limit: 1, cursor: membersCursor! }))).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(inTenant(ws.id, ownerId, () => workspaces.listMembers({ limit: 1, cursor: invitesCursor! }))).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(workspaces.listForActor(ownerId, { limit: 1, cursor: membersCursor! })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(inTenant(ws.id, ownerId, () => workspaces.listMembers({ limit: 1, cursor: listCursor! }))).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(inTenant(ws.id, ownerId, () => invitations.list(ws.id, { limit: 1, cursor: listCursor! }))).rejects.toBeInstanceOf(ValidationFailedError);
  }, 60_000);
});
