import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { DbModule } from "../../src/db/db.module.js";
import { IdentityModule } from "../../src/modules/identity/identity.module.js";
import { IdentityService } from "../../src/modules/identity/identity.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { AuthGuard } from "../../src/api/guards/auth.guard.js";
import { ProblemFilter } from "../../src/api/filters/problem.filter.js";
import { ApiModule } from "../../src/api/api.module.js";
import { ResponseEnvelopeInterceptor } from "../../src/api/interceptors/response-envelope.interceptor.js";
import { configureApp } from "../../src/api/configure-app.js";
import { apiUrl } from "../support/api-url.js";
import { eachRequestFromItsOwnClient } from "../support/distinct-source.js";
import { dataOf } from "../support/envelope.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, REFRESH_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../support/test-valkey.js";

// STORY-014 — real Postgres (testcontainers, testing-strategy.md §1: never
// mock the database). @simplewebauthn/server's verify* functions ARE
// mocked: this story's own Technical Notes forbid hand-verifying a
// ceremony, so these tests exercise OUR orchestration (challenge lifecycle,
// persistence, sign-counter policy, ownership, RP-ID/origin threading) —
// the library's own cryptographic correctness is that package's test
// suite's job, not ours. generateRegistrationOptions/
// generateAuthenticationOptions run for real (no verification inside them).
//
// STORY-017 — every call site that used to carry `Bearer ${token}` now
// captures Set-Cookie from /auth/passkey/verify and replays the
// __Host-nominara-access cookie (plus, for mutating requests, the CSRF
// double-submit cookie/header pair) instead.
//
// STORY-173 — registration is no longer anonymous. Every credential here is
// added from a SIGNED-IN session that has stepped up, because that is the only
// way a passkey can be added (POST /me/passkeys/{options,verify}); the helpers
// below seed an account whose address is proved and open such a session. The
// takeover and pre-hijack cases, uniform-response properties and step-up edges
// live in identity-passkey-registration-proves-email.spec.ts.
vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>("@simplewebauthn/server");
  return { ...actual, verifyRegistrationResponse: vi.fn(), verifyAuthenticationResponse: vi.fn() };
});

const verifyRegistrationMock = verifyRegistrationResponse as unknown as Mock;
const verifyAuthenticationMock = verifyAuthenticationResponse as unknown as Mock;

// STORY-173 — revoking a passkey needs a fresh step-up; the race below drives the service directly.
const FRESH_STEP_UP = { lastStrongAuthAt: new Date(), lastStrongAuthMethod: "email_otp" } as const;

interface AuthCookies {
  access: string;
  refresh: string;
  csrf: string;
}

function extractAuthCookies(res: { cookies: Array<{ name: string; value: string }> }): AuthCookies {
  const byName = new Map(res.cookies.map((c) => [c.name, c.value]));
  const access = byName.get(ACCESS_COOKIE_NAME);
  const refresh = byName.get(REFRESH_COOKIE_NAME);
  const csrf = byName.get(CSRF_COOKIE_NAME);
  if (!access || !refresh || !csrf) {
    throw new Error("expected all three auth cookies to be set");
  }
  return { access, refresh, csrf };
}

function sessionCookieHeader(cookies: AuthCookies): Record<string, string> {
  return { [ACCESS_COOKIE_NAME]: cookies.access };
}

function mutatingHeaders(cookies: AuthCookies): { headers: Record<string, string>; cookies: Record<string, string> } {
  return {
    headers: { [CSRF_HEADER_NAME]: cookies.csrf },
    cookies: { [ACCESS_COOKIE_NAME]: cookies.access, [CSRF_COOKIE_NAME]: cookies.csrf },
  };
}

function mockRegistration(credentialIdB64url: string, counter = 0): void {
  verifyRegistrationMock.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: credentialIdB64url, publicKey: new Uint8Array([1, 2, 3, 4]), counter },
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
}

function mockAssertion(newCounter: number): void {
  verifyAuthenticationMock.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter, credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
}

