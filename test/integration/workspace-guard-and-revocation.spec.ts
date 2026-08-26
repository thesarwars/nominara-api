import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { Client, Pool } from "pg";
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { WorkspaceGuard, type WorkspaceScopedRequest } from "../../src/api/guards/workspace.guard.js";
import { AuthGuard, type AuthenticatedRequest } from "../../src/api/guards/auth.guard.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import type { DekProvisioner } from "../../src/modules/workspaces/ports/dek-provisioner.js";
import { WORKSPACE_HEADER_NAME } from "../../src/tenancy/constants.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import type { AccessTokenClaims } from "../../contracts/identity/access-token-claims.schema.js";
import { Reflector } from "@nestjs/core";
import { ACCESS_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import * as metrics from "../../src/lib/telemetry/metrics.js";
import { IS_PUBLIC_KEY } from "../../src/api/decorators/public.decorator.js";

// STORY-018 — security-and-tenancy.md §7. Real Postgres (testcontainers,
// testing-strategy.md §1): the membership re-check runs through the SAME
// withTenantContext seam STORY-011 built, so its correctness under RLS
// cannot be trusted against a mocked pg Pool. Dangerous area (tenant
// context) — a reviewer other than the author must read this guard (DoD).

function makeContext(req: WorkspaceScopedRequest) {
  return {
    getHandler: () => (): void => {},
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as Parameters<WorkspaceGuard["canActivate"]>[0];
}

function sessionClaims(overrides: Partial<AccessTokenClaims> & { sub: string }): AccessTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: overrides.sub,
    sid: overrides.sid ?? uuidV7(),
    ws: overrides.ws ?? null,
    role: overrides.role ?? null,
    scope: overrides.scope ?? null,
    ent_v: overrides.ent_v ?? null,
    iat: now,
    exp: now + 900,
    jti: uuidV7(),
  };
}

