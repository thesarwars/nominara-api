import { randomUUID } from "node:crypto";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { NotAMemberException, WorkspaceSuspendedException } from "../../src/tenancy/errors.js";
import { importEd25519PublicKeyFromDer, verifyAccessToken } from "../../src/lib/auth/access-token.js";
import { computeCsrfToken } from "../../src/lib/auth/csrf.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../support/test-valkey.js";

// STORY-021 — Test Scenario 6. Real Postgres: switchTo() verifies live
// membership through withTenantContext (RLS-scoped tables), so its
// correctness cannot be trusted against a mocked pg client.

const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
const KID = "test-kid-1";
const WRAPPING_KEY = Buffer.alloc(32, 11);

describe("STORY-021 · workspace switching mints a fresh, single-tenant token", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaces: WorkspacesService;
  let sessions: SessionService;

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
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = PRIVATE_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = PUBLIC_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_KID = KID;
    process.env.CSRF_SECRET = "test-csrf-secret";
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

    pool = new Pool({ connectionString: container.getConnectionUri() });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool);
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

  const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  async function createUser(email = `user-${randomUUID()}@example.com`): Promise<string> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [email]);
    return result.rows[0]!.id;
  }

  async function decode(token: string) {
    const publicKey = importEd25519PublicKeyFromDer(PUBLIC_KEY_DER);
    return verifyAccessToken(token, () => publicKey);
  }

  // ---- scenario 6 ---------------------------------------------------------

  it("scenario 6 — switching mints a fresh token scoped to the target workspace, and the old token stays scoped to what it always was", async () => {
    const userId = await createUser();
    const workspace = await workspaces.create(userId, { name: `Workspace ${randomUUID()}` }, meta);

    const initialTokens = await sessions.createSession(userId);
    const initialClaims = await decode(initialTokens.accessToken);
    expect(initialClaims.ws).toBeNull(); // "workspace context starts empty"

    const switched = await workspaces.switchTo(userId, initialTokens.sid, workspace.id, meta);
    const switchedClaims = await decode(switched.accessToken);

    expect(switchedClaims.ws).toBe(workspace.id);
    expect(switchedClaims.role).toBe("owner");
    expect(switchedClaims.sid).toBe(initialTokens.sid); // same session, re-minted claims

    // The old token, re-verified now, still carries what it always carried —
    // switching never mutates an already-issued token, it mints a new one.
    const oldClaimsAgain = await decode(initialTokens.accessToken);
    expect(oldClaimsAgain.ws).toBeNull();
    expect(oldClaimsAgain.ws).not.toBe(switchedClaims.ws);
  });

  it("scenario 6 — switching records the last active workspace on the target membership row", async () => {
    const userId = await createUser();
    const workspace = await workspaces.create(userId, { name: `Workspace ${randomUUID()}` }, meta);
    const tokens = await sessions.createSession(userId);

    const before = await db.query<{ last_active_at: Date | null }>(
      "SELECT last_active_at FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspace.id, userId],
    );
    expect(before.rows[0]!.last_active_at).toBeNull();

    await workspaces.switchTo(userId, tokens.sid, workspace.id, meta);

    const after = await db.query<{ last_active_at: Date | null }>(
      "SELECT last_active_at FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspace.id, userId],
    );
    expect(after.rows[0]!.last_active_at).not.toBeNull();
  });

  it("scenario 6 — switching appends a workspace.switched audit row", async () => {
    const userId = await createUser();
    const workspace = await workspaces.create(userId, { name: `Workspace ${randomUUID()}` }, meta);
    const tokens = await sessions.createSession(userId);

    await workspaces.switchTo(userId, tokens.sid, workspace.id, meta);

    const audit = await db.query<{ action: string; actor_id: string }>(
      "SELECT action, actor_id FROM audit_log WHERE workspace_id = $1 AND action = 'workspace.switched'",
      [workspace.id],
    );
    expect(audit.rows[0]).toEqual({ action: "workspace.switched", actor_id: userId });
  });

  it("switching to a workspace the caller is not an active member of is refused, and mints nothing", async () => {
    const userId = await createUser();
    const otherOwnerId = await createUser();
    const otherWorkspace = await workspaces.create(otherOwnerId, { name: `Other ${randomUUID()}` }, meta);
    const tokens = await sessions.createSession(userId);

    await expect(workspaces.switchTo(userId, tokens.sid, otherWorkspace.id, meta)).rejects.toBeInstanceOf(
      NotAMemberException,
    );

    const audit = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_log WHERE workspace_id = $1",
      [otherWorkspace.id],
    );
    expect(Number(audit.rows[0]!.count)).toBe(1); // only workspace.created, no workspace.switched
  });

  it("switching to a workspace where membership status is not active is refused", async () => {
    const userId = await createUser();
    const otherOwnerId = await createUser();
    const otherWorkspace = await workspaces.create(otherOwnerId, { name: `Other ${randomUUID()}` }, meta);
    await db.query(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','suspended')",
      [randomUUID(), otherWorkspace.id, userId],
    );
    const tokens = await sessions.createSession(userId);

    await expect(workspaces.switchTo(userId, tokens.sid, otherWorkspace.id, meta)).rejects.toBeInstanceOf(
      NotAMemberException,
    );
  });

  it("switching to a suspended workspace is refused even for its own owner — a token would be good for zero requests otherwise", async () => {
    const userId = await createUser();
    const workspace = await workspaces.create(userId, { name: `Workspace ${randomUUID()}` }, meta);
    await workspaces.suspend(pool, workspace.id);
    const tokens = await sessions.createSession(userId);

    await expect(workspaces.switchTo(userId, tokens.sid, workspace.id, meta)).rejects.toBeInstanceOf(
      WorkspaceSuspendedException,
    );
  });

  it("switching with a revoked session is refused before a new token is minted", async () => {
    const userId = await createUser();
    const workspace = await workspaces.create(userId, { name: `Workspace ${randomUUID()}` }, meta);
    const tokens = await sessions.createSession(userId);
    await sessions.logout(tokens.sid);

    await expect(workspaces.switchTo(userId, tokens.sid, workspace.id, meta)).rejects.toThrow("session revoked");
  });

  // Code-review should-fix finding 2 — the tests above only decode claims;
  // they never prove a pre-switch token is actually refused by the real
  // guard/interceptor chain over HTTP. Boots the REAL, deployed ApiModule
  // (same pattern as workspace-mutations-audit.spec.ts) so this is an
  // end-to-end check, not just a JWT-decode assertion.
  describe("STORY-021 code review · a pre-switch token is refused against a live, guarded workspace-scoped route", () => {
    let app: NestFastifyApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      await configureApp(app);
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("the pre-switch (ws: null) cookie is rejected by PATCH /workspaces/{newWorkspaceId}, not just still ws:null on decode", async () => {
      const httpSessions = app.get(SessionService);
      const userId = await createUser();
      const tokens = await httpSessions.createSession(userId);
      const csrf = computeCsrfToken(tokens.sid, "test-csrf-secret");

      const createRes = await app.inject({
        method: "POST",
        url: apiUrl("/workspaces"),
        cookies: { [ACCESS_COOKIE_NAME]: tokens.accessToken, [CSRF_COOKIE_NAME]: csrf },
        headers: { [CSRF_HEADER_NAME]: csrf },
        payload: { name: `Guarded Co ${randomUUID()}` },
      });
      expect(createRes.statusCode).toBe(201);
      const workspace = dataOf<{ id: string }>(createRes);

      // Never called /workspaces/{id}/switch — this is still the ORIGINAL,
      // pre-switch access token, which carries `ws: null`.
      const patchRes = await app.inject({
        method: "PATCH",
        url: apiUrl(`/workspaces/${workspace.id}`),
        cookies: { [ACCESS_COOKIE_NAME]: tokens.accessToken, [CSRF_COOKIE_NAME]: csrf },
        headers: { [CSRF_HEADER_NAME]: csrf },
        payload: { name: "Should not apply" },
      });
      expect([401, 403, 404]).toContain(patchRes.statusCode);

      const stillOriginal = await db.query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [
        workspace.id,
      ]);
      expect(stillOriginal.rows[0]!.name).not.toBe("Should not apply");
    });
  });
});
