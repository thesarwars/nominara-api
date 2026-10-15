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
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, REFRESH_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { apiUrl } from "../support/api-url.js";
import { eachRequestFromItsOwnClient } from "../support/distinct-source.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-018 follow-up — a missing or stale step-up must answer the documented
// Problem Details over HTTP (api-specification.md §2/§3): 401, code
// `step_up_required`, `details.methods` = webauthn + email_otp. A request with no
// valid session stays 401 `unauthenticated`: the client tells "sign in again"
// from "re-verify" by the code alone. Real Postgres, the real ApiModule (so the
// real ProblemFilter), one request per step-up-gated identity route.

type Tokens = Pick<SessionTokens, "accessToken" | "refreshToken" | "csrfToken">;

const session = (t: Tokens) => ({ [ACCESS_COOKIE_NAME]: t.accessToken, [REFRESH_COOKIE_NAME]: t.refreshToken, [CSRF_COOKIE_NAME]: t.csrfToken });
const mutating = (t: Tokens) => ({ cookies: session(t), headers: { [CSRF_HEADER_NAME]: t.csrfToken } });

describe("STORY-018 · step-up refusals are step_up_required Problem Details", () => {
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
  /** A signed-in session; `fresh` false means its last strong auth is long past the step-up window. */
  async function signIn(userId: string, fresh = true): Promise<Tokens> {
    // The token itself is minted NOW either way (a token minted in the past would simply be expired, and the 401 would
    // prove nothing about step-up); only the session's recorded strong authentication is aged.
    const tokens = await sessions.createSession(userId, new Date(), "email_otp");
    if (!fresh) {
      const sid = JSON.parse(Buffer.from(tokens.accessToken.split(".")[1]!, "base64url").toString("utf8")).sid as string;
      await db.query(`UPDATE sessions SET last_strong_auth_at = now() - interval '1 hour' WHERE id = $1`, [sid]);
    }
    return tokens;
  }

  interface Route {
    readonly name: string;
    readonly method: "POST" | "DELETE";
    readonly url: (ids: { passkeyId: string }) => string;
    readonly payload?: Record<string, unknown>;
  }
  // Every identity route the spec marks with the step-up arrow (api-specification.md §3). The OAuth callback and
  // ownership transfer are pinned in identity-oauth-proves-email.spec.ts and ownership-transfer.spec.ts.
  const ROUTES: readonly Route[] = [
    { name: "passkey add (options)", method: "POST", url: () => "/me/passkeys/options", payload: {} },
    {
      name: "passkey add (verify)",
      method: "POST",
      url: () => "/me/passkeys/verify",
      payload: { ceremony_id: "0192f8a0-0000-7000-8000-000000000001", response: { id: "x", rawId: "x", type: "public-key", clientExtensionResults: {}, response: {} } },
    },
    { name: "passkey revoke", method: "DELETE", url: ({ passkeyId }) => `/me/passkeys/${passkeyId}` },
    { name: "OAuth link (start)", method: "POST", url: () => "/auth/oauth/google/link/start" },
    { name: "OAuth unlink", method: "DELETE", url: () => "/me/oauth/google" },
    { name: "sign out other sessions", method: "POST", url: () => "/me/sessions/revoke-others" },
  ];

  const call = (route: Route, ids: { passkeyId: string }, tokens?: Tokens) =>
    app.inject({
      method: route.method,
      url: apiUrl(route.url(ids)),
      ...(route.payload !== undefined ? { payload: route.payload } : {}),
      ...(tokens ? mutating(tokens) : {}),
    });

  describe.each(ROUTES)("$name", (route) => {
    it(`STORY-018 · ${route.name}: a stale step-up is 401 step_up_required naming webauthn and email_otp`, async () => {
      const uid = await user(`stale-${randomUUID().slice(0, 8)}@example.com`);
      const passkeyId = await passkey(uid);
      const res = await call(route, { passkeyId }, await signIn(uid, false));

      expect(res.statusCode, res.body).toBe(401);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      const body = res.json();
      expect(body.error.code).toBe("step_up_required");
      expect(body.title).toBe("Step Up Required");
      expect(body.error.details).toEqual({ methods: ["webauthn", "email_otp"] });
    });

    it(`STORY-018 · ${route.name}: a session that never stepped up is 401 step_up_required`, async () => {
      const uid = await user(`never-${randomUUID().slice(0, 8)}@example.com`);
      const passkeyId = await passkey(uid);
      const plain = await sessions.createSession(uid); // no strong-auth method recorded
      const res = await call(route, { passkeyId }, plain);

      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error.code).toBe("step_up_required");
    });

    it(`STORY-018 · ${route.name}: no session at all is 401 unauthenticated, not step_up_required`, async () => {
      const res = await call(route, { passkeyId: randomUUID() });

      expect(res.statusCode, res.body).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe("unauthenticated");
      expect(body.error.details).toBeUndefined();
    });

    it(`STORY-018 · ${route.name}: a garbage access token is 401 unauthenticated`, async () => {
      const uid = await user(`junk-${randomUUID().slice(0, 8)}@example.com`);
      const passkeyId = await passkey(uid);
      const good = await signIn(uid);
      const res = await call(route, { passkeyId }, { ...good, accessToken: "not.a.jwt" });

      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error.code).toBe("unauthenticated");
    });

    it(`STORY-018 · ${route.name}: a revoked session is 401 unauthenticated even though its step-up is stale`, async () => {
      const uid = await user(`revoked-${randomUUID().slice(0, 8)}@example.com`);
      const passkeyId = await passkey(uid);
      const stale = await signIn(uid, false);
      const sid = JSON.parse(Buffer.from(stale.accessToken.split(".")[1]!, "base64url").toString("utf8")).sid as string;
      await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1`, [sid]);
      const res = await call(route, { passkeyId }, stale);

      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error.code).toBe("unauthenticated");
    });
  });
});
