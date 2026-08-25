import { randomUUID } from "node:crypto";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { REALTIME_EVENT_PAYLOADS } from "../../contracts/events/catalog.schema.js";
import { PAGINATION_LIMIT_DEFAULT } from "../../contracts/common/pagination.schema.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { PermissionDeniedException } from "../../src/tenancy/errors.js";

// STORY-021 — Test Scenarios 7, 8, 9 (E-9's two deliberately distinct
// ownership-refusal shapes). Real Postgres: updateMemberRole/removeMemberById
// both read the ambient transaction via currentTenantStore()!.client, so they
// are exercised here inside a real withTenantContext, the same seam the
// controller opens through TenantContextInterceptor.

const WRAPPING_KEY = Buffer.alloc(32, 3);

describe("STORY-021 · member listing, role changes, and removal within the matrix", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let service: WorkspacesService;
  let realtime: NoopRealtimePublisher;

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

    pool = new Pool({ connectionString: container.getConnectionUri() });
    const membership = new MembershipService(new MembershipCacheService());
    realtime = new NoopRealtimePublisher();
    service = new WorkspacesService(
      pool,
      new LocalDekProvisioner(WRAPPING_KEY, "local:dev"),
      new AuditChainService(),
      membership,
      new SessionService(pool),
      realtime,
    );
  });

  afterEach(async () => {
    await pool.end();
    await db.end();
  });

  const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  async function createUser(email = `user-${randomUUID()}@example.com`): Promise<string> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [email]);
    return result.rows[0]!.id;
  }

  interface Fixture {
    workspaceId: string;
    ownerId: string;
    ownerMemberId: string;
    adminId: string;
    adminMemberId: string;
    viewerId: string;
    viewerMemberId: string;
  }

  async function makeFixture(): Promise<Fixture> {
    const ownerId = await createUser();
    const workspace = await service.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const adminId = await createUser();
    const viewerId = await createUser();

    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId: workspace.id, actorId: ownerId }, async (tx) => {
        await tx.query(
          "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'admin','active')",
          [randomUUID(), workspace.id, adminId],
        );
        await tx.query(
          "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')",
          [randomUUID(), workspace.id, viewerId],
        );
      });
    } finally {
      client.release();
    }

    const rows = await db.query<{ id: string; user_id: string; role: string }>(
      "SELECT id, user_id, role FROM workspace_members WHERE workspace_id = $1",
      [workspace.id],
    );
    const ownerMemberId = rows.rows.find((r) => r.role === "owner")!.id;
    const adminMemberId = rows.rows.find((r) => r.user_id === adminId)!.id;
    const viewerMemberId = rows.rows.find((r) => r.user_id === viewerId)!.id;

    return { workspaceId: workspace.id, ownerId, ownerMemberId, adminId, adminMemberId, viewerId, viewerMemberId };
  }

  async function runInTenant<T>(workspaceId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId }, fn);
    } finally {
      client.release();
    }
  }

  // ---- scenario 7 ---------------------------------------------------------

  it("scenario 7 — an admin attempting to grant ownership through a role change is refused, naming the required permission", async () => {
    const f = await makeFixture();

    await expect(
      runInTenant(f.workspaceId, f.adminId, () =>
        service.updateMemberRole(f.workspaceId, "admin", f.viewerMemberId, { role: "owner" }),
      ),
    ).rejects.toMatchObject({
      response: { code: "forbidden", details: { required_permission: "workspace:transfer_ownership" } },
    });

    const isViewerStillOwnerless = await db.query<{ role: string }>(
      "SELECT role FROM workspace_members WHERE id = $1",
      [f.viewerMemberId],
    );
    expect(isViewerStillOwnerless.rows[0]!.role).toBe("viewer");
  });

  it("scenario 7 companion — the owner naming 'owner' in a role change is permitted but refused as the wrong path, not forbidden", async () => {
    const f = await makeFixture();

    await expect(
      runInTenant(f.workspaceId, f.ownerId, () =>
        service.updateMemberRole(f.workspaceId, "owner", f.viewerMemberId, { role: "owner" }),
      ),
    ).rejects.toMatchObject({
      response: { code: "conflict", details: { reason: "ownership_requires_transfer" } },
    });
  });

  it("an admin changing a non-owner member's role (not to owner) succeeds", async () => {
    const f = await makeFixture();

    const updated = await runInTenant(f.workspaceId, f.adminId, () =>
      service.updateMemberRole(f.workspaceId, "admin", f.viewerMemberId, { role: "analyst" }),
    );
    expect(updated.role).toBe("analyst");

    const row = await db.query<{ role: string }>("SELECT role FROM workspace_members WHERE id = $1", [
      f.viewerMemberId,
    ]);
    expect(row.rows[0]!.role).toBe("analyst");
  });

  // ---- scenario 8 ---------------------------------------------------------

  it("scenario 8 — an admin attempting to remove the owner is refused, and ownership transfer is named as the remedy", async () => {
    const f = await makeFixture();

    await expect(
      runInTenant(f.workspaceId, f.adminId, () => service.removeMemberById(f.workspaceId, f.ownerMemberId)),
    ).rejects.toMatchObject({
      response: { code: "conflict", details: { reason: "owner_removal_requires_transfer" } },
    });

    const row = await db.query<{ status: string }>("SELECT status FROM workspace_members WHERE id = $1", [
      f.ownerMemberId,
    ]);
    expect(row.rows[0]!.status).toBe("active");
  });

  it("scenario 8 companion — an admin demoting the owner via a role change is refused the same way", async () => {
    const f = await makeFixture();

    await expect(
      runInTenant(f.workspaceId, f.adminId, () =>
        service.updateMemberRole(f.workspaceId, "admin", f.ownerMemberId, { role: "viewer" }),
      ),
    ).rejects.toMatchObject({
      response: { code: "conflict", details: { reason: "owner_removal_requires_transfer" } },
    });
  });

  // ---- scenario 9 ---------------------------------------------------------

  it("scenario 9 — the owner attempting to remove themselves is refused; only transfer works", async () => {
    const f = await makeFixture();

    await expect(
      runInTenant(f.workspaceId, f.ownerId, () => service.removeMemberById(f.workspaceId, f.ownerMemberId)),
    ).rejects.toMatchObject({
      response: { code: "conflict", details: { reason: "owner_removal_requires_transfer" } },
    });
  });

  it("scenario 9 companion — the owner attempting to demote themselves is refused, preventing an orphaned workspace", async () => {
    const f = await makeFixture();

    await expect(
      runInTenant(f.workspaceId, f.ownerId, () =>
        service.updateMemberRole(f.workspaceId, "owner", f.ownerMemberId, { role: "viewer" }),
      ),
    ).rejects.toMatchObject({
      response: { code: "conflict", details: { reason: "owner_removal_requires_transfer" } },
    });
  });

  // ---- baseline: listing and removal of a non-owner member ---------------

  it("member listing returns every non-removed member, and removal excludes a member from a subsequent listing", async () => {
    const f = await makeFixture();

    const before = (await runInTenant(f.workspaceId, f.ownerId, () => service.listMembers({ limit: PAGINATION_LIMIT_DEFAULT }))).items;
    expect(before).toHaveLength(3);
    expect(before.map((m) => m.role).sort()).toEqual(["admin", "owner", "viewer"]);

    await runInTenant(f.workspaceId, f.adminId, () => service.removeMemberById(f.workspaceId, f.viewerMemberId));

    const after = (await runInTenant(f.workspaceId, f.ownerId, () => service.listMembers({ limit: PAGINATION_LIMIT_DEFAULT }))).items;
    expect(after).toHaveLength(2);
    expect(after.some((m) => m.id === f.viewerMemberId)).toBe(false);

    const row = await db.query<{ status: string }>("SELECT status FROM workspace_members WHERE id = $1", [
      f.viewerMemberId,
    ]);
    expect(row.rows[0]!.status).toBe("removed");
  });

  it("updating a member id that does not exist is a 404", async () => {
    const f = await makeFixture();
    await expect(
      runInTenant(f.workspaceId, f.ownerId, () =>
        service.updateMemberRole(f.workspaceId, "owner", randomUUID(), { role: "viewer" }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("smoke — PermissionDeniedException import matches the shape asserted above", () => {
    const err = new PermissionDeniedException("workspace:transfer_ownership");
    expect(err.getResponse()).toMatchObject({
      code: "forbidden",
      details: { required_permission: "workspace:transfer_ownership" },
    });
  });

  // ---- STORY-026 T22 / decision D7 — member.changed --------------------

  describe("STORY-026 · member.changed forces socket re-auth", () => {
    it("is emitted when a member's role changes", async () => {
      const f = await makeFixture();
      await runInTenant(f.workspaceId, f.ownerId, () =>
        service.updateMemberRole(f.workspaceId, "owner", f.viewerMemberId, { role: "analyst" }),
      );

      expect(realtime.published).toHaveLength(1);
      expect(realtime.published[0]).toEqual({
        workspaceId: f.workspaceId,
        event: "member.changed",
        payload: { workspace_id: f.workspaceId, user_id: f.viewerId, role: "analyst", status: "active" },
      });
    });

    it("is emitted when a member is removed, carrying status removed", async () => {
      // The case that matters most. §11 notes this event "forces socket
      // re-auth", and without it the only thing closing the window between a
      // removal and the socket noticing is the gateway's 60-second
      // re-validation timer (security-and-tenancy.md §7).
      const f = await makeFixture();
      await runInTenant(f.workspaceId, f.ownerId, () => service.removeMemberById(f.workspaceId, f.viewerMemberId));

      expect(realtime.published).toHaveLength(1);
      expect(realtime.published[0]!.event).toBe("member.changed");
      expect(realtime.published[0]!.payload).toMatchObject({ user_id: f.viewerId, status: "removed" });
    });

    it("publishes to the workspace's own room and no other", async () => {
      const f = await makeFixture();
      await runInTenant(f.workspaceId, f.ownerId, () => service.removeMemberById(f.workspaceId, f.viewerMemberId));
      expect(realtime.published[0]!.workspaceId).toBe(f.workspaceId);
    });

    it("emits nothing when the mutation is REFUSED", async () => {
      // An event announcing a change that did not happen would make every
      // client refetch and see the old state — and, for a removal, would tell
      // a workspace someone had been removed when they had not.
      const f = await makeFixture();
      await expect(
        runInTenant(f.workspaceId, f.ownerId, () => service.removeMemberById(f.workspaceId, f.ownerMemberId)),
      ).rejects.toThrow();
      expect(realtime.published).toHaveLength(0);
    });

    it("carries a payload the published catalog accepts", async () => {
      const f = await makeFixture();
      await runInTenant(f.workspaceId, f.ownerId, () => service.removeMemberById(f.workspaceId, f.viewerMemberId));
      const parsed = REALTIME_EVENT_PAYLOADS["member.changed"].safeParse(realtime.published[0]!.payload);
      expect(parsed.success, "a producer must not emit a shape the catalog does not describe").toBe(true);
    });
  });
});
