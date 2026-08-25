import { randomUUID } from "node:crypto";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { PAGINATION_LIMIT_DEFAULT, type PaginationRequest } from "../../contracts/common/pagination.schema.js";
import type { WorkspaceListItemWithRelationship } from "../../contracts/workspaces/workspace-list-response.schema.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { WorkspacesService, type AuditRequestMeta } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";

// STORY-021 — Test Scenario 5. listForActor() runs under withActorContext
// (ADR-0001), a cross-tenant self-read — its RLS-boundary mechanics already
// have dedicated coverage in test/isolation/actor-self-scoped.spec.ts
// (iso-18–iso-22). This file is about the SERVICE-level behavior instead:
// does it separate owned from joined correctly, carry the right plan/status
// badges, and exclude what it should (other users' workspaces, a caller's
// own removed/non-active membership)? Real Postgres — the owned/joined
// split is driven by a live JOIN against workspace_members.role, which a
// mocked pg client cannot exercise honestly.

const WRAPPING_KEY = Buffer.alloc(32, 13);

describe("STORY-021 · GET /workspaces — owned/joined separation and plan badges", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaces: WorkspacesService;

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
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";
    process.env.WORKSPACE_DEK_WRAPPING_KEY = WRAPPING_KEY.toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";
    process.env.VALKEY_CACHE_URL = "redis://localhost:6379";
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
    const sessions = new SessionService(pool);
    workspaces = new WorkspacesService(
      pool,
      new LocalDekProvisioner(WRAPPING_KEY, "local:dev"),
      new AuditChainService(),
      membership,
      sessions,
      new NoopRealtimePublisher(),
    );
  });

  afterEach(async () => {
    await pool.end();
    await db.end();
  });

  const meta: AuditRequestMeta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  async function createUser(email = `user-${randomUUID()}@example.com`): Promise<string> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [email]);
    return result.rows[0]!.id;
  }

  async function addMember(
    workspaceId: string,
    userId: string,
    role: string,
    status = "active",
  ): Promise<void> {
    await db.query(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,$4,$5)",
      [randomUUID(), workspaceId, userId, role, status],
    );
  }

  // ---- scenario 5 ---------------------------------------------------------

  // STORY-117 — listForActor returns a cursor-paginated Page of items each
  // carrying `relationship`, not `{owned, joined}`. These assertions are about
  // the SEPARATION, which survives the reshape, so the grouping is derived
  // here — from the item field — rather than read off two server-built arrays.
  // Doing it in the test is the point: it proves a client can do it too.
  const FIRST_PAGE: PaginationRequest = { limit: PAGINATION_LIMIT_DEFAULT };

  async function listGroups(userId: string): Promise<{
    owned: readonly WorkspaceListItemWithRelationship[];
    joined: readonly WorkspaceListItemWithRelationship[];
  }> {
    const page = await workspaces.listForActor(userId, FIRST_PAGE);
    return {
      owned: page.items.filter((w) => w.relationship === "owned"),
      joined: page.items.filter((w) => w.relationship === "joined"),
    };
  }


  it("scenario 5 — a brand-new user with no workspaces gets an empty owned and joined list", async () => {
    const userId = await createUser();

    const result = await listGroups(userId);

    expect(result).toEqual({ owned: [], joined: [] });
  });

  it("scenario 5 — a workspace the caller owns is listed under owned, never joined, with its plan and status badges", async () => {
    const userId = await createUser();
    const workspace = await workspaces.create(userId, { name: `Owned ${randomUUID()}` }, meta);

    const result = await listGroups(userId);

    expect(result.owned).toHaveLength(1);
    expect(result.joined).toHaveLength(0);
    expect(result.owned[0]).toEqual({
      workspace_id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      role: "owner",
      plan_key: "free",
      status: "active",
      relationship: "owned",
    });
  });

  it("scenario 5 — a workspace the caller was added to as a non-owner is listed under joined, never owned", async () => {
    const ownerId = await createUser();
    const memberId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Shared ${randomUUID()}` }, meta);
    await addMember(workspace.id, memberId, "analyst");

    const result = await listGroups(memberId);

    expect(result.owned).toHaveLength(0);
    expect(result.joined).toHaveLength(1);
    expect(result.joined[0]).toEqual({
      workspace_id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      role: "analyst",
      plan_key: "free",
      status: "active",
      relationship: "joined",
    });
  });

  it("scenario 5 — one owned workspace and multiple joined workspaces are correctly separated in a single call", async () => {
    const userId = await createUser();
    const owned = await workspaces.create(userId, { name: `Mine ${randomUUID()}` }, meta);

    const otherOwnerA = await createUser();
    const workspaceA = await workspaces.create(otherOwnerA, { name: `A ${randomUUID()}` }, meta);
    await addMember(workspaceA.id, userId, "admin");

    const otherOwnerB = await createUser();
    const workspaceB = await workspaces.create(otherOwnerB, { name: `B ${randomUUID()}` }, meta);
    await addMember(workspaceB.id, userId, "viewer");

    const result = await listGroups(userId);

    expect(result.owned.map((w) => w.workspace_id)).toEqual([owned.id]);
    expect(result.joined.map((w) => w.workspace_id).sort()).toEqual([workspaceA.id, workspaceB.id].sort());
  });

  it("scenario 5 — another user's workspace never appears in the caller's list", async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    await workspaces.create(otherUserId, { name: `Not mine ${randomUUID()}` }, meta);

    const result = await listGroups(userId);

    expect(result).toEqual({ owned: [], joined: [] });
  });

  it("scenario 5 — a removed membership row is excluded from the list entirely", async () => {
    const ownerId = await createUser();
    const memberId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Removed-from ${randomUUID()}` }, meta);
    await addMember(workspace.id, memberId, "viewer", "removed");

    const result = await listGroups(memberId);

    expect(result).toEqual({ owned: [], joined: [] });
  });

  // qa-reviewer mutation testing, STORY-021 close-out — gap 3: every prior
  // fixture workspace was on 'free', so the plan_key assertions above never
  // proved the badge reads each workspace's OWN plan_key rather than the
  // caller's own workspace's plan or a hardcoded "free" default. Here the
  // owned workspace stays 'free' and the joined workspace is put on
  // 'business' (and vice versa in the companion test below).
  it("scenario 5 — the plan badge on each entry is that workspace's own plan_key, not the caller's or a hardcoded default", async () => {
    const userId = await createUser();
    await workspaces.create(userId, { name: `Mine ${randomUUID()}` }, meta);

    const otherOwnerId = await createUser();
    const joined = await workspaces.create(otherOwnerId, { name: `Theirs ${randomUUID()}` }, meta);
    await addMember(joined.id, userId, "admin");
    await db.query("UPDATE workspaces SET plan_key = 'business' WHERE id = $1", [joined.id]);

    const result = await listGroups(userId);

    expect(result.owned).toHaveLength(1);
    expect(result.owned[0]!.plan_key).toBe("free");
    expect(result.joined).toHaveLength(1);
    expect(result.joined[0]!.plan_key).toBe("business");
  });

  it("scenario 5 companion — the plan badge still tracks each workspace's own plan_key when the roles are reversed (owned non-free, joined free)", async () => {
    const userId = await createUser();
    const owned = await workspaces.create(userId, { name: `Mine ${randomUUID()}` }, meta);
    await db.query("UPDATE workspaces SET plan_key = 'business' WHERE id = $1", [owned.id]);

    const otherOwnerId = await createUser();
    const joined = await workspaces.create(otherOwnerId, { name: `Theirs ${randomUUID()}` }, meta);
    await addMember(joined.id, userId, "admin");

    const result = await listGroups(userId);

    expect(result.owned).toHaveLength(1);
    expect(result.owned[0]!.plan_key).toBe("business");
    expect(result.joined).toHaveLength(1);
    expect(result.joined[0]!.plan_key).toBe("free");
  });

  it("scenario 5 — a suspended membership row is excluded from the list, only active memberships are listed", async () => {
    const ownerId = await createUser();
    const memberId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Suspended-member ${randomUUID()}` }, meta);
    await addMember(workspace.id, memberId, "viewer", "suspended");

    const result = await listGroups(memberId);

    expect(result).toEqual({ owned: [], joined: [] });
  });
});
