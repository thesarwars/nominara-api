import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { computeCsrfToken } from "../../src/lib/auth/csrf.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, REFRESH_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../support/test-valkey.js";

// NEW-A-12 — members carry name/email; GET /workspaces/{id}; DELETE an invitation.
// Real ApiModule + Postgres, same harness as workspace-mutations-audit.spec.ts.

const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
const KID = "test-kid-1";
const CSRF_SECRET = "test-csrf-secret";
const WRAPPING_KEY = Buffer.alloc(32, 17);

describe("NEW-A-12 · workspace members, detail and invitation revoke — through the real HTTP pipeline", () => {
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
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";
    process.env.VALKEY_CACHE_URL = testCacheRedisUrl();
    // STORY-030 — DbModule's PG_POOL factory calls loadEnv(), which (since
    // Phase B) also requires the queue-signing env vars even though this
    // file never signs a job payload itself.
    process.env.QUEUE_REDIS_URL = testQueueRedisUrl();
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
    // The app connects as the RLS-bound runtime role. As the container's
    // superuser every policy is bypassed and an isolation test proves nothing.
    const appPassword = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(appPassword)}`);
    process.env.DATABASE_URL_POOLED = `postgres://nominara_app:${encodeURIComponent(appPassword)}@${container.getHost()}:${container.getMappedPort(5432)}/${container.getDatabase()}`;

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
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


  async function newSession(email?: string) {
    const sessions = app.get(SessionService);
    const userId = await createUser(email);
    await db.query("UPDATE users SET email_verified_at = now(), status = 'active' WHERE id = $1", [userId]);
    const tokens = await sessions.createSession(userId);
    const csrf = computeCsrfToken(tokens.sid, CSRF_SECRET);
    return { userId, ...tokens, csrf };
  }
  type Session = Awaited<ReturnType<typeof newSession>>;

  async function createWorkspace(s: Session, name = `Co ${randomUUID()}`): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      cookies: { [ACCESS_COOKIE_NAME]: s.accessToken, [CSRF_COOKIE_NAME]: s.csrf },
      headers: { [CSRF_HEADER_NAME]: s.csrf },
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return dataOf<{ id: string }>(res).id;
  }

  /** Switches the session onto `workspaceId` and returns cookies/headers for a token scoped to it. */
  async function scopedTo(s: Session, workspaceId: string) {
    const res = await app.inject({
      method: "POST",
      url: apiUrl(`/workspaces/${workspaceId}/switch`),
      cookies: { [ACCESS_COOKIE_NAME]: s.accessToken, [CSRF_COOKIE_NAME]: s.csrf, [REFRESH_COOKIE_NAME]: s.refreshToken },
      headers: { [CSRF_HEADER_NAME]: s.csrf },
    });
    expect(res.statusCode).toBe(200);
    const token = res.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value as string;
    return {
      cookies: { [ACCESS_COOKIE_NAME]: token, [CSRF_COOKIE_NAME]: s.csrf },
      headers: { [CSRF_HEADER_NAME]: s.csrf },
    };
  }

  async function invite(scope: Awaited<ReturnType<typeof scopedTo>>, workspaceId: string, email: string) {
    const res = await app.inject({
      method: "POST",
      url: apiUrl(`/workspaces/${workspaceId}/invitations`),
      ...scope,
      payload: { email, role: "viewer" },
    });
    expect(res.statusCode).toBe(201);
    return dataOf<{ id: string }>(res);
  }

  // ---- members carry name + email -----------------------------------------

  it("NEW-A-12 · GET members returns each member's name (null until set) and email", async () => {
    const owner = await newSession("owner-a12@example.com");
    await db.query("UPDATE users SET full_name = 'Olive Owner' WHERE id = $1", [owner.userId]);
    const ws = await createWorkspace(owner);
    const other = await createUser("viewer-a12@example.com");
    await addMember(ws, other, "viewer");
    const scope = await scopedTo(owner, ws);

    const res = await app.inject({ method: "GET", url: apiUrl(`/workspaces/${ws}/members`), ...scope });
    expect(res.statusCode).toBe(200);
    const rows = dataOf<Array<{ user_id: string; name: string | null; email: string }>>(res);
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    expect(byUser.get(owner.userId)).toMatchObject({ name: "Olive Owner", email: "owner-a12@example.com" });
    expect(byUser.get(other)).toMatchObject({ name: null, email: "viewer-a12@example.com" });
  });

  it("NEW-A-12 · isolation — listing A never returns a user who is only in B, though the caller belongs to both", async () => {
    const caller = await newSession("caller-a12@example.com");
    const wsA = await createWorkspace(caller, "Iso A");
    // The caller owns A; B is a workspace somebody else owns that the caller also joined.
    const ownerB = await newSession("ownerb-a12@example.com");
    const wsB = await createWorkspace(ownerB, "Iso B");
    await addMember(wsB, caller.userId, "admin");
    const onlyInB = await createUser("only-in-b@example.com");
    await addMember(wsB, onlyInB, "viewer");

    const scopeA = await scopedTo(caller, wsA);
    const res = await app.inject({ method: "GET", url: apiUrl(`/workspaces/${wsA}/members`), ...scopeA });
    expect(res.statusCode).toBe(200);
    const rows = dataOf<Array<{ user_id: string; email: string }>>(res);
    expect(rows.map((r) => r.user_id)).not.toContain(onlyInB);
    expect(rows.map((r) => r.user_id)).not.toContain(ownerB.userId);
    expect(rows.map((r) => r.email)).not.toContain("only-in-b@example.com");
    expect(rows.map((r) => r.user_id)).toEqual([caller.userId]);
  });

  it("NEW-A-12 · a path id that differs from the token's ws claim is a 403 on members, workspace detail and invitation revoke", async () => {
    const caller = await newSession();
    const wsA = await createWorkspace(caller, "Claim A");
    const ownerB = await newSession();
    const wsB = await createWorkspace(ownerB, "Claim B");
    await addMember(wsB, caller.userId, "admin");
    const scopeA = await scopedTo(caller, wsA);

    const members = await app.inject({ method: "GET", url: apiUrl(`/workspaces/${wsB}/members`), ...scopeA });
    expect(members.statusCode).toBe(403);
    const detail = await app.inject({ method: "GET", url: apiUrl(`/workspaces/${wsB}`), ...scopeA });
    expect(detail.statusCode).toBe(403);
    const revoke = await app.inject({
      method: "DELETE",
      url: apiUrl(`/workspaces/${wsB}/invitations/${randomUUID()}`),
      ...scopeA,
    });
    expect(revoke.statusCode).toBe(403);
  });

  // ---- GET /workspaces/{id} -------------------------------------------------

  it("NEW-A-12 · GET /workspaces/{id} returns the detail with deletion_scheduled_at null, and an ETag", async () => {
    const owner = await newSession();
    const ws = await createWorkspace(owner, "Detail Co");
    const scope = await scopedTo(owner, ws);
    const res = await app.inject({ method: "GET", url: apiUrl(`/workspaces/${ws}`), ...scope });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)).toMatchObject({ id: ws, name: "Detail Co", deletion_scheduled_at: null });
    expect(res.headers.etag).toMatch(/^"[^"]+"$/);
  });

  it("NEW-A-12 · a pending-deletion workspace reports deletion_scheduled_at (deletion_execute_at)", async () => {
    const owner = await newSession();
    const ws = await createWorkspace(owner);
    await db.query("UPDATE workspaces SET deletion_execute_at = '2030-01-01T00:00:00Z' WHERE id = $1", [ws]);
    const scope = await scopedTo(owner, ws);
    const res = await app.inject({ method: "GET", url: apiUrl(`/workspaces/${ws}`), ...scope });
    expect(dataOf<{ deletion_scheduled_at: string }>(res).deletion_scheduled_at).toBe("2030-01-01T00:00:00.000Z");
  });

  // ---- DELETE /workspaces/{id}/invitations/{invitationId} ---------------------

  it("NEW-A-12 · revoking a pending invitation sets revoked_at, writes member.invitation_revoked and drops it from the list", async () => {
    const owner = await newSession();
    const ws = await createWorkspace(owner);
    const scope = await scopedTo(owner, ws);
    const inv = await invite(scope, ws, "revokee@example.com");

    const res = await app.inject({ method: "DELETE", url: apiUrl(`/workspaces/${ws}/invitations/${inv.id}`), ...scope });
    expect(res.statusCode).toBe(200);
    const row = await db.query("SELECT revoked_at FROM workspace_invitations WHERE id = $1", [inv.id]);
    expect(row.rows[0].revoked_at).not.toBeNull();
    expect(await auditRow(ws, "member.invitation_revoked")).toEqual({ actor_id: owner.userId, resource_id: inv.id });

    const list = await app.inject({ method: "GET", url: apiUrl(`/workspaces/${ws}/invitations`), ...scope });
    expect(dataOf<Array<{ id: string }>>(list).map((i) => i.id)).not.toContain(inv.id);
  });

  it("NEW-A-12 · revoking needs member permission — a viewer gets 403 naming it, and the invitation survives", async () => {
    const owner = await newSession();
    const ws = await createWorkspace(owner);
    const ownerScope = await scopedTo(owner, ws);
    const inv = await invite(ownerScope, ws, "survivor@example.com");
    const viewer = await newSession();
    await addMember(ws, viewer.userId, "viewer");
    const viewerScope = await scopedTo(viewer, ws);

    const res = await app.inject({ method: "DELETE", url: apiUrl(`/workspaces/${ws}/invitations/${inv.id}`), ...viewerScope });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).toContain("member:invite");
    const row = await db.query("SELECT revoked_at FROM workspace_invitations WHERE id = $1", [inv.id]);
    expect(row.rows[0].revoked_at).toBeNull();
  });

  it("NEW-A-12 · another tenant's invitation id under my own workspace is a 404 and is left untouched", async () => {
    const ownerA = await newSession();
    const wsA = await createWorkspace(ownerA);
    const ownerB = await newSession();
    const wsB = await createWorkspace(ownerB);
    const scopeB = await scopedTo(ownerB, wsB);
    const invB = await invite(scopeB, wsB, "b-invitee@example.com");
    const scopeA = await scopedTo(ownerA, wsA);

    const res = await app.inject({ method: "DELETE", url: apiUrl(`/workspaces/${wsA}/invitations/${invB.id}`), ...scopeA });
    expect(res.statusCode).toBe(404);
    const row = await db.query("SELECT revoked_at FROM workspace_invitations WHERE id = $1", [invB.id]);
    expect(row.rows[0].revoked_at).toBeNull();
    expect(await auditRow(wsA, "member.invitation_revoked")).toBeUndefined();
  });

  it("NEW-A-12 · revoking an already-revoked or accepted invitation is a 404, not a second audit row", async () => {
    const owner = await newSession();
    const ws = await createWorkspace(owner);
    const scope = await scopedTo(owner, ws);
    const inv = await invite(scope, ws, "twice@example.com");
    const first = await app.inject({ method: "DELETE", url: apiUrl(`/workspaces/${ws}/invitations/${inv.id}`), ...scope });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "DELETE", url: apiUrl(`/workspaces/${ws}/invitations/${inv.id}`), ...scope });
    expect(second.statusCode).toBe(404);
    const unknown = await app.inject({ method: "DELETE", url: apiUrl(`/workspaces/${ws}/invitations/${randomUUID()}`), ...scope });
    expect(unknown.statusCode).toBe(404);
    const n = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = $1 AND action = 'member.invitation_revoked'", [ws]);
    expect(n.rows[0].n).toBe(1);
  });
});
