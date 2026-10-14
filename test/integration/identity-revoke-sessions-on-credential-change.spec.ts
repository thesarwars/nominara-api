import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { sessionsRevokeOthersResponseSchema } from "../../contracts/identity/sessions-revoke-others-response.schema.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, REFRESH_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { apiUrl } from "../support/api-url.js";
import { eachRequestFromItsOwnClient } from "../support/distinct-source.js";
import { dataOf } from "../support/envelope.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-018 — the last open AC: "credential change" revokes sessions. Passkey
// revoke and OAuth unlink end every OTHER session of the account; a new
// POST /me/sessions/revoke-others does it on request. The session that made the
// call survives. Real Postgres, through the real, deployed ApiModule, because
// the property is "the very next request with the old cookie is refused", which
// a mocked pool cannot show.
//
// A session is a global row (no RLS); revocation is by user, so it crosses
// workspaces: sessions whose active workspace differ are both ended.

type Tokens = Pick<SessionTokens, "accessToken" | "refreshToken" | "csrfToken">;

const session = (t: Tokens) => ({ [ACCESS_COOKIE_NAME]: t.accessToken, [REFRESH_COOKIE_NAME]: t.refreshToken, [CSRF_COOKIE_NAME]: t.csrfToken });
const mutating = (t: Tokens) => ({ cookies: session(t), headers: { [CSRF_HEADER_NAME]: t.csrfToken } });

