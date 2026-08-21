import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { registerCookiePlugin } from "../../src/api/register-cookies.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import type { ChainMismatchAlert, PagingNotifier } from "../../src/modules/audit/ports/paging-notifier.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { verifyAllChains } from "../../src/workers/rollup/audit-verify.js";
import { computeCsrfToken } from "../../src/lib/auth/csrf.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, REFRESH_COOKIE_NAME } from "../../src/lib/auth/cookies.js";

// STORY-020 pattern (test/integration/audit-verify.spec.ts) — a notifier
// that just records rather than actually paging anyone.
class RecordingNotifier implements PagingNotifier {
  readonly alerts: ChainMismatchAlert[] = [];
  async page(alert: ChainMismatchAlert): Promise<void> {
    this.alerts.push(alert);
    await Promise.resolve();
  }
}

// STORY-021 — Test Scenario 13, over all 7 mutating routes this story owns.
// Boots the REAL, deployed ApiModule (every guard/interceptor api.module.ts
// actually registers — AuthGuard, WorkspaceGuard, RbacGuard, then the
// no-op EPIC-10 guards, then TenantContextInterceptor/AuditInterceptor),
// against real Postgres, exactly like identity-session-model.spec.ts's own
// "through the real, deployed ApiModule" describe block. Nothing here
// stubs a guard or interceptor — a wiring bug (a route missing @Audit(),
// or the interceptor order regressing) would fail this file, not just a
// narrower unit test.
//
// The double-submit CSRF cookie/header pair is deterministic —
// HMAC-SHA256(sid, secret) (src/lib/auth/csrf.ts) — and does not change
// when a session switches workspace (only its access token's claims do,
// never its sid), so one computed value is reused for every mutating
// request tied to the same session throughout this file.

const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
const KID = "test-kid-1";
const CSRF_SECRET = "test-csrf-secret";
const WRAPPING_KEY = Buffer.alloc(32, 17);