function credentialResponse(credentialIdB64url: string) {
  return {
    id: credentialIdB64url,
    rawId: credentialIdB64url,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: { clientDataJSON: "x", attestationObject: "y", authenticatorData: "z", signature: "s" },
  };
}

// A test credential "id" is just a label, base64url-encoded so it round-trips
// through the service's Buffer.from(id, "base64url") the same way a real
// authenticator's raw credential id would. Using bare literals like "cred-a"
// directly as base64url is unsafe — short, near-identical ASCII strings can
// decode to colliding byte sequences once the leftover bits of a partial
// 4-character group are discarded.
function credId(label: string): string {
  return Buffer.from(label, "utf8").toString("base64url");
}

function decodeClaims(token: string): { sub: string; exp: number } {
  const [, payloadB64url] = token.split(".");
  return JSON.parse(Buffer.from(payloadB64url!, "base64url").toString("utf8"));
}

describe("STORY-014 · passkey registration and assertion", () => {
  let container: StartedPostgreSqlContainer;
  let app: NestFastifyApplication;
  let db: Client;
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
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";
    // STORY-021 — DbModule's PG_POOL factory now calls loadEnv(), which
    // requires this even though this file never touches workspace DEKs.
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
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

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    verifyRegistrationMock.mockReset();
    verifyAuthenticationMock.mockReset();
    mockRegistration("default-should-be-overridden");
    mockAssertion(1);

    const moduleRef = await Test.createTestingModule({
      imports: [DbModule, IdentityModule],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        // STORY-117 — this app is deliberately partial (no ApiModule), and
        // until now it also had no envelope, so every assertion here read a
        // body shape production has not sent since STORY-024 T10. `dataOf`
        // tolerates both, which is exactly why nobody noticed. Registering
        // the real interceptor makes these tests assert what a client
        // actually receives — including `/me/passkeys`, which is a paginated
        // list as of this story and whose Page must be split, not serialized.
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    // STORY-025 T18 — §12's per-IP auth bucket is real now, and this suite
    // drives dozens of /auth/* requests. See the helper for what that
    // trades away and where it is covered instead.
    eachRequestFromItsOwnClient(app);
  });

  afterEach(async () => {
    await app.close();
    await db.end();
  });

  // ---- helpers ----------------------------------------------------------

  // Seeds (once) an account whose address is proved, opens a session as if by a
  // fresh email one-time code, and adds the credential through the real
  // authenticated routes. Each call is a new session for the same account, so
  // a second call for the same email adds a second credential.
  async function signedInSession(email: string): Promise<{ cookies: AuthCookies; sub: string }> {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, status, email_verified_at) VALUES ($1, 'active', now())
       ON CONFLICT (email) WHERE deleted_at IS NULL DO UPDATE SET email = users.email RETURNING id`,
      [email],
    );
    const sub = user.rows[0]!.id;
    const tokens = await app.get(SessionService).createSession(sub, new Date(), "email_otp");
    return { cookies: { access: tokens.accessToken, refresh: tokens.refreshToken, csrf: tokens.csrfToken }, sub };
  }

  async function beginRegistration(cookies: AuthCookies): Promise<string> {
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/me/passkeys/options"),
      payload: {},
      ...mutatingHeaders(cookies),
    });
    expect(optionsRes.statusCode).toBe(201);
    return dataOf<{ ceremony_id: string }>(optionsRes).ceremony_id;
  }

  function finishRegistration(cookies: AuthCookies, ceremonyId: string, credentialIdB64url: string, counter = 0) {
    mockRegistration(credentialIdB64url, counter);
    return app.inject({
      method: "POST",
      url: apiUrl("/me/passkeys/verify"),
      payload: { ceremony_id: ceremonyId, response: credentialResponse(credentialIdB64url) },
      ...mutatingHeaders(cookies),
    });
  }

  async function registerPasskey(
    email: string,
    credentialIdB64url: string,
    counter = 0,
  ): Promise<{ cookies: AuthCookies; sub: string }> {
    const { cookies, sub } = await signedInSession(email);
    const ceremonyId = await beginRegistration(cookies);
    const verifyRes = await finishRegistration(cookies, ceremonyId, credentialIdB64url, counter);
    expect(verifyRes.statusCode).toBe(200);
    // Proves the service threads the CURRENT env config into the library
    // call, rather than a stale or hardcoded value (Test Scenario 7
    // honesty, post-review).
    expect(verifyRegistrationMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRPID: process.env.WEBAUTHN_RP_ID, expectedOrigin: process.env.WEBAUTHN_ORIGIN }),
    );
    return { cookies, sub };
  }

  async function assertPasskey(credentialIdB64url: string, reportedCounter: number) {
    const optionsRes = await app.inject({ method: "POST", url: apiUrl("/auth/passkey/options"), payload: { purpose: "assertion" } });
    const ceremonyId = dataOf<{ ceremony_id: string }>(optionsRes).ceremony_id;
    mockAssertion(reportedCounter);
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: ceremonyId, response: credentialResponse(credentialIdB64url) },
    });
    // Same config-wiring proof as registerPasskey, for the assertion path.
    expect(verifyAuthenticationMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRPID: process.env.WEBAUTHN_RP_ID, expectedOrigin: process.env.WEBAUTHN_ORIGIN }),
    );
    return res;
  }

  // ---- scenarios ----------------------------------------------------------

  it("STORY-014 · scenario 1 — register and sign in: credential stored with its public key", async () => {
    const { sub } = await registerPasskey("alice@example.com", credId("cred-1"), 0);

    const row = await db.query("SELECT public_key, sign_count FROM user_credentials WHERE credential_id = $1", [
      Buffer.from(credId("cred-1"), "base64url"),
    ]);
    expect(row.rows[0].public_key).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(Number(row.rows[0].sign_count)).toBe(0);

    const assertRes = await assertPasskey(credId("cred-1"), 1);
    expect(assertRes.statusCode).toBe(200);
    expect(decodeClaims(extractAuthCookies(assertRes).access).sub).toBe(sub);
  });

  // STORY-173 — this scenario used to register the second credential with NO
  // session, by naming the same address anonymously. That is the account
  // takeover (anyone knowing an address could attach their own passkey to it
  // and receive a session), so the old behaviour is now asserted REFUSED, and
  // the second credential is added the only way it can be: from the signed-in
  // account, after step-up.
  it("STORY-014 · scenario 2 — register a second credential: both usable (and never anonymously)", async () => {
    const { cookies } = await registerPasskey("bob@example.com", credId("cred-a"), 0);

    const anonymous = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email: "bob@example.com" },
    });
    expect(anonymous.statusCode).toBe(400);
    const none = await app.inject({ method: "POST", url: apiUrl("/me/passkeys/options"), payload: {} });
    expect(none.statusCode).toBe(401);

    const ceremonyId = await beginRegistration(cookies);
    const verifyRes = await finishRegistration(cookies, ceremonyId, credId("cred-b"), 0);
    expect(verifyRes.statusCode).toBe(200);

    const first = await assertPasskey(credId("cred-a"), 1);
    const second = await assertPasskey(credId("cred-b"), 1);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it("STORY-014 · scenario 3 — replaying a used challenge is rejected", async () => {
    const { cookies } = await signedInSession("carol@example.com");
    const ceremonyId = await beginRegistration(cookies);

    const first = await finishRegistration(cookies, ceremonyId, credId("cred-carol"), 0);
    expect(first.statusCode).toBe(200);

    const replay = await finishRegistration(cookies, ceremonyId, credId("cred-carol"), 0);
    expect(replay.statusCode).toBe(400);
  });

  it("STORY-014 · scenario 4 — a lower sign counter is rejected as a clone signal", async () => {
    await registerPasskey("dave@example.com", credId("cred-dave"), 5);

    const lower = await assertPasskey(credId("cred-dave"), 3);
    expect(lower.statusCode).toBe(403);

    const row = await db.query("SELECT sign_count FROM user_credentials WHERE credential_id = $1", [
      Buffer.from(credId("cred-dave"), "base64url"),
    ]);
    expect(Number(row.rows[0].sign_count)).toBe(5);
  });

  it("STORY-014 · scenario 5 — a counter of zero from an always-zero authenticator is accepted", async () => {
    await registerPasskey("erin@example.com", credId("cred-erin"), 0);

    const res = await assertPasskey(credId("cred-erin"), 0);
    expect(res.statusCode).toBe(200);

    const row = await db.query("SELECT sign_count FROM user_credentials WHERE credential_id = $1", [
      Buffer.from(credId("cred-erin"), "base64url"),
    ]);
    expect(Number(row.rows[0].sign_count)).toBe(0);
  });

  it("STORY-014 · scenario 6 — revoking the only credential with no alternative is refused", async () => {
    const { cookies } = await registerPasskey("frank@example.com", credId("cred-frank"), 0);

    const listRes = await app.inject({
      method: "GET",
      url: apiUrl("/me/passkeys"),
      cookies: sessionCookieHeader(cookies),
    });
    const { id } = dataOf<{ id: string }[]>(listRes)[0]!;

    const revokeRes = await app.inject({
      method: "DELETE",
      url: apiUrl(`/me/passkeys/${id}`),
      ...mutatingHeaders(cookies),
    });
    expect(revokeRes.statusCode).toBe(409);
  });

  it("STORY-014 · scenario 7 — replaying a local credential against another environment's RP ID is rejected", async () => {
    process.env.WEBAUTHN_RP_ID = "env-a.example.com";
    process.env.WEBAUTHN_ORIGIN = "https://env-a.example.com";
    await registerPasskey("grace@example.com", credId("cred-grace"), 0);

    // Simulates the real library's own RP-ID-hash check: it would only
    // verify a genuine env-a-minted assertion, never one presented while
    // configured for a different environment.
    verifyAuthenticationMock.mockImplementation(async (opts: { expectedRPID: string }) => {
      if (opts.expectedRPID !== "env-a.example.com") {
        throw new Error("RP ID hash mismatch");
      }
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    });

    process.env.WEBAUTHN_RP_ID = "env-b.example.com";
    process.env.WEBAUTHN_ORIGIN = "https://env-b.example.com";
    const optionsRes = await app.inject({ method: "POST", url: apiUrl("/auth/passkey/options"), payload: { purpose: "assertion" } });
    const ceremonyId = dataOf<{ ceremony_id: string }>(optionsRes).ceremony_id;
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: ceremonyId, response: credentialResponse(credId("cred-grace")) },
    });
    expect(res.statusCode).toBe(400);
    // Proves the service actually threaded the CURRENT (env-b) config into
    // the library call, rather than the mock's own reimplementation of the
    // RP-ID check happening to reject some other, unrelated hardcoded or
    // stale value.
    expect(verifyAuthenticationMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRPID: "env-b.example.com", expectedOrigin: "https://env-b.example.com" }),
    );
  });

  it("STORY-014 · list never exposes public_key, credential_id, or sign_count", async () => {
    const { cookies } = await registerPasskey("heidi@example.com", credId("cred-heidi"), 0);

    const listRes = await app.inject({
      method: "GET",
      url: apiUrl("/me/passkeys"),
      cookies: sessionCookieHeader(cookies),
    });
    expect(listRes.statusCode).toBe(200);
    const item = dataOf<Record<string, unknown>[]>(listRes)[0]!;
    expect(Object.keys(item).sort()).toEqual(
      ["id", "device_label", "authenticator_attachment", "transports", "last_used_at", "created_at"].sort(),
    );
  });

  // STORY-014 AC3 — resident keys, UV preferred, attachment recorded. The
  // options are what the browser is told; the column is what later policy reads.
  it("STORY-014 · registration options require a resident key and prefer user verification", async () => {
    const { cookies } = await signedInSession("judy@example.com");
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/me/passkeys/options"),
      payload: {},
      ...mutatingHeaders(cookies),
    });
    expect(res.statusCode).toBe(201);
    const { options } = dataOf<{ options: { authenticatorSelection?: Record<string, unknown> } }>(res);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "preferred" });
    // Resident key "required" implies the legacy boolean the library derives.
    expect(options.authenticatorSelection?.requireResidentKey).toBe(true);
  });

  it("STORY-014 · the authenticator attachment the client reports is stored, and absent is NULL not a guess", async () => {
    const { cookies } = await signedInSession("ken@example.com");
    for (const [label, attachment] of [
      ["cred-platform", "platform"],
      ["cred-roaming", "cross-platform"],
      ["cred-unreported", undefined],
    ] as const) {
      const ceremonyId = await beginRegistration(cookies);
      mockRegistration(credId(label), 0);
      const res = await app.inject({
        method: "POST",
        url: apiUrl("/me/passkeys/verify"),
        payload: {
          ceremony_id: ceremonyId,
          response: {
            ...credentialResponse(credId(label)),
            ...(attachment === undefined ? {} : { authenticatorAttachment: attachment }),
          },
        },
        ...mutatingHeaders(cookies),
      });
      expect(res.statusCode).toBe(200);
      const row = await db.query<{ authenticator_attachment: string | null }>(
        "SELECT authenticator_attachment FROM user_credentials WHERE credential_id = $1",
        [Buffer.from(credId(label), "base64url")],
      );
      expect(row.rows[0]!.authenticator_attachment).toBe(attachment ?? null);
    }
  });

  it("STORY-014 · renaming a credential updates its device label", async () => {
    const { cookies } = await registerPasskey("ivan@example.com", credId("cred-ivan"), 0);
    const { id } = dataOf<{ id: string }[]>(
      await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookies) }),
    )[0]!;

    const renameRes = await app.inject({
      method: "PATCH",
      url: apiUrl(`/me/passkeys/${id}`),
      payload: { device_label: "My Yubikey" },
      ...mutatingHeaders(cookies),
    });
    expect(renameRes.statusCode).toBe(200);

    const after = dataOf<{ device_label: string }[]>(
      await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookies) }),
    )[0]!;
    expect(after.device_label).toBe("My Yubikey");
  });

  it("STORY-014 · revoking a non-last credential succeeds", async () => {
    const { cookies, sub } = await registerPasskey("judy@example.com", credId("cred-judy-1"), 0);
    const ceremonyId = await beginRegistration(cookies);
    expect((await finishRegistration(cookies, ceremonyId, credId("cred-judy-2"), 0)).statusCode).toBe(200);

    const list = dataOf<{ id: string }[]>(
      await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookies) }),
    );
    expect(list).toHaveLength(2);

    const revokeRes = await app.inject({
      method: "DELETE",
      url: apiUrl(`/me/passkeys/${list[0]!.id}`),
      ...mutatingHeaders(cookies),
    });
    expect(revokeRes.statusCode).toBe(200);

    const remaining = await db.query(
      "SELECT count(*)::int AS count FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL",
      [sub],
    );
    expect(remaining.rows[0].count).toBe(1);
  });

  it("STORY-014 · ownership isolation — one user cannot rename or revoke another user's credential", async () => {
    const { cookies: cookiesA } = await registerPasskey("kim@example.com", credId("cred-kim"), 0);
    await registerPasskey("leo@example.com", credId("cred-leo"), 0);
    const { cookies: cookiesB } = await registerPasskey("leo2@example.com", credId("cred-leo2"), 0);

    const kimCredentialId = dataOf<{ id: string }[]>(
      await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookiesA) }),
    )[0]!.id;

    const renameRes = await app.inject({
      method: "PATCH",
      url: apiUrl(`/me/passkeys/${kimCredentialId}`),
      payload: { device_label: "Hijacked" },
      ...mutatingHeaders(cookiesB),
    });
    expect(renameRes.statusCode).toBe(403);

    const revokeRes = await app.inject({
      method: "DELETE",
      url: apiUrl(`/me/passkeys/${kimCredentialId}`),
      ...mutatingHeaders(cookiesB),
    });
    expect(revokeRes.statusCode).toBe(403);
  });

  it("STORY-014 · an expired, unconsumed challenge is rejected", async () => {
    const { cookies } = await signedInSession("mia@example.com");
    const ceremonyId = await beginRegistration(cookies);
    await db.query("UPDATE webauthn_challenges SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      ceremonyId,
    ]);

    const res = await finishRegistration(cookies, ceremonyId, credId("cred-mia"), 0);
    expect(res.statusCode).toBe(400);
  });

  it("STORY-014 · a concurrent verify race on the same ceremony has exactly one winner", async () => {
    const { cookies } = await signedInSession("nate@example.com");
    const ceremonyId = await beginRegistration(cookies);
    mockRegistration(credId("cred-nate"), 0);
    const body = { ceremony_id: ceremonyId, response: credentialResponse(credId("cred-nate")) };
    const send = () =>
      app.inject({ method: "POST", url: apiUrl("/me/passkeys/verify"), payload: body, ...mutatingHeaders(cookies) });

    const [first, second] = await Promise.all([send(), send()]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 400]);
  });

  // SHOULD-FIX (post-review) — revoke-guard TOCTOU race. The original
  // implementation locked only the target row and ran an UNLOCKED
  // count(*) over the user's other active credentials; two concurrent
  // DELETEs against a user's last two distinct credentials could each see
  // "1 remaining" (the other, not-yet-committed) and both succeed, leaving
  // zero — the exact self-lockout AC6 forbids. This must never happen.
  //
  // A plain Promise.all of two HTTP DELETEs does not reliably open this
  // race locally: against local Postgres, one request's whole
  // BEGIN..COMMIT sequence routinely finishes before the other's queries
  // are even dispatched, so the unlocked count(*) never actually observes
  // the other transaction's uncommitted state. To make this a genuine
  // regression test — one that actually fails against the pre-fix
  // implementation — every active-credential-set lock query run by either
  // transaction is delayed by a fixed amount, real Postgres and real
  // locking untouched. This widens the window without stubbing any query
  // result, so the fixed implementation's row lock (which blocks the
  // second transaction's identical query until the first commits) is
  // exercised for real.
  it("STORY-014 · a concurrent revoke race on a user's last two credentials has exactly one winner, never zero remaining", async () => {
    const { cookies, sub } = await registerPasskey("tina@example.com", credId("cred-tina-1"), 0);
    const secondCeremony = await beginRegistration(cookies);
    expect((await finishRegistration(cookies, secondCeremony, credId("cred-tina-2"), 0)).statusCode).toBe(200);

    const list = dataOf<{ id: string }[]>(
      await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookies) }),
    );
    expect(list).toHaveLength(2);

    // Driven directly against IdentityService (real Postgres, real
    // transactions, the exact production revokePasskey implementation) —
    // not through app.inject(). light-my-request's fake-socket dispatch
    // does not reliably interleave two concurrent injects at the
    // Postgres-statement level on this fast local instance, so a
    // Promise.all of two HTTP calls never actually opens the race window
    // (verified: it still passes against the pre-fix implementation).
    // Every SELECT ... FOR UPDATE lock query is additionally delayed so
    // both transactions' count/decision logic genuinely overlaps — real
    // locking and real query results are untouched, only the timing is
    // controlled, so the fixed implementation's row lock (which blocks the
    // second transaction's identical query until the first commits) is
    // exercised for real.
    const service = app.get(IdentityService);
    const rawQuery = (Client.prototype as unknown as { query: (...args: unknown[]) => unknown }).query;
    // A barrier, not a fixed timer: whichever lock query resolves first
    // waits for the other to resolve too (up to a short cap) before either
    // continues past its own lock query. Against the buggy implementation
    // both queries lock disjoint rows and resolve immediately, so both
    // arrive at the barrier and are released together — reopening the
    // exact window the count(*) race depends on. Against the fixed
    // implementation the second query is genuinely blocked at the Postgres
    // level until the first transaction commits, so it never reaches this
    // barrier until then; the cap prevents the first from waiting forever
    // for an arrival that can't happen until it itself proceeds.
    let arrivals = 0;
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const querySpy = vi
      .spyOn(Client.prototype as unknown as { query: (...args: unknown[]) => unknown }, "query")
      .mockImplementation(function (this: Client, ...args: unknown[]) {
        const text = typeof args[0] === "string" ? args[0] : undefined;
        const result = rawQuery.apply(this, args as never);
        if (text?.includes("FOR UPDATE") && result instanceof Promise) {
          return result.then(async (value) => {
            arrivals += 1;
            if (arrivals >= 2) releaseBarrier();
            await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 50))]);
            return value;
          });
        }
        return result;
      });

    let outcomes: PromiseSettledResult<void>[];
    try {
      outcomes = await Promise.allSettled([
        service.revokePasskey(sub, list[0]!.id, FRESH_STEP_UP, randomUUID()),
        service.revokePasskey(sub, list[1]!.id, FRESH_STEP_UP, randomUUID()),
      ]);
    } finally {
      querySpy.mockRestore();
    }

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const remaining = await db.query(
      "SELECT count(*)::int AS count FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL",
      [sub],
    );
    expect(remaining.rows[0].count).toBe(1);
  });

  it("STORY-014 · a malformed verify body is rejected with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: "not-a-uuid" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("STORY-014 · an always-zero credential transitioning to a nonzero counter is accepted, then held to it", async () => {
    await registerPasskey("olga@example.com", credId("cred-olga"), 0);

    const zeroAgain = await assertPasskey(credId("cred-olga"), 0);
    expect(zeroAgain.statusCode).toBe(200);

    const transition = await assertPasskey(credId("cred-olga"), 7);
    expect(transition.statusCode).toBe(200);
    const afterTransition = await db.query("SELECT sign_count FROM user_credentials WHERE credential_id = $1", [
      Buffer.from(credId("cred-olga"), "base64url"),
    ]);
    expect(Number(afterTransition.rows[0].sign_count)).toBe(7);

    const backToZero = await assertPasskey(credId("cred-olga"), 0);
    expect(backToZero.statusCode).toBe(403);
  });

  // BLOCKING #2 (post-review fix) — the stripped test module above
  // (`Test.createTestingModule({ imports: [DbModule, IdentityModule], ... })`)
  // omits TenantContextInterceptor entirely, so every scenario above passed
  // even while /me/passkeys 500'd on every real request: WorkspaceGuard is
  // still a no-op stub (STORY-018) that never populates req.tenant, and
  // TenantContextInterceptor fails closed on any non-@Public() route with no
  // req.tenant. This block boots the REAL, deployed ApiModule (every guard
  // and interceptor api.module.ts actually registers) and proves
  // @SkipTenantContext() on the three /me/passkeys handlers is what makes
  // them reachable at all.
  describe("STORY-014 · /me/passkeys through the real, deployed ApiModule", () => {
    let apiApp: NestFastifyApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
      apiApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      await configureApp(apiApp);
      await apiApp.init();
      await apiApp.getHttpAdapter().getInstance().ready();
      eachRequestFromItsOwnClient(apiApp);
    });

    afterEach(async () => {
      await apiApp.close();
    });

    // STORY-173 — sessions here come from SessionService (as an OTP sign-in
    // would mint them) and every credential is added through the real
    // authenticated routes of the full ApiModule.
    async function apiSignedIn(email: string): Promise<AuthCookies> {
      const user = await db.query<{ id: string }>(
        `INSERT INTO users (email, status, email_verified_at) VALUES ($1, 'active', now())
         ON CONFLICT (email) WHERE deleted_at IS NULL DO UPDATE SET email = users.email RETURNING id`,
        [email],
      );
      const tokens = await apiApp.get(SessionService).createSession(user.rows[0]!.id, new Date(), "email_otp");
      return { access: tokens.accessToken, refresh: tokens.refreshToken, csrf: tokens.csrfToken };
    }

    async function apiAddPasskey(cookies: AuthCookies, label: string) {
      const optionsRes = await apiApp.inject({
        method: "POST",
        url: apiUrl("/me/passkeys/options"),
        payload: {},
        ...mutatingHeaders(cookies),
      });
      expect(optionsRes.statusCode).toBe(201);
      mockRegistration(credId(label), 0);
      return apiApp.inject({
        method: "POST",
        url: apiUrl("/me/passkeys/verify"),
        payload: { ceremony_id: dataOf<{ ceremony_id: string }>(optionsRes).ceremony_id, response: credentialResponse(credId(label)) },
        ...mutatingHeaders(cookies),
      });
    }

    it("registers a passkey and then lists/renames/revokes it end to end through the full guard/interceptor chain", async () => {
      const cookies = await apiSignedIn("sam@example.com");
      expect((await apiAddPasskey(cookies, "cred-sam")).statusCode).toBe(200);
      // Register a second credential so revoking the first isn't refused as
      // the last-remaining-credential case (unrelated to this test's point).
      // Asserted rather than assumed: when this silently stopped working the
      // failure surfaced further down as "expected 2 credentials, got 1".
      expect((await apiAddPasskey(cookies, "cred-sam-2")).statusCode).toBe(200);

      const listRes = await apiApp.inject({
        method: "GET",
        url: apiUrl("/me/passkeys"),
        cookies: sessionCookieHeader(cookies),
      });
      expect(listRes.statusCode).toBe(200);
      const credentials = dataOf<{ id: string }[]>(listRes);
      expect(credentials).toHaveLength(2);

      const renameRes = await apiApp.inject({
        method: "PATCH",
        url: apiUrl(`/me/passkeys/${credentials[0]!.id}`),
        payload: { device_label: "Sam's Yubikey" },
        ...mutatingHeaders(cookies),
      });
      expect(renameRes.statusCode).toBe(200);

      const revokeRes = await apiApp.inject({
        method: "DELETE",
        url: apiUrl(`/me/passkeys/${credentials[0]!.id}`),
        ...mutatingHeaders(cookies),
      });
      expect(revokeRes.statusCode).toBe(200);
    });

    it("rejects /me/passkeys with no session cookie (AuthGuard still runs — this route is not @Public())", async () => {
      const res = await apiApp.inject({ method: "GET", url: apiUrl("/me/passkeys") });
      expect(res.statusCode).toBe(401);
      const add = await apiApp.inject({ method: "POST", url: apiUrl("/me/passkeys/options"), payload: {} });
      expect(add.statusCode).toBe(401);
    });

    it("STORY-014 · GET /me/passkeys never includes another user's credentials", async () => {
      const cookiesA = await apiSignedIn("paul@example.com");
      expect((await apiAddPasskey(cookiesA, "cred-paul")).statusCode).toBe(200);
      const cookiesQuinn = await apiSignedIn("quinn@example.com");
      expect((await apiAddPasskey(cookiesQuinn, "cred-quinn")).statusCode).toBe(200);
      const cookiesB = await apiSignedIn("quinn2@example.com");
      expect((await apiAddPasskey(cookiesB, "cred-quinn2")).statusCode).toBe(200);

      const listA = dataOf<{ id: string }[]>(
        await apiApp.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookiesA) }),
      );
      const listB = dataOf<{ id: string }[]>(
        await apiApp.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookiesB) }),
      );

      expect(listA).toHaveLength(1);
      expect(listB).toHaveLength(1);
      expect(listA.map((c: { id: string }) => c.id)).not.toEqual(
        expect.arrayContaining(listB.map((c: { id: string }) => c.id)),
      );
      expect(listB.map((c: { id: string }) => c.id)).not.toEqual(
        expect.arrayContaining(listA.map((c: { id: string }) => c.id)),
      );
    });

    it("STORY-014 · rejects an unknown key on a real production contract (passkeyRenameRequestSchema) through the real endpoint", async () => {
      const cookies = await apiSignedIn("rex@example.com");
      expect((await apiAddPasskey(cookies, "cred-rex")).statusCode).toBe(200);
      const { id } = dataOf<{ id: string }[]>(
        await apiApp.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookies) }),
      )[0]!;

      const res = await apiApp.inject({
        method: "PATCH",
        url: apiUrl(`/me/passkeys/${id}`),
        payload: { device_label: "My Key", not_a_real_field: "should be rejected" },
        ...mutatingHeaders(cookies),
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
