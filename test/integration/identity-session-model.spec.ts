import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { AuthGuard, type AuthenticatedRequest } from "../../src/api/guards/auth.guard.js";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { apiUrl } from "../support/api-url.js";
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_NAME,
} from "../../src/lib/auth/cookies.js";
import { REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS } from "../../src/lib/auth/refresh-token.js";
import * as metrics from "../../src/lib/telemetry/metrics.js";

// STORY-170 — this file's env block sets no REFRESH_TOKEN_GRACE_WINDOW_MS,
// so SessionService.refresh uses the schema's own default. A replay
// presented this far after the rotation that consumed it is unambiguously
// OUTSIDE the window regardless of how long the default ever changes to.
function afterGraceWindow(base: Date): Date {
  return new Date(base.getTime() + REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS + 1_000);
}

interface ParsedCookie {
  name: string;
  value: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  maxAge?: number;
  expires?: Date;
}

function cookiesByName(res: { cookies: Array<{ name: string; value: string }> }): Map<string, ParsedCookie> {
  return new Map(res.cookies.map((c) => [c.name, c as unknown as ParsedCookie]));
}

function decodeClaims(token: string): Record<string, unknown> {
  const [, payloadB64url] = token.split(".");
  return JSON.parse(Buffer.from(payloadB64url!, "base64url").toString("utf8"));
}