describe("STORY-018 · session revocation on a credential change", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: NestFastifyApplication;
  let sessions: SessionService;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
    process.env = { ...originalEnv };
  });

  beforeEach(async () => {
    applyFakeApiEnv();
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
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    eachRequestFromItsOwnClient(app);
    sessions = app.get(SessionService);
  });

  afterEach(async () => {
    await app.close();
    await db.end();
  });

  async function user(email: string): Promise<string> {
    const r = await db.query<{ id: string }>(`INSERT INTO users (email, status, email_verified_at) VALUES ($1, 'active', now()) RETURNING id`, [email]);
    return r.rows[0]!.id;
  }
  async function passkey(userId: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO user_credentials (user_id, kind, credential_id, public_key, sign_count) VALUES ($1, 'passkey', $2, '\\x00'::bytea, 0) RETURNING id`,
      [userId, Buffer.from(randomUUID())],
    );
    return r.rows[0]!.id;
  }
  async function oauth(userId: string, provider = "google"): Promise<void> {
    await db.query(`INSERT INTO user_credentials (user_id, kind, provider, external_subject) VALUES ($1, 'oauth', $2, $3)`, [userId, provider, randomUUID()]);
  }
  /** A signed-in session; `fresh` false means its last strong auth is long past the step-up window. */
  async function signIn(userId: string, fresh = true): Promise<Tokens> {
    return sessions.createSession(userId, fresh ? new Date() : new Date(Date.now() - 60 * 60 * 1000), "email_otp");
  }
  async function workspaceFor(tokens: Tokens): Promise<void> {
    const ws = await db.query<{ id: string }>(`INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, 'growth') RETURNING id`, [`w-${randomUUID().slice(0, 8)}`]);
    const sid = JSON.parse(Buffer.from(tokens.accessToken.split(".")[1]!, "base64url").toString("utf8")).sid as string;
    await db.query(`UPDATE sessions SET active_workspace_id = $2 WHERE id = $1`, [sid, ws.rows[0]!.id]);
  }
  const me = (t: Tokens) => app.inject({ method: "GET", url: apiUrl("/me"), cookies: session(t) });
  const refresh = (t: Tokens) => app.inject({ method: "POST", url: apiUrl("/auth/refresh"), cookies: { [REFRESH_COOKIE_NAME]: t.refreshToken } });
  const revokePasskey = (t: Tokens, id: string) => app.inject({ method: "DELETE", url: apiUrl(`/me/passkeys/${id}`), ...mutating(t) });
  const revokeOthers = (t: Tokens) => app.inject({ method: "POST", url: apiUrl("/me/sessions/revoke-others"), ...mutating(t) });

  async function expectDead(t: Tokens): Promise<void> {
    expect((await me(t)).statusCode).toBe(401);
    expect((await refresh(t)).statusCode).toBe(401);
  }
  async function expectAlive(t: Tokens): Promise<void> {
    expect((await me(t)).statusCode).toBe(200);
  }

  it("STORY-018 · revoking a passkey ends every OTHER session at once (access AND refresh) and keeps the current one", async () => {
    const uid = await user("a@example.com");
    const keep = await passkey(uid);
    const gone = await passkey(uid);
    const current = await signIn(uid);
    const other1 = await signIn(uid);
    const other2 = await signIn(uid);

    expect((await revokePasskey(current, gone)).statusCode).toBe(200);

    await expectDead(other1);
    await expectDead(other2);
    await expectAlive(current);
    expect((await refresh(current)).statusCode).toBe(200);
    expect(keep).toBeTruthy();
  });

  it("STORY-018 · unlinking an OAuth provider ends every OTHER session and keeps the current one", async () => {
    const uid = await user("b@example.com");
    await passkey(uid);
    await oauth(uid);
    const current = await signIn(uid);
    const other = await signIn(uid);

    const res = await app.inject({ method: "DELETE", url: apiUrl("/me/oauth/google"), ...mutating(current) });
    expect(res.statusCode).toBe(200);

    await expectDead(other);
    await expectAlive(current);
  });

  it("STORY-018 · another user's sessions are untouched by a credential change", async () => {
    const a = await user("c@example.com");
    const b = await user("d@example.com");
    await passkey(a);
    const gone = await passkey(a);
    const aCurrent = await signIn(a);
    const aOther = await signIn(a);
    const bSession = await signIn(b);

    expect((await revokePasskey(aCurrent, gone)).statusCode).toBe(200);

    await expectDead(aOther);
    await expectAlive(bSession);
    expect((await refresh(bSession)).statusCode).toBe(200);
    const rows = await db.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NOT NULL`, [b]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("STORY-018 · revocation is by account, so sessions in different workspaces both end", async () => {
    const uid = await user("e@example.com");
    await passkey(uid);
    const gone = await passkey(uid);
    const current = await signIn(uid);
    const inWsA = await signIn(uid);
    const inWsB = await signIn(uid);
    await workspaceFor(inWsA);
    await workspaceFor(inWsB);
    await workspaceFor(current);

    expect((await revokePasskey(current, gone)).statusCode).toBe(200);

    await expectDead(inWsA);
    await expectDead(inWsB);
    await expectAlive(current);
  });

  it("STORY-018 · a passkey revoke that is refused (last credential) revokes no session", async () => {
    const uid = await user("f@example.com");
    const only = await passkey(uid);
    const current = await signIn(uid);
    const other = await signIn(uid);

    expect((await revokePasskey(current, only)).statusCode).toBe(409);

    await expectAlive(other);
    await expectAlive(current);
  });

  it("STORY-018 · a passkey revoke refused for a stale step-up revokes no session", async () => {
    const uid = await user("g@example.com");
    await passkey(uid);
    const gone = await passkey(uid);
    const stale = await signIn(uid, false);
    const other = await signIn(uid);

    const refused = await revokePasskey(stale, gone);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe("step_up_required");

    await expectAlive(other);
  });

  it("STORY-018 · POST /me/sessions/revoke-others ends the other sessions, keeps the caller, and answers the contract", async () => {
    const uid = await user("h@example.com");
    const current = await signIn(uid);
    const other1 = await signIn(uid);
    const other2 = await signIn(uid);

    const res = await revokeOthers(current);

    expect(res.statusCode).toBe(200);
    expect(sessionsRevokeOthersResponseSchema.parse(dataOf(res))).toEqual({ revoked_count: 2 });
    await expectDead(other1);
    await expectDead(other2);
    await expectAlive(current);
  });

  it("STORY-018 · POST /me/sessions/revoke-others is idempotent: a repeat revokes 0 and the caller still lives", async () => {
    const uid = await user("i@example.com");
    const current = await signIn(uid);
    await signIn(uid);

    expect(dataOf<{ revoked_count: number }>(await revokeOthers(current)).revoked_count).toBe(1);
    const again = await revokeOthers(current);
    expect(again.statusCode).toBe(200);
    expect(dataOf<{ revoked_count: number }>(again).revoked_count).toBe(0);
    await expectAlive(current);
  });

  it("STORY-018 · POST /me/sessions/revoke-others with no other session answers 0, not an absence", async () => {
    const uid = await user("j@example.com");
    const current = await signIn(uid);
    const res = await revokeOthers(current);
    expect(res.statusCode).toBe(200);
    expect(dataOf<{ revoked_count: number }>(res).revoked_count).toBe(0);
  });

  it("STORY-018 · POST /me/sessions/revoke-others never touches another user's sessions", async () => {
    const a = await user("k@example.com");
    const b = await user("l@example.com");
    const aCurrent = await signIn(a);
    await signIn(a);
    const bSession = await signIn(b);

    await revokeOthers(aCurrent);

    await expectAlive(bSession);
  });

  it("STORY-018 · POST /me/sessions/revoke-others needs a fresh step-up, like revoking a passkey, and revokes nothing without it", async () => {
    const uid = await user("m@example.com");
    const stale = await signIn(uid, false);
    const other = await signIn(uid);

    const res = await revokeOthers(stale);

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("step_up_required");
    await expectAlive(other);
  });

  it("STORY-018 · POST /me/sessions/revoke-others without a session is 401", async () => {
    const res = await app.inject({ method: "POST", url: apiUrl("/me/sessions/revoke-others"), payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("STORY-018 · an already-revoked session is not counted or rewritten (revoked_at keeps its first time)", async () => {
    const uid = await user("n@example.com");
    const current = await signIn(uid);
    const other = await signIn(uid);
    const sid = JSON.parse(Buffer.from(other.accessToken.split(".")[1]!, "base64url").toString("utf8")).sid as string;
    await db.query(`UPDATE sessions SET revoked_at = now() - interval '1 day', revoked_reason = 'logout' WHERE id = $1`, [sid]);
    const before = await db.query(`SELECT revoked_at FROM sessions WHERE id = $1`, [sid]);

    expect(dataOf<{ revoked_count: number }>(await revokeOthers(current)).revoked_count).toBe(0);

    const after = await db.query(`SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1`, [sid]);
    expect(after.rows[0].revoked_at).toEqual(before.rows[0].revoked_at);
    expect(after.rows[0].revoked_reason).toBe("logout");
  });
});
