import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_NAME,
} from "../../src/lib/auth/cookies.js";
import { importEd25519PublicKeyFromDer, verifyAccessToken } from "../../src/lib/auth/access-token.js";
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

    // Replaying the now-consumed switch-time refresh token — reuse.
    const replay = await refreshSession(switched.refresh);
    expect(replay.statusCode).toBe(401);

    const sessionRow = await pool.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      "SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1",
      [initial.sid],
    );
    expect(sessionRow.rows[0]!.revoked_at).not.toBeNull();
    expect(sessionRow.rows[0]!.revoked_reason).toBe("reuse_detected");

    // The family is dead — even the still-unconsumed, latest token cannot refresh.
    const afterRevocation = await refreshSession(rotated.tokens!.refresh);
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
});