function makeContext(req: AuthenticatedRequest) {
  return {
    getHandler: () => (): void => {},
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as Parameters<AuthGuard["canActivate"]>[0];
}

// STORY-017 — dangerous area: rotation and full-history reuse detection.
// Real Postgres (testcontainers, testing-strategy.md §1) — the correctness
// of SELECT ... FOR UPDATE row locking and the BEGIN/COMMIT/ROLLBACK
// boundaries in session.service.ts cannot be trusted against a mocked pg
// Pool.
describe("STORY-017 · session model, rotating refresh, reuse detection", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let sessions: SessionService;
  let userId: string;
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
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";
    // STORY-021 — WORKSPACE_DEK_WRAPPING_KEY became required by the global
    // env schema this story extended; SessionService's loadEnv() call now
    // needs it even though this file provisions no DEK.
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

    const userRow = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      "session-model@example.com",
    ]);
    userId = userRow.rows[0]!.id;

    pool = new Pool({ connectionString: container.getConnectionUri() });
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()));
  });

  afterEach(async () => {
    await pool.end();
    await db.end();
    vi.restoreAllMocks();
  });

  it("STORY-017 · scenario 1 — a freshly created session's access token authorises a protected request", async () => {
    const tokens = await sessions.createSession(userId);
    const guard = new AuthGuard(new Reflector(), pool);
    const req: AuthenticatedRequest = { cookies: { [ACCESS_COOKIE_NAME]: tokens.accessToken }, method: "GET" };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.auth?.sid).toBe(tokens.sid);
  });

  it("STORY-017 · scenario 3 — refresh rotates: a new access and refresh token are issued, and the old refresh token is dead once its STORY-170 grace window has closed", async () => {
    const now = new Date();
    const initial = await sessions.createSession(userId);

    const rotated = await sessions.refresh(initial.refreshToken, now);

    expect(rotated.sid).toBe(initial.sid);
    expect(rotated.accessToken).not.toBe(initial.accessToken);
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);

    // STORY-170 — an IMMEDIATE replay is now the grace-window case
    // (session-refresh-grace-window.spec.ts owns that behaviour); this
    // scenario's own assertion — the old refresh token is genuinely dead —
    // is presented OUTSIDE the (default 2s) window, past
    // OUTSIDE_GRACE_WINDOW_MS below.
    await expect(sessions.refresh(initial.refreshToken, afterGraceWindow(now))).rejects.toThrow(UnauthorizedException);
  });

  it("STORY-017 · scenario 4 — presenting a consumed refresh token OUTSIDE its STORY-170 grace window revokes the whole family and raises a security event", async () => {
    const counterSpy = vi.spyOn(metrics, "incrementCounter");
    const now = new Date();
    const initial = await sessions.createSession(userId);
    await sessions.refresh(initial.refreshToken, now);

    // STORY-170 — an immediate replay is grace-eligible
    // (session-refresh-grace-window.spec.ts's own scenario for that); this
    // scenario is specifically the reuse case that still revokes — the
    // SAME consumed token, presented once the window has closed.
    await expect(sessions.refresh(initial.refreshToken, afterGraceWindow(now))).rejects.toThrow(
      "refresh token already used",
    );

    const sessionRow = await db.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      "SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1",
      [initial.sid],
    );
    expect(sessionRow.rows[0]!.revoked_at).not.toBeNull();
    expect(sessionRow.rows[0]!.revoked_reason).toBe("reuse_detected");
    expect(counterSpy).toHaveBeenCalledWith(
      "nominara_identity_session_reuse_detected_total",
      expect.objectContaining({ session_id: initial.sid }),
    );
  });

  it("STORY-017 · full-history reuse detection — replaying a token from two rotations back still revokes the family and kills the still-unconsumed latest token", async () => {
    const initial = await sessions.createSession(userId);
    const afterFirstRotation = await sessions.refresh(initial.refreshToken);
    const afterSecondRotation = await sessions.refresh(afterFirstRotation.refreshToken);

    // Three refresh_tokens rows now exist for this session: initial
    // (consumed by the first rotation), afterFirstRotation's token
    // (consumed by the second rotation), and afterSecondRotation's token
    // (still active). Replay the ORIGINAL — two rotations stale, not the
    // immediately-previous token scenario 4 already covers.
    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");

    const sessionRow = await db.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      "SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1",
      [initial.sid],
    );
    expect(sessionRow.rows[0]!.revoked_at).not.toBeNull();
    expect(sessionRow.rows[0]!.revoked_reason).toBe("reuse_detected");

    // The latest refresh token was never itself presented twice and was
    // still unconsumed at the moment of reuse — but the whole family died,
    // so it is dead too.
    await expect(sessions.refresh(afterSecondRotation.refreshToken)).rejects.toThrow("session revoked");
  });

  it("STORY-017 · scenario 5 — a previously-issued access token is refused via the deny list once family revocation has happened", async () => {
    const now = new Date();
    const initial = await sessions.createSession(userId);
    const rotated = await sessions.refresh(initial.refreshToken, now);
    // Reuse of the now-consumed original refresh token, OUTSIDE its
    // STORY-170 grace window, revokes the family.
    await expect(sessions.refresh(initial.refreshToken, afterGraceWindow(now))).rejects.toThrow(
      "refresh token already used",
    );

    const guard = new AuthGuard(new Reflector(), pool);
    const req: AuthenticatedRequest = { cookies: { [ACCESS_COOKIE_NAME]: rotated.accessToken }, method: "GET" };

    await expect(guard.canActivate(makeContext(req))).rejects.toThrow("session revoked");
  });

  it("STORY-017 · scenario 8 — switching workspace mints a new token bearing the same sid but a new ws claim; the old token still carries no workspace", async () => {
    const initial = await sessions.createSession(userId);
    const initialClaims = decodeClaims(initial.accessToken);
    expect(initialClaims.ws).toBeNull();

    // STORY-170 — sessions.active_workspace_id now FK-references workspaces
    // (migration 0029), so switchWorkspace's own UPDATE needs a real row to
    // point at, not just a plausible-looking uuid literal.
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'Test Workspace', $2, 'free')", [
      "0192f1a0-aaaa-7000-8000-000000000001",
      "test-workspace-scenario-8",
    ]);

    const switched = await sessions.switchWorkspace(
      initial.sid,
      userId,
      "0192f1a0-aaaa-7000-8000-000000000001",
      "owner",
      ["read", "write"],
      3,
    );
    const switchedClaims = decodeClaims(switched.accessToken);

    expect(switchedClaims.sid).toBe(initial.sid);
    expect(switchedClaims.ws).toBe("0192f1a0-aaaa-7000-8000-000000000001");
    expect(switchedClaims.ws).not.toBe(initialClaims.ws);
  });

  it("STORY-017 · logout revokes the family; the session's still-unconsumed refresh token can no longer be redeemed", async () => {
    const initial = await sessions.createSession(userId);

    await sessions.logout(initial.sid);

    const sessionRow = await db.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      "SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1",
      [initial.sid],
    );
    expect(sessionRow.rows[0]!.revoked_at).not.toBeNull();
    expect(sessionRow.rows[0]!.revoked_reason).toBe("logout");

    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("session revoked");
  });

  it("STORY-017 · scenario 10 (narrowed) — AuthGuard authorises identical requests regardless of the role claim's value", async () => {
    const ownerTokens = await sessions.createSession(userId);
    // STORY-170 — see scenario 8's own comment: a real row, not a bare uuid.
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'Test Workspace', $2, 'free')", [
      "0192f1a0-aaaa-7000-8000-000000000001",
      "test-workspace-scenario-10",
    ]);
    const asOwner = await sessions.switchWorkspace(
      ownerTokens.sid,
      userId,
      "0192f1a0-aaaa-7000-8000-000000000001",
      "owner",
      null,
      1,
    );
    const asViewer = await sessions.switchWorkspace(
      ownerTokens.sid,
      userId,
      "0192f1a0-aaaa-7000-8000-000000000001",
      "viewer",
      null,
      1,
    );

    const guard = new AuthGuard(new Reflector(), pool);
    const ownerReq: AuthenticatedRequest = { cookies: { [ACCESS_COOKIE_NAME]: asOwner.accessToken }, method: "GET" };
    const viewerReq: AuthenticatedRequest = { cookies: { [ACCESS_COOKIE_NAME]: asViewer.accessToken }, method: "GET" };

    await expect(guard.canActivate(makeContext(ownerReq))).resolves.toBe(true);
    await expect(guard.canActivate(makeContext(viewerReq))).resolves.toBe(true);
    expect(ownerReq.auth?.role).toBe("owner");
    expect(viewerReq.auth?.role).toBe("viewer");
  });

  // Post-QA-review gap fill — /auth/refresh and /auth/logout previously had
  // zero HTTP-level coverage; every test above drives SessionService/
  // AuthGuard directly as plain classes, so a bug in IdentityController's
  // routing, cookie-reading, or Set-Cookie writing could not be caught.
  // Boots the REAL, deployed ApiModule (every guard/interceptor
  // api.module.ts actually registers) — not a stripped test module — so
  // this also proves @SkipTenantContext() is wired on /auth/logout the same
  // way identity-passkey-webauthn.spec.ts already proved it for
  // /me/passkeys: logout is reachable through the real
  // TenantContextInterceptor, which fails closed on any non-@Public() route
  // with no req.tenant.
  describe("STORY-017 · /auth/refresh and /auth/logout through the real, deployed ApiModule", () => {
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

    it("POST /auth/refresh with a valid refresh cookie returns 200, sets new access/refresh/csrf cookies, and an immediate replay (STORY-170 grace window) converges on the SAME refresh token rather than dying", async () => {
      const sessionService = app.get(SessionService);
      const initial = await sessionService.createSession(userId);

      const res = await app.inject({
        method: "POST",
        url: apiUrl("/auth/refresh"),
        cookies: { [REFRESH_COOKIE_NAME]: initial.refreshToken },
      });

      expect(res.statusCode).toBe(200);
      const byName = cookiesByName(res);
      const access = byName.get(ACCESS_COOKIE_NAME);
      const refresh = byName.get(REFRESH_COOKIE_NAME);
      const csrf = byName.get(CSRF_COOKIE_NAME);
      expect(access?.value).toBeTruthy();
      expect(refresh?.value).toBeTruthy();
      expect(csrf?.value).toBeTruthy();
      expect(refresh?.value).not.toBe(initial.refreshToken);

      // STORY-170 — this replay lands well inside the default 2s grace
      // window (real elapsed wall-clock time between two `app.inject()`
      // calls in the same test), so it is a grace-window hit, not reuse:
      // 200, the SAME successor cookie, session still alive.
      // session-refresh-grace-window.spec.ts owns proving the OUTSIDE-window
      // and two-back cases still revoke.
      const replay = await app.inject({
        method: "POST",
        url: apiUrl("/auth/refresh"),
        cookies: { [REFRESH_COOKIE_NAME]: initial.refreshToken },
      });
      expect(replay.statusCode).toBe(200);
      expect(cookiesByName(replay).get(REFRESH_COOKIE_NAME)?.value).toBe(refresh?.value);

      const sessionRow = await pool.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM sessions WHERE id = $1", [
        initial.sid,
      ]);
      expect(sessionRow.rows[0]!.revoked_at).toBeNull();
    });

    it("POST /auth/refresh with no refresh cookie is refused", async () => {
      const res = await app.inject({ method: "POST", url: apiUrl("/auth/refresh") });
      expect(res.statusCode).toBe(401);
    });

    it("POST /auth/logout revokes the family (a subsequent refresh with the same family's token fails) and clears the auth cookies in its response", async () => {
      const sessionService = app.get(SessionService);
      const initial = await sessionService.createSession(userId);

      const logoutRes = await app.inject({
        method: "POST",
        url: apiUrl("/auth/logout"),
        cookies: { [ACCESS_COOKIE_NAME]: initial.accessToken, [CSRF_COOKIE_NAME]: initial.csrfToken },
        headers: { [CSRF_HEADER_NAME]: initial.csrfToken },
      });
      expect(logoutRes.statusCode).toBe(200);

      // clearAuthCookies (src/lib/auth/cookies.ts) calls reply.clearCookie
      // for each of the three cookies with `{ path: "/" }` only — @fastify/
      // cookie's clearCookie forces `value: ""`, `maxAge: 0`, and
      // `expires: new Date(0)` regardless of what's passed, so THAT is the
      // wire behavior to assert, not made-up flags the code never sets.
      const byName = cookiesByName(logoutRes);
      for (const name of [ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME]) {
        const cleared = byName.get(name);
        expect(cleared).toBeDefined();
        expect(cleared?.value).toBe("");
        expect(cleared?.maxAge).toBe(0);
        expect(cleared?.expires && cleared.expires.getTime()).toBe(0);
      }

      const refreshAttempt = await app.inject({
        method: "POST",
        url: apiUrl("/auth/refresh"),
        cookies: { [REFRESH_COOKIE_NAME]: initial.refreshToken },
      });
      expect(refreshAttempt.statusCode).toBe(401);
    });

    // Post-QA-review gap fill — no test previously parsed the actual
    // Set-Cookie response headers for the hardened flag set / __Host-
    // prefix the story's Implementation Decisions require verbatim.
    it("cookie hardening on the wire — HttpOnly split, Secure, SameSite=Lax, Path=/, and the __Host- prefix on all three cookies", async () => {
      const sessionService = app.get(SessionService);
      const initial = await sessionService.createSession(userId);

      const res = await app.inject({
        method: "POST",
        url: apiUrl("/auth/refresh"),
        cookies: { [REFRESH_COOKIE_NAME]: initial.refreshToken },
      });
      expect(res.statusCode).toBe(200);

      const byName = cookiesByName(res);
      const access = byName.get(ACCESS_COOKIE_NAME);
      const refresh = byName.get(REFRESH_COOKIE_NAME);
      const csrf = byName.get(CSRF_COOKIE_NAME);
      expect(access).toBeDefined();
      expect(refresh).toBeDefined();
      expect(csrf).toBeDefined();

      for (const cookie of [access, refresh, csrf]) {
        expect(cookie?.name.startsWith("__Host-")).toBe(true);
        expect(cookie?.secure).toBe(true);
        expect(cookie?.sameSite).toBe("Lax");
        expect(cookie?.path).toBe("/");
      }

      // HttpOnly on access + refresh; explicitly NOT on the CSRF cookie —
      // client JS must read it to mirror it into X-Nominara-CSRF-Token.
      expect(access?.httpOnly).toBe(true);
      expect(refresh?.httpOnly).toBe(true);
      expect(csrf?.httpOnly).toBeFalsy();
    });
  });
});