describe("STORY-018 · workspace guard, membership cache, revocation, freshness", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let cache: MembershipCacheService;
  let membership: MembershipService;
  let workspaces: WorkspacesService;
  let guard: WorkspaceGuard;

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
    // STORY-021 — WORKSPACE_DEK_WRAPPING_KEY became required by the global
    // env schema this story extended (config/env.schema.ts); SessionService's
    // loadEnv() call now needs it even though nothing in this file touches a
    // DEK directly.
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";
    process.env.VALKEY_CACHE_URL = "redis://localhost:6379";
    // STORY-030 — DbModule's PG_POOL factory calls loadEnv(), which (since
    // Phase B) also requires the queue-signing env vars even though this
    // file never signs a job payload itself.
    process.env.QUEUE_REDIS_URL = "redis://localhost:6380";
    process.env.ENGINE_TOKEN_BUCKETS = '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}';
    process.env.QUEUE_JOB_SIGNING_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.QUEUE_JOB_SIGNING_KID = "test-queue-kid-1";
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
    cache = new MembershipCacheService();
    membership = new MembershipService(cache);
    // STORY-021 — suspend/bumpEntitlementVersion (this story's own methods,
    // called below with an explicit `pool` argument) never touch these new
    // constructor dependencies; unused stand-ins keep this test compiling.
    const unusedDekProvisioner: DekProvisioner = {
      provision: () => {
        throw new Error("not used by this test");
      },
    };
    workspaces = new WorkspacesService(
      pool,
      unusedDekProvisioner,
      new AuditChainService(),
      membership,
      new SessionService(pool), new NoopRealtimePublisher());
    guard = new WorkspaceGuard(pool, membership, new Reflector());
  });

  afterEach(async () => {
    await pool.end();
    await db.end();
  });

  // ---- fixtures ---------------------------------------------------------

  let seq = 0;
  async function createUser(): Promise<string> {
    seq += 1;
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `user-${seq}@example.com`,
    ]);
    return result.rows[0]!.id;
  }

  async function createWorkspace(planKey = "free"): Promise<string> {
    seq += 1;
    const result = await db.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, $3) RETURNING id",
      [`Workspace ${seq}`, `workspace-${seq}`, planKey],
    );
    return result.rows[0]!.id;
  }

  async function addMember(
    workspaceId: string,
    userId: string,
    role: string,
    status = "active",
    projectScope: string[] | null = null,
  ): Promise<void> {
    await db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, status, project_scope) VALUES ($1, $2, $3, $4, $5)",
      [workspaceId, userId, role, status, projectScope],
    );
  }

  // ---- scenario 1 ---------------------------------------------------------

  it("scenario 1 — an authenticated member's request populates the tenant context with workspace, actor, and scope", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "owner");

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ workspaceId, actorId: userId, scopeProjectIds: undefined });
    expect(req.membership).toEqual({ role: "owner", projectScope: null });
  });

  // ---- scenario 2 ---------------------------------------------------------

  it("scenario 2 — a token claiming a workspace the user is not a member of is refused", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    // Deliberately no workspace_members row for userId.

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId }),
      headers: {},
    };

    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: "not_a_member" },
    });
  });

  // ---- scenario 3 ---------------------------------------------------------

  it("scenario 3 — a key request with a mismatched workspace header is refused with the mismatch code", async () => {
    const keyWorkspaceId = await createWorkspace();
    const otherWorkspaceId = await createWorkspace();

    const req: WorkspaceScopedRequest = {
      authMethod: "apiKey",
      apiKey: { id: uuidV7(), workspaceId: keyWorkspaceId },
      headers: { [WORKSPACE_HEADER_NAME]: otherWorkspaceId },
    };

    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: "workspace_mismatch" },
    });
  });

  it("scenario 3 (companion) — a key request with a matching workspace header is permitted", async () => {
    const workspaceId = await createWorkspace();
    const req: WorkspaceScopedRequest = {
      authMethod: "apiKey",
      apiKey: { id: uuidV7(), workspaceId },
      headers: { [WORKSPACE_HEADER_NAME]: workspaceId },
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.tenant?.workspaceId).toBe(workspaceId);
  });

  // ---- scenarios 4 & 5 -----------------------------------------------------

  it("scenarios 4 & 5 — removing a member invalidates the cache synchronously, and the very next request is refused", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "admin");

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(cache.has(userId, workspaceId)).toBe(true); // warm

    await membership.removeMember(pool, workspaceId, userId);

    // scenario 5 — invalidated synchronously, not left to expire.
    expect(cache.has(userId, workspaceId)).toBe(false);

    // scenario 4 — the immediate next request is refused, not merely
    // eventually (no sleep, no reliance on the 30 s TTL elapsing).
    const nextReq: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(nextReq))).rejects.toMatchObject({
      response: { code: "not_a_member" },
    });
  });

  it("scenarios 4 & 5 (companion) — a member row with status 'suspended' (not removed) refuses access with not_a_member", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    // workspace_members.status is a 3-value CHECK (active/suspended/removed,
    // 0002_identity_tenancy_billing.up.sql) — 'suspended' at the member level
    // is a distinct row state from 'removed', and from workspace-level
    // 'suspended' (which never gets set here). checkSessionRequest's
    // `live.status !== "active"` branch must refuse it the same way.
    await addMember(workspaceId, userId, "admin", "suspended");

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: "not_a_member" },
    });
  });

  // ---- scenario 6 -----------------------------------------------------

  it("scenario 6 — downgrading a role in the database resolves the new role on the next request, not the token's", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "owner");

    // ent_v must accompany a set `ws` claim (review finding 3) — a fresh
    // workspace defaults to entitlement_version 1.
    const staleToken = sessionClaims({ sub: userId, ws: workspaceId, role: "owner", ent_v: 1 });

    const warmReq: WorkspaceScopedRequest = { authMethod: "session", auth: staleToken, headers: {} };
    await guard.canActivate(makeContext(warmReq));
    expect(warmReq.membership?.role).toBe("owner");

    await membership.updateRole(pool, workspaceId, userId, "viewer");

    // Same stale token — its `role` claim still says "owner" — but the
    // guard reads the LIVE row, not the claim.
    const nextReq: WorkspaceScopedRequest = { authMethod: "session", auth: staleToken, headers: {} };
    await guard.canActivate(makeContext(nextReq));
    expect(nextReq.membership?.role).toBe("viewer");
  });

  // ---- scenario 7 -----------------------------------------------------

  it("scenario 7 — bumping the entitlement version forces the next request to refresh", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "owner");

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);

    await workspaces.bumpEntitlementVersion(pool, workspaceId);

    const counterSpy = vi.spyOn(metrics, "incrementCounter");
    const staleReq: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }), // still ent_v 1
      headers: {},
    };
    await expect(guard.canActivate(makeContext(staleReq))).rejects.toMatchObject({
      response: { code: "entitlement_stale" },
    });
    // Review finding 4 — the staleness metric is pinned by name and label.
    expect(counterSpy).toHaveBeenCalledWith("nominara_identity_entitlement_stale_total", { workspace_id: workspaceId });

    const freshReq: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 2 }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(freshReq))).resolves.toBe(true);
  });

  // ---- scenario 8 -----------------------------------------------------

  it("scenario 8 — suspending the workspace refuses access immediately, even from a warm cache", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "owner");

    const warmReq: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };
    await guard.canActivate(makeContext(warmReq));
    expect(cache.has(userId, workspaceId)).toBe(true);

    await workspaces.suspend(pool, workspaceId);

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: "workspace_suspended" },
    });
  });

  // ---- finding 2 (blocks merge) ----------------------------------------

  it("finding 2 — a workspace with status 'deleted' refuses access immediately, like suspended", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "owner");
    await db.query("UPDATE workspaces SET status = 'deleted' WHERE id = $1", [workspaceId]);

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: "workspace_suspended" },
    });
  });

  it("finding 2 (companion) — a workspace with deleted_at set refuses access even while status is still 'active'", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "owner");
    await db.query("UPDATE workspaces SET deleted_at = now() WHERE id = $1", [workspaceId]);

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: "workspace_suspended" },
    });
  });

  it("finding 2 (pending_deletion) — a workspace with status 'pending_deletion' refuses access immediately, like suspended and deleted", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "owner");
    await db.query("UPDATE workspaces SET status = 'pending_deletion' WHERE id = $1", [workspaceId]);

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: "workspace_suspended" },
    });
  });

  // ---- scenario 9 -----------------------------------------------------

  it("scenario 9 — logging out then reusing the access token is refused via the deny list, before WorkspaceGuard is ever reached", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "owner");

    const sessions = new SessionService(pool);
    const tokens = await sessions.createSession(userId);
    await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 1);
    await sessions.logout(tokens.sid);

    const authGuard = new AuthGuard(new Reflector(), pool);
    const req: AuthenticatedRequest = { cookies: { [ACCESS_COOKIE_NAME]: tokens.accessToken }, method: "GET" };

    // AuthGuard's session-revocation deny list (sessions.revoked_at IS the
    // jti deny list, STORY-017) rejects the request in the composition
    // root's chain BEFORE WorkspaceGuard runs at all.
    await expect(authGuard.canActivate(makeContext(req as unknown as WorkspaceScopedRequest))).rejects.toThrow(
      "session revoked",
    );
    expect(req.auth).toBeUndefined(); // AuthGuard never populated it — WorkspaceGuard has nothing to read.
  });

  // ---- scenario 10 -----------------------------------------------------

  it("scenario 10 — a scoped role's request carries the project scope array on the tenant context", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    const scope = [uuidV7(), uuidV7()];
    await addMember(workspaceId, userId, "manager", "active", scope);

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.tenant?.scopeProjectIds).toEqual(scope);
    expect(req.membership?.projectScope).toEqual(scope);
  });

  // ---- widen: no active workspace claimed yet --------------------------

  it("widen — a session token with no active workspace (ws: null) passes through untouched", async () => {
    const userId = await createUser();
    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: null }),
      headers: {},
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.tenant).toBeUndefined();
  });

  // ---- widen: neither session nor key auth marker set ------------------

  it("widen — a request with no authMethod at all is refused as unauthenticated", async () => {
    const req: WorkspaceScopedRequest = { headers: {} };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: "unauthenticated" },
    });
  });

  // ---- widen: concurrency ------------------------------------------------

  it("widen — concurrent requests racing a cache miss all resolve the same live membership without corrupting the cache", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "analyst");

    // Real Postgres connection-pool/network timing decides how many of the
    // 25 actually observe a cache miss vs. land after an earlier one's
    // cache.set() — that count is NOT deterministic across runs (no barrier
    // controls it), so this test does not assert an exact/bounded query
    // count. What IS deterministic and asserted below: every value this
    // race ever writes into the cache, and every membership object every
    // one of the 25 requests ends up with, is the complete correct row —
    // never partial/corrupted. The narrower, deterministic claim that
    // getLiveMembership has no single-flight dedup (a real cache miss
    // always re-reads the DB, never coalesces with a concurrent in-flight
    // read) is proven separately below, without relying on this timing.
    const setSpy = vi.spyOn(cache, "set");

    const requests: WorkspaceScopedRequest[] = Array.from({ length: 25 }, () => ({
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    }));

    const results = await Promise.all(requests.map((req) => guard.canActivate(makeContext(req))));
    expect(results.every((r) => r === true)).toBe(true);
    expect(
      requests.every(
        (req) => req.membership?.role === "analyst" && req.membership?.projectScope === null,
      ),
    ).toBe(true);
    expect(cache.has(userId, workspaceId)).toBe(true);

    // Every cache write this race produced must be the complete row — a
    // corrupted/partial value written mid-race (e.g. from a torn read) would
    // fail this even though the test above only checks the final state.
    for (const [, , value] of setSpy.mock.calls) {
      expect(value).toEqual({ role: "analyst", status: "active", projectScope: null });
    }
  });

  it("widen — getLiveMembership has no single-flight dedup: two concurrent cache misses each issue their own DB read", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "analyst");

    const connectSpy = vi.spyOn(pool, "connect");

    // Both calls are issued in the same synchronous tick, before either has
    // reached its first real I/O (pool.connect() below) — cache.get() runs
    // synchronously ahead of that first await, so the second call
    // deterministically observes the same cache miss the first one did,
    // regardless of DB/network timing. This isolates the exact property the
    // 25-way test above cannot pin down deterministically.
    const [first, second] = await Promise.all([
      membership.getLiveMembership(pool, userId, workspaceId),
      membership.getLiveMembership(pool, userId, workspaceId),
    ]);

    expect(first).toEqual({ role: "analyst", status: "active", projectScope: null });
    expect(second).toEqual({ role: "analyst", status: "active", projectScope: null });
    // getLiveMembership (membership.service.ts) has no in-flight/promise-
    // coalescing map keyed on a pending read — this is a deliberately
    // unguarded property of the current code, asserted here as fact, not as
    // a guarantee the code doesn't actually make.
    expect(connectSpy).toHaveBeenCalledTimes(2);
  });

  // ---- finding 1 (blocks merge) ------------------------------------------

  it("finding 1 — a read paused between its DB SELECT and its cache write must not resurrect a membership removed in the meantime", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "admin");

    // Simulates the exact interleaving MembershipService.getLiveMembership
    // is exposed to: a read snapshots the generation via beginRead() before
    // its SELECT, the SELECT observes the still-active pre-removal row, and
    // ONLY THEN (simulated by calling set() below, after removeMember has
    // already run) does it try to write what it read into the cache.
    const staleGeneration = cache.beginRead(userId, workspaceId);
    const staleMembership = { role: "admin", status: "active", projectScope: null };

    // The concurrent mutation — real MembershipService.removeMember against
    // real Postgres — commits and invalidates synchronously, in full, before
    // the paused read's cache write below runs.
    await membership.removeMember(pool, workspaceId, userId);

    // The paused read resumes and writes the stale row it fetched earlier.
    cache.set(userId, workspaceId, staleMembership, staleGeneration);

    expect(cache.has(userId, workspaceId)).toBe(false);

    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: 1 }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: "not_a_member" },
    });
  });

  // ---- finding 3 (should-fix) ---------------------------------------------

  it("finding 3 — a session token with a workspace claimed but no entitlement version is treated as stale, not passed through", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "owner");

    const counterSpy = vi.spyOn(metrics, "incrementCounter");
    const req: WorkspaceScopedRequest = {
      authMethod: "session",
      auth: sessionClaims({ sub: userId, ws: workspaceId, ent_v: null }),
      headers: {},
    };
    await expect(guard.canActivate(makeContext(req))).rejects.toMatchObject({
      response: { code: "entitlement_stale" },
    });
    expect(counterSpy).toHaveBeenCalledWith("nominara_identity_entitlement_stale_total", { workspace_id: workspaceId });
  });

  // ---- finding 5 (should-fix) ---------------------------------------------

  it("finding 5 — @Public() metadata short-circuits canActivate to true without touching the DB", async () => {
    const isPublicSpy = vi.spyOn(Reflector.prototype, "getAllAndOverride").mockImplementation((key: unknown) =>
      key === IS_PUBLIC_KEY ? true : undefined,
    );
    const connectSpy = vi.spyOn(pool, "connect");

    // No authMethod/auth at all — if the @Public() short-circuit did not
    // fire, canActivate would throw UnauthenticatedWorkspaceException
    // instead of returning true.
    const req: WorkspaceScopedRequest = { headers: {} };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(connectSpy).not.toHaveBeenCalled();

    isPublicSpy.mockRestore();
  });
});
