import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { PG_POOL } from "../../src/db/pg-pool.js";
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_NAME,
} from "../../src/lib/auth/cookies.js";
import { importEd25519PublicKeyFromDer, verifyAccessToken } from "../../src/lib/auth/access-token.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { HARNESS_PUBLIC_KEY_DER, useApiHarness } from "../support/api-harness.js";

// STORY-170 — the defect reproduced against the live local API: sign in ->
// ws null; switch -> ws set, GET /v1/projects 200; POST /auth/refresh -> ws
// null AGAIN; GET /v1/projects 403 "missing required permission:
// project:read". Cause: SessionService.refresh minted with no workspace at
// all, unconditionally — security-and-tenancy.md §5's "ws is the active
// workspace; switching workspaces mints a new token" only holds up to the
// FIRST rotation, and §7's "a mismatch forces a token refresh" recovery path
// (workspace-guard-and-revocation.spec.ts's own "THE DEADLOCK" comment) is
// only a real recovery if refresh keeps the workspace it is recovering for.
//
// Real Postgres through the real, deployed ApiModule (useApiHarness) for
// every scenario below: SessionService.refresh's re-verification opens its
// own withTenantContext transactions via MembershipService (an RLS-scoped
// read), so its correctness cannot be trusted against a mocked pg client —
// same reasoning as workspace-switching.spec.ts's own file header.
describe("STORY-170 · session refresh keeps the session's active workspace", () => {
  const harness = useApiHarness();
  let pool: Pool;

  beforeEach(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterEach(async () => {
    await pool.end();
  });

  interface CookieTriple {
    readonly access: string;
    readonly refresh: string;
    readonly csrf: string;
  }

  function cookiesByName(res: { cookies: Array<{ name: string; value: string }> }): Map<string, string> {
    return new Map(res.cookies.map((c) => [c.name, c.value]));
  }

  async function createUser(): Promise<string> {
    const userId = randomUUID();
    await harness.db().query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at)
       VALUES ($1, $2, now(), 'active', now(), now())`,
      [userId, `${userId}@example.test`],
    );
    return userId;
  }

  async function addMember(workspaceId: string, userId: string, role: string): Promise<void> {
    await harness
      .db()
      .query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,$4,'active')`, [
        randomUUID(),
        workspaceId,
        userId,
        role,
      ]);
  }

  async function decode(token: string) {
    const publicKey = importEd25519PublicKeyFromDer(HARNESS_PUBLIC_KEY_DER);
    return verifyAccessToken(token, () => publicKey);
  }

  async function createWorkspace(owner: CookieTriple): Promise<string> {
    const res = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      cookies: { [ACCESS_COOKIE_NAME]: owner.access, [CSRF_COOKIE_NAME]: owner.csrf },
      headers: { [CSRF_HEADER_NAME]: owner.csrf },
      payload: { name: `Workspace ${randomUUID()}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    return dataOf<{ id: string }>(res).id;
  }

  async function switchTo(workspaceId: string, tokens: CookieTriple): Promise<CookieTriple> {
    const res = await harness.app().inject({
      method: "POST",
      url: apiUrl(`/workspaces/${workspaceId}/switch`),
      cookies: {
        [ACCESS_COOKIE_NAME]: tokens.access,
        [REFRESH_COOKIE_NAME]: tokens.refresh,
        [CSRF_COOKIE_NAME]: tokens.csrf,
      },
      headers: { [CSRF_HEADER_NAME]: tokens.csrf },
    });
    expect(res.statusCode, res.body).toBe(200);
    const byName = cookiesByName(res);
    return { access: byName.get(ACCESS_COOKIE_NAME)!, refresh: byName.get(REFRESH_COOKIE_NAME)!, csrf: byName.get(CSRF_COOKIE_NAME)! };
  }

  async function refreshSession(refreshToken: string): Promise<{ statusCode: number; tokens: CookieTriple | null }> {
    const res = await harness.app().inject({
      method: "POST",
      url: apiUrl("/auth/refresh"),
      cookies: { [REFRESH_COOKIE_NAME]: refreshToken },
    });
    if (res.statusCode !== 200) {
      return { statusCode: res.statusCode, tokens: null };
    }
    const byName = cookiesByName(res);
    return {
      statusCode: res.statusCode,
      tokens: { access: byName.get(ACCESS_COOKIE_NAME)!, refresh: byName.get(REFRESH_COOKIE_NAME)!, csrf: byName.get(CSRF_COOKIE_NAME)! },
    };
  }

  async function listProjects(tokens: CookieTriple) {
    return harness.app().inject({
      method: "GET",
      url: apiUrl("/projects"),
      cookies: { [ACCESS_COOKIE_NAME]: tokens.access, [CSRF_COOKIE_NAME]: tokens.csrf },
    });
  }

  it("STORY-170 · switch then refresh keeps ws/role/scope, and GET /v1/projects stays 200 — the reported defect", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const signedIn: CookieTriple = { access: initial.accessToken, refresh: initial.refreshToken, csrf: initial.csrfToken };

    const initialClaims = await decode(signedIn.access);
    expect(initialClaims.ws).toBeNull();

    const workspaceId = await createWorkspace(signedIn);
    const switched = await switchTo(workspaceId, signedIn);

    const switchedClaims = await decode(switched.access);
    expect(switchedClaims.ws).toBe(workspaceId);
    expect(switchedClaims.role).toBe("owner");

    const afterSwitchList = await listProjects(switched);
    expect(afterSwitchList.statusCode, afterSwitchList.body).toBe(200);

    // ⚠ THE BUG, AS REPORTED. Before this story's fix, this refresh minted
    // ws:null unconditionally and the assertion below failed.
    const { statusCode, tokens: refreshed } = await refreshSession(switched.refresh);
    expect(statusCode).toBe(200);
    const refreshedClaims = await decode(refreshed!.access);
    expect(refreshedClaims.ws).toBe(workspaceId);
    expect(refreshedClaims.role).toBe("owner");
    expect(refreshedClaims.scope).toBeNull(); // owner's project_scope is unrestricted (NULL)

    const afterRefreshList = await listProjects(refreshed!);
    expect(afterRefreshList.statusCode, afterRefreshList.body).toBe(200);
  });

  it("STORY-170 · membership removed between switch and refresh — fail closed to ws:null, and active_workspace_id is cleared", async () => {
    const ownerId = await createUser();
    const owner = harness.app().get(SessionService);
    const ownerTokens = await owner.createSession(ownerId);
    const workspaceId = await createWorkspace({ access: ownerTokens.accessToken, refresh: ownerTokens.refreshToken, csrf: ownerTokens.csrfToken });

    const memberId = await createUser();
    await addMember(workspaceId, memberId, "viewer");
    const memberInitial = await owner.createSession(memberId);
    const switched = await switchTo(workspaceId, { access: memberInitial.accessToken, refresh: memberInitial.refreshToken, csrf: memberInitial.csrfToken });

    const dbBefore = await pool.query<{ active_workspace_id: string | null }>(
      "SELECT active_workspace_id FROM sessions WHERE id = $1",
      [memberInitial.sid],
    );
    expect(dbBefore.rows[0]!.active_workspace_id).toBe(workspaceId);

    // The REAL production removal seam — same instance WorkspaceGuard uses
    // (app.get, not a fresh construction), so the synchronous cache
    // invalidation is real rather than racing a 30s TTL.
    const membership = harness.app().get(MembershipService);
    await membership.removeMember(pool, workspaceId, memberId);

    const { statusCode, tokens: refreshed } = await refreshSession(switched.refresh);
    expect(statusCode).toBe(200);
    const claims = await decode(refreshed!.access);
    expect(claims.ws).toBeNull();
    expect(claims.role).toBeNull();
    expect(claims.ent_v).toBeNull();

    const dbAfter = await pool.query<{ active_workspace_id: string | null }>(
      "SELECT active_workspace_id FROM sessions WHERE id = $1",
      [memberInitial.sid],
    );
    expect(dbAfter.rows[0]!.active_workspace_id).toBeNull();

    const refusedList = await listProjects(refreshed!);
    expect(refusedList.statusCode).toBe(403);
  });

  it("STORY-170 · role downgraded between switch and refresh — the refreshed token carries the NEW role, never the old one", async () => {
    const ownerId = await createUser();
    const owner = harness.app().get(SessionService);
    const ownerTokens = await owner.createSession(ownerId);
    const workspaceId = await createWorkspace({ access: ownerTokens.accessToken, refresh: ownerTokens.refreshToken, csrf: ownerTokens.csrfToken });

    const memberId = await createUser();
    await addMember(workspaceId, memberId, "admin");
    const memberInitial = await owner.createSession(memberId);
    const switched = await switchTo(workspaceId, { access: memberInitial.accessToken, refresh: memberInitial.refreshToken, csrf: memberInitial.csrfToken });
    expect((await decode(switched.access)).role).toBe("admin");

    const membership = harness.app().get(MembershipService);
    await membership.updateRole(pool, workspaceId, memberId, "viewer");

    const { statusCode, tokens: refreshed } = await refreshSession(switched.refresh);
    expect(statusCode).toBe(200);
    const claims = await decode(refreshed!.access);
    expect(claims.ws).toBe(workspaceId);
    expect(claims.role).toBe("viewer");
  });

  it("STORY-170 · a plan change between switch and refresh — the refreshed token carries the new ent_v, and no entitlement_stale follows", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const signedIn: CookieTriple = { access: initial.accessToken, refresh: initial.refreshToken, csrf: initial.csrfToken };
    const workspaceId = await createWorkspace(signedIn);
    const switched = await switchTo(workspaceId, signedIn);
    expect((await decode(switched.access)).ent_v).toBe(1);

    const workspaces = harness.app().get(WorkspacesService);
    await workspaces.bumpEntitlementVersion(pool, workspaceId);

    const { statusCode, tokens: refreshed } = await refreshSession(switched.refresh);
    expect(statusCode).toBe(200);
    expect((await decode(refreshed!.access)).ent_v).toBe(2);

    // The recovery this repairs: a token minted before the bump is refused
    // as entitlement_stale (plan-change-end-to-end.spec.ts's own test); the
    // token refresh just minted must NOT be, because it already carries the
    // live version.
    const list = await listProjects(refreshed!);
    expect(list.statusCode, list.body).toBe(200);
  });

  it("STORY-170 · switching A then B, then refreshing, keeps B — never a stale, earlier workspace", async () => {
    const userAId = await createUser();
    const sessions = harness.app().get(SessionService);
    const aTokens = await sessions.createSession(userAId);
    const workspaceA = await createWorkspace({ access: aTokens.accessToken, refresh: aTokens.refreshToken, csrf: aTokens.csrfToken });

    const ownerBId = await createUser();
    const bOwnerTokens = await sessions.createSession(ownerBId);
    const workspaceB = await createWorkspace({ access: bOwnerTokens.accessToken, refresh: bOwnerTokens.refreshToken, csrf: bOwnerTokens.csrfToken });
    await addMember(workspaceB, userAId, "admin");

    const switchedToA = await switchTo(workspaceA, { access: aTokens.accessToken, refresh: aTokens.refreshToken, csrf: aTokens.csrfToken });
    const switchedToB = await switchTo(workspaceB, switchedToA);

    const { statusCode, tokens: refreshed } = await refreshSession(switchedToB.refresh);
    expect(statusCode).toBe(200);
    const claims = await decode(refreshed!.access);
    expect(claims.ws).toBe(workspaceB);
    expect(claims.ws).not.toBe(workspaceA);
    expect(claims.role).toBe("admin");
  });

  it("STORY-170 · two sessions of the same user refresh independently — switching one never leaks into the other", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const sessionOne = await sessions.createSession(userId);
    const sessionTwo = await sessions.createSession(userId);
    expect(sessionOne.sid).not.toBe(sessionTwo.sid);

    const workspaceId = await createWorkspace({ access: sessionOne.accessToken, refresh: sessionOne.refreshToken, csrf: sessionOne.csrfToken });
    const oneSwitched = await switchTo(workspaceId, {
      access: sessionOne.accessToken,
      refresh: sessionOne.refreshToken,
      csrf: sessionOne.csrfToken,
    });

    // Session two never switched — its own refresh must keep minting ws:null.
    const twoRefreshed = await refreshSession(sessionTwo.refreshToken);
    expect(twoRefreshed.statusCode).toBe(200);
    expect((await decode(twoRefreshed.tokens!.access)).ws).toBeNull();

    // Session one, refreshed AFTER session two above, must still carry the
    // workspace IT switched into.
    const oneRefreshed = await refreshSession(oneSwitched.refresh);
    expect(oneRefreshed.statusCode).toBe(200);
    expect((await decode(oneRefreshed.tokens!.access)).ws).toBe(workspaceId);
  });

  it("STORY-170 · reuse detection still revokes the family for a session that switched workspace", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const signedIn: CookieTriple = { access: initial.accessToken, refresh: initial.refreshToken, csrf: initial.csrfToken };
    const workspaceId = await createWorkspace(signedIn);
    const switched = await switchTo(workspaceId, signedIn);

    const rotated = await refreshSession(switched.refresh);
    expect(rotated.statusCode).toBe(200);

    // STORY-170 (grace-window revision) — an IMMEDIATE replay of
    // `switched.refresh` here would now be the grace-eligible case
    // (session-refresh-grace-window.spec.ts's own scenario for that): the
    // token consumed by the session's own immediately-preceding rotation,
    // presented milliseconds later. A second, legitimate rotation moves the
    // session's ONE grace slot on to name `rotated`'s token instead
    // (FR-170-GRACE-4/6), so `switched.refresh` below is genuinely a
    // two-back reuse, not the grace case — this is what this test exists to
    // prove for a switched session.
    const rotatedAgain = await refreshSession(rotated.tokens!.refresh);
    expect(rotatedAgain.statusCode).toBe(200);

    // Replaying the now TWO-ROTATIONS-STALE switch-time refresh token — reuse.
    const replay = await refreshSession(switched.refresh);
    expect(replay.statusCode).toBe(401);

    const sessionRow = await pool.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      "SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1",
      [initial.sid],
    );
    expect(sessionRow.rows[0]!.revoked_at).not.toBeNull();
    expect(sessionRow.rows[0]!.revoked_reason).toBe("reuse_detected");

    // The family is dead — even the still-unconsumed, latest token cannot refresh.
    const afterRevocation = await refreshSession(rotatedAgain.tokens!.refresh);
    expect(afterRevocation.statusCode).toBe(401);
  });

  it("STORY-170 · a suspended workspace between switch and refresh — fail closed to ws:null, same predicate as WorkspaceGuard/switchTo", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const signedIn: CookieTriple = { access: initial.accessToken, refresh: initial.refreshToken, csrf: initial.csrfToken };
    const workspaceId = await createWorkspace(signedIn);
    const switched = await switchTo(workspaceId, signedIn);

    // Proves the switch itself persisted the column (otherwise the
    // "cleared" assertion below would trivially pass against a column that
    // was already NULL, and prove nothing about the suspension path).
    const dbBefore = await pool.query<{ active_workspace_id: string | null }>(
      "SELECT active_workspace_id FROM sessions WHERE id = $1",
      [initial.sid],
    );
    expect(dbBefore.rows[0]!.active_workspace_id).toBe(workspaceId);

    const workspaces = harness.app().get(WorkspacesService);
    await workspaces.suspend(pool, workspaceId);

    const { statusCode, tokens: refreshed } = await refreshSession(switched.refresh);
    expect(statusCode).toBe(200);
    const claims = await decode(refreshed!.access);
    expect(claims.ws).toBeNull();

    const dbAfter = await pool.query<{ active_workspace_id: string | null }>(
      "SELECT active_workspace_id FROM sessions WHERE id = $1",
      [initial.sid],
    );
    expect(dbAfter.rows[0]!.active_workspace_id).toBeNull();
  });

  it("STORY-170 · a scoped manager's project_scope narrowed between switch and refresh — refresh re-reads it live, never the old token's claim", async () => {
    const ownerId = await createUser();
    const owner = harness.app().get(SessionService);
    const ownerTokens = await owner.createSession(ownerId);
    const workspaceId = await createWorkspace({
      access: ownerTokens.accessToken,
      refresh: ownerTokens.refreshToken,
      csrf: ownerTokens.csrfToken,
    });

    const projectAId = randomUUID();
    const projectBId = randomUUID();
    await pool.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES
         ($1, $3, 'Project A', 'project-a', 'https://a.example', 'a.example'),
         ($2, $3, 'Project B', 'project-b', 'https://b.example', 'b.example')`,
      [projectAId, projectBId, workspaceId],
    );

    const managerId = await createUser();
    const memberId = randomUUID();
    await pool.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, project_scope) VALUES ($1,$2,$3,'manager','active',$4)`,
      [memberId, workspaceId, managerId, [projectAId, projectBId]],
    );
    const managerInitial = await owner.createSession(managerId);
    const switched = await switchTo(workspaceId, {
      access: managerInitial.accessToken,
      refresh: managerInitial.refreshToken,
      csrf: managerInitial.csrfToken,
    });
    expect((await decode(switched.access)).scope).toEqual([projectAId, projectBId]);

    // Narrowed directly on the table — same precedent as the role-downgrade
    // scenario above (MembershipService.updateRole), through the SAME cache
    // key the real PATCH /members/{id} route invalidates, so this proves
    // refresh re-reads LIVE membership rather than the switch-time token
    // claim or a stale 30s cache entry.
    await pool.query(`UPDATE workspace_members SET project_scope = $2 WHERE id = $1`, [memberId, [projectAId]]);
    harness.app().get(MembershipCacheService).invalidate(managerId, workspaceId);

    const { statusCode, tokens: refreshed } = await refreshSession(switched.refresh);
    expect(statusCode).toBe(200);
    const claims = await decode(refreshed!.access);
    expect(claims.ws).toBe(workspaceId);
    expect(claims.scope).toEqual([projectAId]);
  });

  // STORY-170 review finding [minor] — every scenario above runs
  // SessionService against `pool`/`harness.app()`'s own PG_POOL, which
  // `useApiHarness` connects as the testcontainers SUPERUSER. A superuser
  // bypasses RLS by an entirely different mechanism than FORCE ROW LEVEL
  // SECURITY addresses (retention-cascade.spec.ts's own file header makes
  // the same point), so none of the assertions above prove
  // `verifyWorkspaceContext`'s `MembershipService` reads survive the ACTUAL
  // runtime role — `nominara_app` — that every deployed `/auth/refresh`
  // runs as. This test builds a second `SessionService` on a real
  // `nominara_app` connection (same technique as
  // readiness-as-runtime-role.spec.ts) and proves the same switch-then-
  // refresh flow the first scenario in this file proves, through FORCE RLS.
  it("STORY-170 · workspace re-verification on refresh runs through FORCE ROW LEVEL SECURITY as nominara_app, not a superuser bypass", async () => {
    const db = harness.db();
    const appPassword = resolvePassword("nominara_app", {});
    // Migration 0005 deliberately sets no password (its own header) — set
    // one here so this test can connect AS nominara_app, same precedent as
    // readiness-as-runtime-role.spec.ts and every `connectAsRole` caller.
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(appPassword)}`);

    const pooledUrl = new URL(process.env.DATABASE_URL_POOLED!);
    const appPool = new Pool({
      host: pooledUrl.hostname,
      port: Number(pooledUrl.port),
      database: pooledUrl.pathname.replace(/^\//, ""),
      user: "nominara_app",
      password: appPassword,
    });
    try {
      const appSessionService = new SessionService(appPool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());

      // Fixtures (workspace + owner membership) via the harness's own
      // superuser-backed app — only the SUBJECT session below (created,
      // switched-in-the-DB, and refreshed) needs to run as nominara_app.
      const ownerId = await createUser();
      const bootstrap = await harness.app().get(SessionService).createSession(ownerId);
      const workspaceId = await createWorkspace({
        access: bootstrap.accessToken,
        refresh: bootstrap.refreshToken,
        csrf: bootstrap.csrfToken,
      });

      const subject = await appSessionService.createSession(ownerId);
      await pool.query(`UPDATE sessions SET active_workspace_id = $2 WHERE id = $1`, [subject.sid, workspaceId]);

      const refreshed = await appSessionService.refresh(subject.refreshToken);
      const publicKey = importEd25519PublicKeyFromDer(HARNESS_PUBLIC_KEY_DER);
      const claims = await verifyAccessToken(refreshed.accessToken, () => publicKey);
      expect(claims.ws).toBe(workspaceId);
      expect(claims.role).toBe("owner");
    } finally {
      await appPool.end();
    }
  });

  // STORY-170 review finding [major] — the second-engineer review demanded
  // this exact scenario: the workspace re-verification the blocker fix below
  // performs must run BEFORE the rotation transaction begins, so a transient
  // failure inside it never stomps the caller's still-good refresh token.
  it("STORY-170 · membership verification failing leaves the presented refresh token usable for a retry — no reuse_detected, session not revoked", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const signedIn: CookieTriple = { access: initial.accessToken, refresh: initial.refreshToken, csrf: initial.csrfToken };
    const workspaceId = await createWorkspace(signedIn);
    const switched = await switchTo(workspaceId, signedIn);

    // The REAL instance the app resolves (app.get, not a fresh construction)
    // — same precedent as every removeMember/updateRole call above.
    const membership = harness.app().get(MembershipService);
    const failure = new Error("simulated transient membership-service failure");
    const spy = vi.spyOn(membership, "getWorkspaceStatus").mockImplementationOnce(() => {
      throw failure;
    });

    // The failing attempt: rejects before any rotation happens, so the
    // presented refresh token is never consumed.
    const failed = await refreshSession(switched.refresh);
    expect(failed.statusCode).toBe(500);
    spy.mockRestore();

    // The retry, with the SAME original refresh token: must succeed, and
    // must NOT be treated as reuse — the failed attempt above never
    // consumed it because verification ran before the rotation transaction
    // even opened.
    const retried = await refreshSession(switched.refresh);
    expect(retried.statusCode).toBe(200);
    const claims = await decode(retried.tokens!.access);
    expect(claims.ws).toBe(workspaceId);

    const sessionRow = await pool.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      "SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1",
      [initial.sid],
    );
    expect(sessionRow.rows[0]!.revoked_at).toBeNull();
    expect(sessionRow.rows[0]!.revoked_reason).toBeNull();
  });

  // STORY-170 review finding [blocker] — the second-engineer review's own
  // repro: SessionService.refresh held one PG_POOL connection open in a
  // transaction with FOR UPDATE locks, then re-verified the workspace via
  // TWO MORE pool.connect() calls FROM THE SAME POOL. At `createPgPool`
  // defaults (max 10, no connectionTimeoutMillis) that nests a second
  // connection request inside a held one — ten or more concurrent refreshes
  // of switched sessions starve the pool PERMANENTLY, taking every route on
  // the instance down with it, not just this one. `withTimeout` below turns
  // that permanent hang into a named, timed-out failure instead of a spec
  // run that never completes.
  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} did not settle within ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // Both scenarios below call `SessionService.refresh` DIRECTLY (not through
  // HTTP) — same as the review's own repro. `/auth/refresh` also sits behind
  // `RateLimitGuard`'s IP-scoped `/auth/*` bucket (api-specification.md §12),
  // and every concurrent `.inject()` call in this harness carries the same
  // synthetic IP, so going through HTTP here would measure that unrelated
  // abuse control instead of the connection-pool defect this exists to
  // catch.
  it(
    "STORY-170 · pool starvation — 20 distinct switched sessions refreshed concurrently, on createPgPool defaults, all settle and an unrelated pool query is unaffected",
    async () => {
      const CONCURRENCY = 20;
      const sessions = harness.app().get(SessionService);
      const refreshTokens: string[] = [];
      for (let i = 0; i < CONCURRENCY; i += 1) {
        const userId = await createUser();
        const initial = await sessions.createSession(userId);
        const signedIn: CookieTriple = { access: initial.accessToken, refresh: initial.refreshToken, csrf: initial.csrfToken };
        const workspaceId = await createWorkspace(signedIn);
        const switched = await switchTo(workspaceId, signedIn);
        refreshTokens.push(switched.refresh);
      }

      // The pool this app's own DbModule constructed from
      // createPgPool(DATABASE_URL_POOLED) with NO tuning — production
      // defaults, the exact configuration the review's repro used.
      const pgPool = harness.app().get<Pool>(PG_POOL);

      const [refreshResults, probeResult] = await withTimeout(
        Promise.all([
          Promise.allSettled(refreshTokens.map((token) => sessions.refresh(token))),
          pgPool.query("SELECT 1 AS probe"),
        ]),
        15_000,
        `${CONCURRENCY} concurrent switched-session refreshes plus one unrelated pool query`,
      );

      expect(probeResult.rows[0]).toEqual({ probe: 1 });
      for (const result of refreshResults) {
        expect(result.status).toBe("fulfilled");
      }
    },
    20_000,
  );

  // STORY-170 (grace-window revision) — before the refresh-token reuse
  // grace window, this scenario proved exactly one of ten racers won the
  // `FOR UPDATE` lock and the other nine were rejected as reuse. That is no
  // longer correct: nine of the ten NECESSARILY present the token the
  // winner's own rotation just consumed, milliseconds apart and so
  // comfortably inside the default 2s grace window — which is exactly the
  // "multiple tabs/instances racing the same rotation" case the window
  // exists for (security-and-tenancy.md §5). The pool-starvation property
  // this test exists to pin — every racer settles, the unrelated pool query
  // is unaffected — still holds and is still asserted; what changed is that
  // "settles" now means "fulfils with the identical successor", not
  // "nine of ten reject".
  it(
    "STORY-170 · pool starvation — one switched session's refresh token sent 10x concurrently settles, every racer converges on the identical successor, and an unrelated pool query is unaffected",
    async () => {
      const CONCURRENCY = 10;
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      const signedIn: CookieTriple = { access: initial.accessToken, refresh: initial.refreshToken, csrf: initial.csrfToken };
      const workspaceId = await createWorkspace(signedIn);
      const switched = await switchTo(workspaceId, signedIn);

      const pgPool = harness.app().get<Pool>(PG_POOL);

      const [results, probeResult] = await withTimeout(
        Promise.all([
          Promise.allSettled(Array.from({ length: CONCURRENCY }, () => sessions.refresh(switched.refresh))),
          pgPool.query("SELECT 1 AS probe"),
        ]),
        15_000,
        `${CONCURRENCY} concurrent refreshes of the SAME refresh token plus one unrelated pool query`,
      );

      expect(probeResult.rows[0]).toEqual({ probe: 1 });
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<SessionService["refresh"]>>> => r.status === "fulfilled",
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toEqual([]);
      expect(fulfilled.length).toBe(CONCURRENCY);
      // Every racer got back the SAME raw refresh token — the grace window's
      // whole point, so every tab/instance's cookie converges on one value
      // instead of each other's replay revoking the session.
      const distinctRefreshTokens = new Set(fulfilled.map((r) => r.value.refreshToken));
      expect(distinctRefreshTokens.size).toBe(1);

      const sessionRow = await pool.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM sessions WHERE id = $1", [
        initial.sid,
      ]);
      expect(sessionRow.rows[0]!.revoked_at).toBeNull();
    },
    20_000,
  );
});
