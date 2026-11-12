import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as metrics from "../../src/lib/telemetry/metrics.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { sessionListResponseSchema } from "../../contracts/identity/session-list-response.schema.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, REFRESH_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { apiUrl } from "../support/api-url.js";
import { eachRequestFromItsOwnClient } from "../support/distinct-source.js";
import { dataOf } from "../support/envelope.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-096 AC4/AC7 (owner decision 100(d)) - GET /me/sessions and DELETE /me/sessions/{id}. `sessions` is a GLOBAL auth-only table (no RLS), so
// the control is the authenticated user_id in the WHERE of every statement: the path parameter alone never selects a row. Real Postgres through the real
// ApiModule, because "the very next request with the old cookie is refused" and "another account's session is untouched" cannot be shown by a mock.

type Tokens = Pick<SessionTokens, "accessToken" | "refreshToken" | "csrfToken">;

const session = (t: Tokens) => ({ [ACCESS_COOKIE_NAME]: t.accessToken, [REFRESH_COOKIE_NAME]: t.refreshToken, [CSRF_COOKIE_NAME]: t.csrfToken });
const mutating = (t: Tokens) => ({ cookies: session(t), headers: { [CSRF_HEADER_NAME]: t.csrfToken } });

describe("STORY-096 AC4/AC7 · own session list and single-session revoke", () => {
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
  /** A signed-in session; `fresh` false means its last strong auth is long past the step-up window. */
  async function signIn(userId: string, userAgent: string | null = null, fresh = true): Promise<Tokens & { sid: string }> {
    const tokens = await sessions.createSession(userId, new Date(), "email_otp");
    if (userAgent !== null) await db.query(`UPDATE sessions SET user_agent = $2 WHERE id = $1`, [tokens.sid, userAgent]);
    if (!fresh) await db.query(`UPDATE sessions SET last_strong_auth_at = now() - interval '1 hour' WHERE id = $1`, [tokens.sid]);
    return tokens;
  }
  const me = (t: Tokens) => app.inject({ method: "GET", url: apiUrl("/me"), cookies: session(t) });
  const refresh = (t: Tokens, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: apiUrl("/auth/refresh"), cookies: { [REFRESH_COOKIE_NAME]: t.refreshToken }, headers });
  const list = (t: Tokens, query = "") => app.inject({ method: "GET", url: apiUrl(`/me/sessions${query}`), cookies: session(t) });
  const revokeOne = (t: Tokens, id: string) => app.inject({ method: "DELETE", url: apiUrl(`/me/sessions/${id}`), ...mutating(t) });
  const listed = async (t: Tokens) => {
    const res = await list(t);
    expect(res.statusCode).toBe(200);
    return sessionListResponseSchema.parse(dataOf(res));
  };
  async function expectDead(t: Tokens): Promise<void> {
    expect((await me(t)).statusCode).toBe(401);
    expect((await refresh(t)).statusCode).toBe(401);
  }
  async function expectAlive(t: Tokens): Promise<void> {
    expect((await me(t)).statusCode).toBe(200);
  }

  const CHROME_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const SAFARI_IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

  it("STORY-096 AC4 · the list is the caller's own live sessions, the calling one marked current, device and browser parsed, nothing raw", async () => {
    const uid = await user("a@example.com");
    const stranger = await user("z@example.com");
    const current = await signIn(uid, CHROME_MAC);
    const phone = await signIn(uid, SAFARI_IPHONE);
    const bare = await signIn(uid, null);
    const revoked = await signIn(uid, CHROME_MAC);
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [revoked.sid]);
    const theirs = await signIn(stranger, CHROME_MAC);

    const res = await list(current);
    expect(res.statusCode).toBe(200);
    const items = sessionListResponseSchema.parse(dataOf(res));

    expect(items.map((i) => i.id).sort()).toEqual([current.sid, phone.sid, bare.sid].sort());
    expect(items.find((i) => i.id === theirs.sid)).toBeUndefined();
    expect(items.find((i) => i.id === revoked.sid)).toBeUndefined();
    expect(items.filter((i) => i.current).map((i) => i.id)).toEqual([current.sid]);
    expect(items.find((i) => i.id === current.sid)).toMatchObject({ browser: "Chrome", os: "macOS", device_type: "desktop" });
    expect(items.find((i) => i.id === phone.sid)).toMatchObject({ browser: "Safari", os: "iOS", device_type: "mobile", current: false });
    expect(items.find((i) => i.id === bare.sid)).toMatchObject({ browser: null, os: null, device_type: null });
    // The raw header and any address never leave the server.
    expect(res.body).not.toContain("Mozilla");
    expect(res.body).not.toMatch(/user_agent|\bip\b/i);
  });

  it("STORY-096 AC4 · a session whose refresh token has expired or been consumed without a successor is not listed (it cannot be used)", async () => {
    const uid = await user("exp@example.com");
    const current = await signIn(uid, CHROME_MAC);
    const stale = await signIn(uid, CHROME_MAC);
    await db.query(`UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE session_id = $1`, [stale.sid]);

    expect((await listed(current)).map((i) => i.id)).toEqual([current.sid]);
  });

  it("STORY-096 AC4 · last_active_at is the session's last sign-in or refresh, and a refresh moves it", async () => {
    const uid = await user("act@example.com");
    const t = await signIn(uid, CHROME_MAC);
    await db.query(`UPDATE sessions SET created_at = now() - interval '3 days', last_used_at = now() - interval '2 days' WHERE id = $1`, [t.sid]);
    const before = (await listed(t))[0]!;
    expect(Date.parse(before.last_active_at)).toBeLessThan(Date.now() - 24 * 3_600_000);
    expect(Date.parse(before.created_at)).toBeLessThan(Date.parse(before.last_active_at));

    const rotated = await refresh(t);
    expect(rotated.statusCode).toBe(200);
    const after = (await listed({ ...t, accessToken: cookieValue(rotated, ACCESS_COOKIE_NAME) }))[0]!;
    expect(Date.parse(after.last_active_at)).toBeGreaterThan(Date.parse(before.last_active_at));
    expect(after.created_at).toBe(before.created_at);
  });

  it("STORY-096 AC4 · the list is cursor-paginated: a page of one, then the rest, no repeats", async () => {
    const uid = await user("page@example.com");
    const a = await signIn(uid, CHROME_MAC);
    const b = await signIn(uid, CHROME_MAC);
    const c = await signIn(uid, CHROME_MAC);
    const first = await list(a, "?limit=2");
    expect(first.statusCode).toBe(200);
    const body = JSON.parse(first.body);
    expect(body.data).toHaveLength(2);
    expect(body.pagination.has_more).toBe(true);
    const second = await list(a, `?limit=2&cursor=${encodeURIComponent(body.pagination.cursor_next)}`);
    const rest = JSON.parse(second.body);
    expect(rest.data).toHaveLength(1);
    expect(rest.pagination.has_more).toBe(false);
    const ids = [...body.data, ...rest.data].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.sort()).toEqual([a.sid, b.sid, c.sid].sort());
  });

  it("STORY-096 AC7 · another account's session can be neither listed nor revoked: 404, identical to an unknown id, and it stays alive", async () => {
    const uid = await user("me@example.com");
    const other = await user("other@example.com");
    const mine = await signIn(uid);
    const theirs = await signIn(other);

    const foreign = await revokeOne(mine, theirs.sid);
    const unknown = await revokeOne(mine, randomUUID());
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(foreign.body).error.code).toBe(JSON.parse(unknown.body).error.code);
    expect(JSON.parse(foreign.body).error.message).toBe(JSON.parse(unknown.body).error.message);

    await expectAlive(theirs);
    const row = await db.query(`SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1`, [theirs.sid]);
    expect(row.rows[0]).toEqual({ revoked_at: null, revoked_reason: null });
    expect((await listed(mine)).map((i) => i.id)).toEqual([mine.sid]);
  });

  it("STORY-096 AC7 · revoking another of my own sessions ends it at once (access AND refresh), records user_revoked, and touches nothing else", async () => {
    const uid = await user("own@example.com");
    const bystander = await user("by@example.com");
    const current = await signIn(uid);
    const target = await signIn(uid);
    const sibling = await signIn(uid);
    const unrelated = await signIn(bystander);

    expect((await revokeOne(current, target.sid)).statusCode).toBe(200);

    await expectDead(target);
    await expectAlive(current);
    await expectAlive(sibling);
    await expectAlive(unrelated);
    const row = await db.query(`SELECT revoked_reason FROM sessions WHERE id = $1`, [target.sid]);
    expect(row.rows[0].revoked_reason).toBe("user_revoked");
    expect((await listed(current)).map((i) => i.id).sort()).toEqual([current.sid, sibling.sid].sort());
  });

  it("STORY-096 AC7 · revoking the CURRENT session signs it out like logout: allowed, ended at once, recorded user_revoked", async () => {
    const uid = await user("cur@example.com");
    const current = await signIn(uid);
    const other = await signIn(uid);

    expect((await revokeOne(current, current.sid)).statusCode).toBe(200);

    await expectDead(current);
    await expectAlive(other);
    const row = await db.query(`SELECT revoked_reason FROM sessions WHERE id = $1`, [current.sid]);
    expect(row.rows[0].revoked_reason).toBe("user_revoked");
  });

  it("STORY-096 AC7 · a repeat revoke of my own already-ended session is idempotent and does not rewrite its reason", async () => {
    const uid = await user("idem@example.com");
    const current = await signIn(uid);
    const target = await signIn(uid);
    expect((await revokeOne(current, target.sid)).statusCode).toBe(200);
    const first = await db.query(`SELECT revoked_at FROM sessions WHERE id = $1`, [target.sid]);
    expect((await revokeOne(current, target.sid)).statusCode).toBe(200);
    const second = await db.query(`SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1`, [target.sid]);
    expect(second.rows[0].revoked_at).toEqual(first.rows[0].revoked_at);
    expect(second.rows[0].revoked_reason).toBe("user_revoked");
  });

  it("STORY-096 AC7 · a session that ended for another reason keeps that reason when revoked again", async () => {
    const uid = await user("reason@example.com");
    const current = await signIn(uid);
    const target = await signIn(uid);
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [target.sid]);
    expect((await revokeOne(current, target.sid)).statusCode).toBe(200);
    const row = await db.query(`SELECT revoked_reason FROM sessions WHERE id = $1`, [target.sid]);
    expect(row.rows[0].revoked_reason).toBe("logout");
  });

  it("STORY-096 AC7 · revoking one session needs the same fresh step-up as revoke-others: a stale step-up is 401 step_up_required and revokes nothing", async () => {
    const uid = await user("stale@example.com");
    const current = await signIn(uid, null, false);
    const target = await signIn(uid);

    const res = await revokeOne(current, target.sid);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("step_up_required");
    expect(JSON.parse(res.body).error.details.methods).toEqual(["webauthn", "email_otp"]);
    await expectAlive(target);
  });

  it("STORY-096 AC7 · the step-up check comes before the lookup, so a stale session cannot probe which ids exist", async () => {
    const uid = await user("probe@example.com");
    const other = await user("probed@example.com");
    const current = await signIn(uid, null, false);
    const theirs = await signIn(other);
    const foreign = await revokeOne(current, theirs.sid);
    const unknown = await revokeOne(current, randomUUID());
    expect(foreign.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
  });

  it("STORY-096 AC4 · listing needs no step-up (it reveals nothing the signed-in person cannot already see)", async () => {
    const uid = await user("nostep@example.com");
    const current = await signIn(uid, CHROME_MAC, false);
    expect((await list(current)).statusCode).toBe(200);
  });

  it("STORY-096 AC7 · a non-uuid session id is a 400, not a query", async () => {
    const uid = await user("bad@example.com");
    const current = await signIn(uid);
    const res = await app.inject({ method: "DELETE", url: apiUrl("/me/sessions/not-a-uuid"), ...mutating(current) });
    expect(res.statusCode).toBe(400);
  });

  it("STORY-096 AC7 · no cookie, and a revoked session, are 401 on both routes", async () => {
    const uid = await user("anon@example.com");
    const dead = await signIn(uid);
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [dead.sid]);
    expect((await app.inject({ method: "GET", url: apiUrl("/me/sessions") })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: apiUrl(`/me/sessions/${randomUUID()}`) })).statusCode).toBe(401);
    expect((await list(dead)).statusCode).toBe(401);
    expect((await revokeOne(dead, dead.sid)).statusCode).toBe(401);
  });

  it("STORY-096 AC4 · a refresh stores the request's User-Agent (truncated to 512), and a refresh without one keeps the stored value", async () => {
    const uid = await user("ua@example.com");
    const t = await signIn(uid, null);
    const long = `Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0 ${"x".repeat(600)}`;
    const first = await refresh(t, { "user-agent": long });
    expect(first.statusCode).toBe(200);
    const stored = await db.query<{ user_agent: string }>(`SELECT user_agent FROM sessions WHERE id = $1`, [t.sid]);
    expect(stored.rows[0]!.user_agent).toHaveLength(512);
    expect(stored.rows[0]!.user_agent.startsWith("Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0")).toBe(true);

    const next = { ...t, refreshToken: cookieValue(first, REFRESH_COOKIE_NAME) };
    expect((await refresh(next, { "user-agent": "" })).statusCode).toBe(200);
    const kept = await db.query<{ user_agent: string }>(`SELECT user_agent FROM sessions WHERE id = $1`, [t.sid]);
    expect(kept.rows[0]!.user_agent).toHaveLength(512);
  });

  it("STORY-096 AC4 · the User-Agent is never logged, by list, revoke or refresh", async () => {
    const SENTINEL = "UA-SENTINEL-8f3a1c";
    const lines: string[] = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => void lines.push(String(message)));
    }
    const uid = await user("log@example.com");
    const current = await signIn(uid, `Mozilla/5.0 ${SENTINEL}`);
    const target = await signIn(uid, `Mozilla/5.0 ${SENTINEL}`);
    await list(current);
    await revokeOne(current, target.sid);
    await refresh(current, { "user-agent": `Mozilla/5.0 ${SENTINEL}` });
    await revokeOne(current, randomUUID());
    expect(lines.filter((l) => l.includes(SENTINEL))).toEqual([]);
    vi.restoreAllMocks();
  });

  it("STORY-096 AC4/AC7 · observability: a revoke counts itself and logs the account and session IDs only (spans: test/unit/session-self-service-spans.spec.ts)", async () => {
    const spy = vi.spyOn(metrics, "incrementCounter");
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void lines.push(String(message)));
    try {
      const uid = await user("obs-secret@example.com");
      const current = await signIn(uid, CHROME_MAC);
      const target = await signIn(uid, CHROME_MAC);
      await list(current);
      await revokeOne(current, target.sid);

      const counted = spy.mock.calls.filter(([name]) => name === "nominara_identity_sessions_revoked_total").map(([, labels]) => labels?.reason);
      expect(counted).toEqual(["session_revoke"]);
      const line = lines.find((l) => l.includes("session revoked by its owner"));
      expect(line).toContain(`user_id=${uid}`);
      expect(line).toContain(`session_id=${target.sid}`);
      expect(lines.join("\n")).not.toContain("obs-secret@example.com");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("STORY-096 AC4/AC7 · no IP address is stored on a session (the table has no such column)", async () => {
    const cols = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions'`);
    expect(cols.rows.map((r) => r.column_name).filter((c) => /ip|addr/i.test(c))).toEqual([]);
  });

  it("STORY-096 AC7 · the revoked_reason CHECK admits user_revoked and still refuses an unknown reason", async () => {
    const uid = await user("chk@example.com");
    const t = await signIn(uid);
    await expect(db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'nonsense' WHERE id = $1`, [t.sid])).rejects.toThrow(/sessions_revoked_reason_check/);
    await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'user_revoked' WHERE id = $1`, [t.sid]);
  });

  it("STORY-096 AC4/AC7 · grants are unchanged: sessions stays reachable by nominara_app only", async () => {
    const rows = await db.query<{ grantee: string }>(
      `SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_name = 'sessions' AND grantee IN ('nominara_worker','nominara_report','nominara_portal')`,
    );
    expect(rows.rows).toEqual([]);
  });
});

function cookieValue(res: { cookies: { name: string; value: string }[] }, name: string): string {
  const c = res.cookies.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} cookie`);
  return c.value;
}
