import { randomUUID } from "node:crypto";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { PAGINATION_LIMIT_DEFAULT } from "../../contracts/common/pagination.schema.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { InvitationsService } from "../../src/modules/workspaces/invitations.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { hashInvitationToken } from "../../src/lib/auth/invitation-token.js";
import { InvitationInvalidException } from "../../src/tenancy/errors.js";

// STORY-021 — Test Scenarios 10, 11, 12 (E-6/E-7). Real Postgres: E-7's
// uniform-timing claim can only be measured honestly against real query
// latency, not a mocked pg client, and the ux_invitations_pending supersede
// path depends on the real partial unique index (migration 0002/0012 area).

const WRAPPING_KEY = Buffer.alloc(32, 5);
// E-7 tolerance: the invite path never queries `users`, so both branches do
// the same fixed amount of work (one revoke UPDATE, one INSERT) — any gap
// here would come from scheduler/container jitter, not a real timing signal.
// 25ms is generous relative to the sub-5ms typical query time observed
// locally against the testcontainer, while still catching a real regression
// (e.g. an accidentally added `SELECT ... FROM users` existence check, which
// would add a whole extra round trip, not a few ms).
const TIMING_TOLERANCE_MS = 25;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

describe("STORY-021 · invitations — creation, uniform timing, acceptance, and supersede", () => {
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

    pool = new Pool({ connectionString: container.getConnectionUri(), max: 25 });
    const membership = new MembershipService(new MembershipCacheService());
    workspaces = new WorkspacesService(
      pool,
      new LocalDekProvisioner(WRAPPING_KEY, "local:dev"),
      new AuditChainService(),
      membership,
      new SessionService(pool, membership, new InMemoryCacheAdapter()), new NoopRealtimePublisher());
    invitations = new InvitationsService(pool, new AuditChainService());
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

  async function createInWorkspaceContext<T>(workspaceId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId }, fn);
    } finally {
      client.release();
    }
  }

  // ---- scenario 10 ---------------------------------------------------------

  it("scenario 10 — inviting a known address and an unknown address returns identical response shapes", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const knownEmail = `known-${randomUUID()}@example.com`;
    await createUser(knownEmail);
    const unknownEmail = `unknown-${randomUUID()}@example.com`;

    const knownResponse = await createInWorkspaceContext(workspace.id, ownerId, () =>
      invitations.create(workspace.id, ownerId, { email: knownEmail, role: "viewer" }),
    );
    const unknownResponse = await createInWorkspaceContext(workspace.id, ownerId, () =>
      invitations.create(workspace.id, ownerId, { email: unknownEmail, role: "viewer" }),
    );

    const shapeOf = (r: typeof knownResponse) => ({ ...r, id: undefined, email: undefined, token: undefined, expires_at: undefined, created_at: undefined });
    expect(shapeOf(knownResponse)).toEqual(shapeOf(unknownResponse));
    expect(Object.keys(knownResponse).sort()).toEqual(Object.keys(unknownResponse).sort());
  });

  // qa-reviewer mutation testing, STORY-021 close-out — gap 2: the previous
  // version of this test only spied on the ambient `tx`, missing any query
  // issued via `pool.query(...)` directly, and stringified call[0] with
  // `String()`, which collapses a `{ text, values }` QueryConfig object to
  // the literal string "[object Object]" (silently passing regardless of
  // its actual SQL text) — and had no assertion that any query happened at
  // all, so an empty `spy.mock.calls` array passed vacuously.
  function sqlTextOf(call: unknown[]): string {
    const first = call[0];
    if (typeof first === "string") {
      return first;
    }
    if (first && typeof first === "object" && "text" in first) {
      return String((first as { text: unknown }).text);
    }
    return String(first);
  }

  it("scenario 10 — the invite path never issues SQL referencing the users table, for a known or an unknown address", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const knownEmail = `known-${randomUUID()}@example.com`;
    await createUser(knownEmail);
    const unknownEmail = `unknown-${randomUUID()}@example.com`;

    for (const email of [knownEmail, unknownEmail]) {
      const client = await pool.connect();
      const poolSpy = vi.spyOn(pool, "query");
      try {
        await withTenantContext(client, { workspaceId: workspace.id, actorId: ownerId }, async (tx) => {
          const txSpy = vi.spyOn(tx, "query");
          await invitations.create(workspace.id, ownerId, { email, role: "viewer" });

          const allCalls = [...txSpy.mock.calls, ...poolSpy.mock.calls];
          expect(allCalls.length).toBeGreaterThan(0);
          for (const call of allCalls) {
            expect(sqlTextOf(call)).not.toMatch(/\busers\b/i);
          }
        });
      } finally {
        poolSpy.mockRestore();
        client.release();
      }
    }
  });

  it(
    "scenario 10 — median creation latency for a known address and an unknown address is within tolerance",
    async () => {
      const ownerId = await createUser();
      const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
      const sampleCount = 20;

      const knownDurations: number[] = [];
      const unknownDurations: number[] = [];

      for (let i = 0; i < sampleCount; i++) {
        const knownEmail = `known-${i}-${randomUUID()}@example.com`;
        await createUser(knownEmail);
        const client = await pool.connect();
        try {
          const start = performance.now();
          await withTenantContext(client, { workspaceId: workspace.id, actorId: ownerId }, () =>
            invitations.create(workspace.id, ownerId, { email: knownEmail, role: "viewer" }),
          );
          knownDurations.push(performance.now() - start);
        } finally {
          client.release();
        }

        const unknownEmail = `unknown-${i}-${randomUUID()}@example.com`;
        const client2 = await pool.connect();
        try {
          const start = performance.now();
          await withTenantContext(client2, { workspaceId: workspace.id, actorId: ownerId }, () =>
            invitations.create(workspace.id, ownerId, { email: unknownEmail, role: "viewer" }),
          );
          unknownDurations.push(performance.now() - start);
        } finally {
          client2.release();
        }
      }

      const knownMedian = median(knownDurations);
      const unknownMedian = median(unknownDurations);
      expect(Math.abs(knownMedian - unknownMedian)).toBeLessThan(TIMING_TOLERANCE_MS);
    },
    30_000,
  );

  it("the raw invitation token is never persisted — only its sha256 hash is stored, and list() never returns a token", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const email = `invitee-${randomUUID()}@example.com`;

    const created = await createInWorkspaceContext(workspace.id, ownerId, () =>
      invitations.create(workspace.id, ownerId, { email, role: "viewer" }),
    );
    expect(typeof created.token).toBe("string");

    const row = await db.query<{ token_hash: Buffer }>("SELECT token_hash FROM workspace_invitations WHERE id = $1", [
      created.id,
    ]);
    expect(row.rows[0]!.token_hash).toEqual(hashInvitationToken(created.token!));
    expect(row.rows[0]!.token_hash.toString("utf8")).not.toContain(created.token);

    const list = (await createInWorkspaceContext(workspace.id, ownerId, () => invitations.list(workspace.id, { limit: PAGINATION_LIMIT_DEFAULT }))).items;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("token");
  });

  // ---- scenario 11 ---------------------------------------------------------

  it("scenario 11 — accepting an invitation creates a scoped membership without touching the invitee's own entitlement", async () => {
    const inviterOwnerId = await createUser();
    const targetWorkspace = await workspaces.create(inviterOwnerId, { name: `Target ${randomUUID()}` }, meta);

    // The invitee already owns their own free-plan (zero-project) workspace.
    const inviteeId = await createUser();
    const inviteeOwnWorkspace = await workspaces.create(inviteeId, { name: `Invitee Own ${randomUUID()}` }, meta);
    const beforeSubscription = await db.query(
      "SELECT plan_key, status, current_period_end FROM subscriptions WHERE workspace_id = $1",
      [inviteeOwnWorkspace.id],
    );
    const beforeWorkspace = await db.query("SELECT entitlement_version, plan_key FROM workspaces WHERE id = $1", [
      inviteeOwnWorkspace.id,
    ]);

    const projectScope = [randomUUID(), randomUUID()];
    const invitation = await createInWorkspaceContext(targetWorkspace.id, inviterOwnerId, () =>
      invitations.create(targetWorkspace.id, inviterOwnerId, {
        email: "unused-lookup@example.com",
        role: "manager",
        project_scope: projectScope,
      }),
    );
    // accept() resolves the invitee purely from (workspaceId, token) — never
    // from the invitation's own email — so any authenticated user presenting
    // the right token is the one who gets the membership. Overwrite the
    // token's owner intent isn't tested here; the acceptance contract is
    // "this token, this workspace, this caller".

    const memberResponse = await invitations.accept(targetWorkspace.id, inviteeId, invitation.token!, meta);

    expect(memberResponse.role).toBe("manager");
    expect(memberResponse.project_scope).toEqual(projectScope);
    expect(memberResponse.user_id).toBe(inviteeId);

    const afterSubscription = await db.query(
      "SELECT plan_key, status, current_period_end FROM subscriptions WHERE workspace_id = $1",
      [inviteeOwnWorkspace.id],
    );
    const afterWorkspace = await db.query("SELECT entitlement_version, plan_key FROM workspaces WHERE id = $1", [
      inviteeOwnWorkspace.id,
    ]);
    expect(afterSubscription.rows).toEqual(beforeSubscription.rows);
    expect(afterWorkspace.rows).toEqual(beforeWorkspace.rows);

    const subscriptionCount = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM subscriptions WHERE workspace_id = $1",
      [inviteeOwnWorkspace.id],
    );
    expect(Number(subscriptionCount.rows[0]!.count)).toBe(1);
  });

  it("scenario 11 — accept() leaves the target workspace's own subscription row untouched (no new or modified row)", async () => {
    const inviterOwnerId = await createUser();
    const targetWorkspace = await workspaces.create(inviterOwnerId, { name: `Target ${randomUUID()}` }, meta);
    const inviteeId = await createUser();

    const invitation = await createInWorkspaceContext(targetWorkspace.id, inviterOwnerId, () =>
      invitations.create(targetWorkspace.id, inviterOwnerId, { email: "unused@example.com", role: "viewer" }),
    );
    const before = await db.query("SELECT * FROM subscriptions WHERE workspace_id = $1", [targetWorkspace.id]);

    await invitations.accept(targetWorkspace.id, inviteeId, invitation.token!, meta);

    const after = await db.query("SELECT * FROM subscriptions WHERE workspace_id = $1", [targetWorkspace.id]);
    expect(after.rows).toEqual(before.rows);
  });

  it("accepting an unknown, expired, revoked, or already-accepted token all fail with the identical uniform message", async () => {
    const inviterOwnerId = await createUser();
    const targetWorkspace = await workspaces.create(inviterOwnerId, { name: `Target ${randomUUID()}` }, meta);
    const inviteeId = await createUser();

    const unknown = "not-a-real-token";
    await expect(invitations.accept(targetWorkspace.id, inviteeId, unknown, meta)).rejects.toBeInstanceOf(
      InvitationInvalidException,
    );

    const expiredInvitation = await createInWorkspaceContext(targetWorkspace.id, inviterOwnerId, () =>
      invitations.create(targetWorkspace.id, inviterOwnerId, { email: "expired@example.com", role: "viewer" }),
    );
    await db.query("UPDATE workspace_invitations SET expires_at = now() - interval '1 day' WHERE id = $1", [
      expiredInvitation.id,
    ]);

    const revokedInvitation = await createInWorkspaceContext(targetWorkspace.id, inviterOwnerId, () =>
      invitations.create(targetWorkspace.id, inviterOwnerId, { email: "revoked@example.com", role: "viewer" }),
    );
    await db.query("UPDATE workspace_invitations SET revoked_at = now() WHERE id = $1", [revokedInvitation.id]);

    const acceptedInvitation = await createInWorkspaceContext(targetWorkspace.id, inviterOwnerId, () =>
      invitations.create(targetWorkspace.id, inviterOwnerId, { email: "accepted@example.com", role: "viewer" }),
    );
    const firstAccepter = await createUser();
    await invitations.accept(targetWorkspace.id, firstAccepter, acceptedInvitation.token!, meta);

    const errors: unknown[] = [];
    for (const token of [expiredInvitation.token!, revokedInvitation.token!, acceptedInvitation.token!]) {
      try {
        const secondAccepter = await createUser();
        await invitations.accept(targetWorkspace.id, secondAccepter, token, meta);
        throw new Error("expected accept() to reject");
      } catch (error) {
        errors.push(error);
      }
    }

    for (const error of errors) {
      expect(error).toBeInstanceOf(InvitationInvalidException);
      expect((error as InvitationInvalidException).message).toBe(
        "this invitation is invalid, expired, or already used",
      );
    }
  });

  it("accepting the same invitation twice for a user who is already an active member is idempotent, not an error", async () => {
    const inviterOwnerId = await createUser();
    const targetWorkspace = await workspaces.create(inviterOwnerId, { name: `Target ${randomUUID()}` }, meta);
    const inviteeId = await createUser();

    const first = await createInWorkspaceContext(targetWorkspace.id, inviterOwnerId, () =>
      invitations.create(targetWorkspace.id, inviterOwnerId, { email: "dup@example.com", role: "viewer" }),
    );
    const firstMember = await invitations.accept(targetWorkspace.id, inviteeId, first.token!, meta);

    const second = await createInWorkspaceContext(targetWorkspace.id, inviterOwnerId, () =>
      invitations.create(targetWorkspace.id, inviterOwnerId, { email: "dup@example.com", role: "manager" }),
    );
    const secondMember = await invitations.accept(targetWorkspace.id, inviteeId, second.token!, meta);

    // ON CONFLICT (workspace_id, user_id) WHERE status <> 'removed' DO
    // NOTHING — the existing membership (still 'viewer') is returned, not a
    // new/upgraded row, and no duplicate is created.
    expect(secondMember.id).toBe(firstMember.id);
    expect(secondMember.role).toBe("viewer");

    const count = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [targetWorkspace.id, inviteeId],
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
  });

  it("STORY-021-E-13 · a suspended member accepting a fresh invitation is refused with 409 member_suspended, not silently reactivated", async () => {
    const inviterOwnerId = await createUser();
    const targetWorkspace = await workspaces.create(inviterOwnerId, { name: `Target ${randomUUID()}` }, meta);
    const inviteeId = await createUser();

    const first = await createInWorkspaceContext(targetWorkspace.id, inviterOwnerId, () =>
      invitations.create(targetWorkspace.id, inviterOwnerId, { email: "suspend-me@example.com", role: "viewer" }),
    );
    const firstMember = await invitations.accept(targetWorkspace.id, inviteeId, first.token!, meta);

    await db.query("UPDATE workspace_members SET status = 'suspended' WHERE id = $1", [firstMember.id]);

    const second = await createInWorkspaceContext(targetWorkspace.id, inviterOwnerId, () =>
      invitations.create(targetWorkspace.id, inviterOwnerId, { email: "suspend-me@example.com", role: "manager" }),
    );

    await expect(invitations.accept(targetWorkspace.id, inviteeId, second.token!, meta)).rejects.toMatchObject({
      response: { code: "conflict", details: { reason: "member_suspended" } },
    });

    const row = await db.query<{ status: string; role: string }>(
      "SELECT status, role FROM workspace_members WHERE id = $1",
      [firstMember.id],
    );
    expect(row.rows[0]!.status).toBe("suspended");
    expect(row.rows[0]!.role).toBe("viewer");

    const count = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [targetWorkspace.id, inviteeId],
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
  });

  // ---- scenario 12 ---------------------------------------------------------

  it("scenario 12 — re-inviting the same address supersedes the pending invitation instead of duplicating it", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const email = `resend-${randomUUID()}@example.com`;

    const first = await createInWorkspaceContext(workspace.id, ownerId, () =>
      invitations.create(workspace.id, ownerId, { email, role: "viewer" }),
    );
    const second = await createInWorkspaceContext(workspace.id, ownerId, () =>
      invitations.create(workspace.id, ownerId, { email, role: "manager" }),
    );

    expect(second.id).not.toBe(first.id);

    const firstRow = await db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM workspace_invitations WHERE id = $1",
      [first.id],
    );
    expect(firstRow.rows[0]!.revoked_at).not.toBeNull();

    const pending = (await createInWorkspaceContext(workspace.id, ownerId, () => invitations.list(workspace.id, { limit: PAGINATION_LIMIT_DEFAULT }))).items;
    const pendingForEmail = pending.filter((i) => i.email === email);
    expect(pendingForEmail).toHaveLength(1);
    expect(pendingForEmail[0]!.role).toBe("manager");

    // The superseded token no longer works.
    const accepter = await createUser();
    await expect(invitations.accept(workspace.id, accepter, first.token!, meta)).rejects.toBeInstanceOf(
      InvitationInvalidException,
    );
  });
});