describe("STORY-021 · every mutating workspace/member/invitation route writes an audit row, through the real HTTP pipeline", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    process.env = { ...originalEnv };
  });

  beforeEach(async () => {
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = PRIVATE_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = PUBLIC_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_KID = KID;
    process.env.CSRF_SECRET = CSRF_SECRET;
    process.env.WORKSPACE_DEK_WRAPPING_KEY = WRAPPING_KEY.toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await registerCookiePlugin(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  afterEach(async () => {
    await app.close();
    await db.end();
  });

  async function createUser(email = `user-${randomUUID()}@example.com`): Promise<string> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [email]);
    return result.rows[0]!.id;
  }

  async function addMember(workspaceId: string, userId: string, role: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,$4,'active')",
      [id, workspaceId, userId, role],
    );
    return id;
  }

  async function auditRow(workspaceId: string, action: string): Promise<{ actor_id: string; resource_id: string } | undefined> {
    const result = await db.query<{ actor_id: string; resource_id: string }>(
      "SELECT actor_id, resource_id FROM audit_log WHERE workspace_id = $1 AND action = $2 ORDER BY seq DESC LIMIT 1",
      [workspaceId, action],
    );
    return result.rows[0];
  }

  /** Mints a session and its deterministic CSRF token, no workspace claimed yet. */
  async function newSession() {
    const sessions = app.get(SessionService);
    const userId = await createUser();
    const tokens = await sessions.createSession(userId);
    const csrf = computeCsrfToken(tokens.sid, CSRF_SECRET);
    return { userId, ...tokens, csrf };
  }

  it("scenario 13 — all 7 mutating routes in this story each write their own audit row", async () => {
    // ---- (1) POST /workspaces -> workspace.created ------------------------
    const owner = await newSession();
    const createRes = await app.inject({
      method: "POST",
      url: "/workspaces",
      cookies: { [ACCESS_COOKIE_NAME]: owner.accessToken, [CSRF_COOKIE_NAME]: owner.csrf },
      headers: { [CSRF_HEADER_NAME]: owner.csrf },
      payload: { name: `Audited Co ${randomUUID()}` },
    });
    expect(createRes.statusCode).toBe(201);
    const workspace = createRes.json() as { id: string };
    const created = await auditRow(workspace.id, "workspace.created");
    expect(created).toEqual({ actor_id: owner.userId, resource_id: workspace.id });

    // ---- (3) POST /workspaces/:id/switch -> workspace.switched -------------
    // (numbered after create, before the ordinary routes below, since every
    // workspace-scoped route needs a ws-claiming token first)
    const switchRes = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/switch`,
      cookies: {
        [ACCESS_COOKIE_NAME]: owner.accessToken,
        [CSRF_COOKIE_NAME]: owner.csrf,
        [REFRESH_COOKIE_NAME]: owner.refreshToken,
      },
      headers: { [CSRF_HEADER_NAME]: owner.csrf },
    });
    expect(switchRes.statusCode).toBe(200);
    const switched = await auditRow(workspace.id, "workspace.switched");
    expect(switched).toEqual({ actor_id: owner.userId, resource_id: workspace.id });

    const setCookies = new Map(
      switchRes.cookies.map((c) => [c.name, c.value as string]),
    );
    const scopedAccessToken = setCookies.get(ACCESS_COOKIE_NAME)!;
    expect(scopedAccessToken).toBeTruthy();

    const scoped = {
      [ACCESS_COOKIE_NAME]: scopedAccessToken,
      [CSRF_COOKIE_NAME]: owner.csrf,
    };
    const csrfHeader = { [CSRF_HEADER_NAME]: owner.csrf };

    // ---- (2) PATCH /workspaces/:id -> workspace.updated --------------------
    const updateRes = await app.inject({
      method: "PATCH",
      url: `/workspaces/${workspace.id}`,
      cookies: scoped,
      headers: csrfHeader,
      payload: { name: "Renamed Co" },
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = await auditRow(workspace.id, "workspace.updated");
    expect(updated).toEqual({ actor_id: owner.userId, resource_id: workspace.id });

    // ---- fixtures for member/invitation routes -----------------------------
    const memberUserId = await createUser();
    const memberId = await addMember(workspace.id, memberUserId, "viewer");
    const removeTargetUserId = await createUser();
    const removeTargetId = await addMember(workspace.id, removeTargetUserId, "viewer");

    // ---- (4) PATCH /members/:id -> member.role_changed ----------------------
    const roleRes = await app.inject({
      method: "PATCH",
      url: `/members/${memberId}`,
      cookies: scoped,
      headers: csrfHeader,
      payload: { role: "admin" },
    });
    expect(roleRes.statusCode).toBe(200);
    const roleChanged = await auditRow(workspace.id, "member.role_changed");
    expect(roleChanged).toEqual({ actor_id: owner.userId, resource_id: memberId });

    // ---- (5) DELETE /members/:id -> member.removed --------------------------
    const removeRes = await app.inject({
      method: "DELETE",
      url: `/members/${removeTargetId}`,
      cookies: scoped,
      headers: csrfHeader,
    });
    expect(removeRes.statusCode).toBe(200);
    const removed = await auditRow(workspace.id, "member.removed");
    expect(removed).toEqual({ actor_id: owner.userId, resource_id: removeTargetId });

    // ---- (6) POST /workspaces/:id/invitations -> member.invited -------------
    const inviteRes = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/invitations`,
      cookies: scoped,
      headers: csrfHeader,
      payload: { email: `invitee-${randomUUID()}@example.com`, role: "viewer" },
    });
    expect(inviteRes.statusCode).toBe(201);
    const invitation = inviteRes.json() as { id: string; token: string };
    const invited = await auditRow(workspace.id, "member.invited");
    expect(invited).toEqual({ actor_id: owner.userId, resource_id: invitation.id });

    // ---- (7) POST /workspaces/:id/invitations/accept -> member.invitation_accepted
    const invitee = await newSession();
    const acceptRes = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/invitations/accept`,
      cookies: { [ACCESS_COOKIE_NAME]: invitee.accessToken, [CSRF_COOKIE_NAME]: invitee.csrf },
      headers: { [CSRF_HEADER_NAME]: invitee.csrf },
      payload: { token: invitation.token },
    });
    expect(acceptRes.statusCode).toBe(200);
    const acceptedMember = acceptRes.json() as { id: string };
    const accepted = await auditRow(workspace.id, "member.invitation_accepted");
    expect(accepted).toEqual({ actor_id: invitee.userId, resource_id: acceptedMember.id });

    // Code-review should-fix finding 3 — per-row assertions above only prove
    // each route wrote SOMETHING; they never prove the resulting rows form a
    // valid, unbroken hash chain. Mixed in-service (workspace.created,
    // workspace.switched) and interceptor-driven (the other 5) appends must
    // still chain together correctly.
    const notifier = new RecordingNotifier();
    const verifyResult = await verifyAllChains(db, notifier, [workspace.id]);
    expect(verifyResult.mismatch).toBeNull();
    expect(notifier.alerts).toHaveLength(0);
  });

  async function memberRow(memberId: string): Promise<{ role: string; status: string }> {
    const result = await db.query<{ role: string; status: string }>(
      "SELECT role, status FROM workspace_members WHERE id = $1",
      [memberId],
    );
    return result.rows[0]!;
  }

  // Code-review blocking finding 1 — MembershipService.updateRole/removeMember
  // used to open their OWN transaction (pool.connect + withTenantContext),
  // separate from TenantContextInterceptor's ambient one. That competing
  // transaction committed the role/removal change independently of whether
  // AuditInterceptor's later audit write succeeded — a split-brain where a
  // failed audit write rolled back the ambient transaction (and the client
  // was told the request failed) while the mutation had already stuck.
  // Forcing AuditChainService.append to throw reproduces exactly that: the
  // regression test below fails (member.role/status ends up changed despite
  // the request erroring) against the pre-fix code and passes once the
  // mutation runs on the ambient client instead.
  it("STORY-021 code review · a role-change mutation rolls back together with its failed audit write (no split-brain)", async () => {
    const owner = await newSession();
    const createRes = await app.inject({
      method: "POST",
      url: "/workspaces",
      cookies: { [ACCESS_COOKIE_NAME]: owner.accessToken, [CSRF_COOKIE_NAME]: owner.csrf },
      headers: { [CSRF_HEADER_NAME]: owner.csrf },
      payload: { name: `Rollback Co ${randomUUID()}` },
    });
    const workspace = createRes.json() as { id: string };

    const switchRes = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/switch`,
      cookies: {
        [ACCESS_COOKIE_NAME]: owner.accessToken,
        [CSRF_COOKIE_NAME]: owner.csrf,
        [REFRESH_COOKIE_NAME]: owner.refreshToken,
      },
      headers: { [CSRF_HEADER_NAME]: owner.csrf },
    });
    const scopedAccessToken = new Map(switchRes.cookies.map((c) => [c.name, c.value as string])).get(
      ACCESS_COOKIE_NAME,
    )!;
    const scoped = { [ACCESS_COOKIE_NAME]: scopedAccessToken, [CSRF_COOKIE_NAME]: owner.csrf };
    const csrfHeader = { [CSRF_HEADER_NAME]: owner.csrf };

    const memberUserId = await createUser();
    const memberId = await addMember(workspace.id, memberUserId, "viewer");

    const auditChain = app.get(AuditChainService);
    const appendSpy = vi.spyOn(auditChain, "append").mockRejectedValueOnce(new Error("simulated audit write failure"));

    const roleRes = await app.inject({
      method: "PATCH",
      url: `/members/${memberId}`,
      cookies: scoped,
      headers: csrfHeader,
      payload: { role: "admin" },
    });
    expect(roleRes.statusCode).toBeGreaterThanOrEqual(500);

    const afterFailedRoleChange = await memberRow(memberId);
    expect(afterFailedRoleChange.role).toBe("viewer");
    expect(await auditRow(workspace.id, "member.role_changed")).toBeUndefined();

    appendSpy.mockRestore();

    // Same split-brain, for removal instead of a role change.
    const removeTargetUserId = await createUser();
    const removeTargetId = await addMember(workspace.id, removeTargetUserId, "viewer");
    const removeAppendSpy = vi
      .spyOn(auditChain, "append")
      .mockRejectedValueOnce(new Error("simulated audit write failure"));

    const removeRes = await app.inject({
      method: "DELETE",
      url: `/members/${removeTargetId}`,
      cookies: scoped,
      headers: csrfHeader,
    });
    expect(removeRes.statusCode).toBeGreaterThanOrEqual(500);

    const afterFailedRemoval = await memberRow(removeTargetId);
    expect(afterFailedRemoval.status).toBe("active");
    expect(await auditRow(workspace.id, "member.removed")).toBeUndefined();

    removeAppendSpy.mockRestore();
  });

  // qa-reviewer mutation testing, STORY-021 close-out — gap 4: scenario 7's
  // refusal was only ever proven by calling updateMemberRole() directly with
  // a literal actorRole argument, never through the real HTTP pipeline where
  // req.membership!.role is what actually supplies that value. This drives
  // an admin session through a live switch, then the real PATCH /members/:id
  // route, so a regression in how the controller/guard resolves the caller's
  // role would fail this test even if the service-level one still passed.
  it("STORY-021 code review · a real admin session attempting to grant ownership over HTTP is refused 403, naming the required permission", async () => {
    const owner = await newSession();
    const createRes = await app.inject({
      method: "POST",
      url: "/workspaces",
      cookies: { [ACCESS_COOKIE_NAME]: owner.accessToken, [CSRF_COOKIE_NAME]: owner.csrf },
      headers: { [CSRF_HEADER_NAME]: owner.csrf },
      payload: { name: `Matrix Co ${randomUUID()}` },
    });
    const workspace = createRes.json() as { id: string };

    const admin = await newSession();
    await addMember(workspace.id, admin.userId, "admin");

    const adminSwitchRes = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/switch`,
      cookies: {
        [ACCESS_COOKIE_NAME]: admin.accessToken,
        [CSRF_COOKIE_NAME]: admin.csrf,
        [REFRESH_COOKIE_NAME]: admin.refreshToken,
      },
      headers: { [CSRF_HEADER_NAME]: admin.csrf },
    });
    expect(adminSwitchRes.statusCode).toBe(200);
    const adminScopedAccessToken = new Map(adminSwitchRes.cookies.map((c) => [c.name, c.value as string])).get(
      ACCESS_COOKIE_NAME,
    )!;
    const adminScoped = { [ACCESS_COOKIE_NAME]: adminScopedAccessToken, [CSRF_COOKIE_NAME]: admin.csrf };
    const adminCsrfHeader = { [CSRF_HEADER_NAME]: admin.csrf };

    const targetUserId = await createUser();
    const targetMemberId = await addMember(workspace.id, targetUserId, "viewer");

    const res = await app.inject({
      method: "PATCH",
      url: `/members/${targetMemberId}`,
      cookies: adminScoped,
      headers: adminCsrfHeader,
      payload: { role: "owner" },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as { details?: { required_permission?: string } };
    expect(body.details?.required_permission).toBe("workspace:transfer_ownership");

    const target = await memberRow(targetMemberId);
    expect(target.role).toBe("viewer");
  });
});
