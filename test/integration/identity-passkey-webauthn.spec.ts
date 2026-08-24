import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { DbModule } from "../../src/db/db.module.js";
import { IdentityModule } from "../../src/modules/identity/identity.module.js";
import { IdentityService } from "../../src/modules/identity/identity.service.js";
import { AuthGuard } from "../../src/api/guards/auth.guard.js";
import { ProblemFilter } from "../../src/api/filters/problem.filter.js";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { apiUrl } from "../support/api-url.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, REFRESH_COOKIE_NAME } from "../../src/lib/auth/cookies.js";

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
vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>("@simplewebauthn/server");
  return { ...actual, verifyRegistrationResponse: vi.fn(), verifyAuthenticationResponse: vi.fn() };
});

const verifyRegistrationMock = verifyRegistrationResponse as unknown as Mock;
const verifyAuthenticationMock = verifyAuthenticationResponse as unknown as Mock;

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
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    await db.end();
  });

  // ---- helpers ----------------------------------------------------------

  async function registerPasskey(
    email: string,
    credentialIdB64url: string,
    counter = 0,
  ): Promise<{ cookies: AuthCookies; sub: string }> {
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email },
    });
    expect(optionsRes.statusCode).toBe(201);
    const ceremonyId = optionsRes.json().ceremony_id;

    mockRegistration(credentialIdB64url, counter);
    const verifyRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: ceremonyId, response: credentialResponse(credentialIdB64url) },
    });
    expect(verifyRes.statusCode).toBe(200);
    // Proves the service threads the CURRENT env config into the library
    // call, rather than a stale or hardcoded value (Test Scenario 7
    // honesty, post-review).
    expect(verifyRegistrationMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRPID: process.env.WEBAUTHN_RP_ID, expectedOrigin: process.env.WEBAUTHN_ORIGIN }),
    );
    const cookies = extractAuthCookies(verifyRes);
    return { cookies, sub: decodeClaims(cookies.access).sub };
  }

  async function assertPasskey(credentialIdB64url: string, reportedCounter: number) {
    const optionsRes = await app.inject({ method: "POST", url: apiUrl("/auth/passkey/options"), payload: { purpose: "assertion" } });
    const ceremonyId = optionsRes.json().ceremony_id;
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

  it("STORY-014 · scenario 2 — register a second credential: both usable", async () => {
    await registerPasskey("bob@example.com", credId("cred-a"), 0);
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email: "bob@example.com" },
    });
    const ceremonyId = optionsRes.json().ceremony_id;
    mockRegistration(credId("cred-b"), 0);
    const verifyRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: ceremonyId, response: credentialResponse(credId("cred-b")) },
    });
    expect(verifyRes.statusCode).toBe(200);

    const first = await assertPasskey(credId("cred-a"), 1);
    const second = await assertPasskey(credId("cred-b"), 1);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it("STORY-014 · scenario 3 — replaying a used challenge is rejected", async () => {
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email: "carol@example.com" },
    });
    const ceremonyId = optionsRes.json().ceremony_id;
    mockRegistration(credId("cred-carol"), 0);
    const body = { ceremony_id: ceremonyId, response: credentialResponse(credId("cred-carol")) };

    const first = await app.inject({ method: "POST", url: apiUrl("/auth/passkey/verify"), payload: body });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({ method: "POST", url: apiUrl("/auth/passkey/verify"), payload: body });
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
    const [{ id }] = listRes.json();

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
    const ceremonyId = optionsRes.json().ceremony_id;
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
    const [item] = listRes.json();
    expect(Object.keys(item).sort()).toEqual(
      ["id", "device_label", "authenticator_attachment", "transports", "last_used_at", "created_at"].sort(),
    );
  });

  it("STORY-014 · renaming a credential updates its device label", async () => {
    const { cookies } = await registerPasskey("ivan@example.com", credId("cred-ivan"), 0);
    const [{ id }] = (
      await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookies) })
    ).json();

    const renameRes = await app.inject({
      method: "PATCH",
      url: apiUrl(`/me/passkeys/${id}`),
      payload: { device_label: "My Yubikey" },
      ...mutatingHeaders(cookies),
    });
    expect(renameRes.statusCode).toBe(200);

    const [after] = (
      await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookies) })
    ).json();
    expect(after.device_label).toBe("My Yubikey");
  });

  it("STORY-014 · revoking a non-last credential succeeds", async () => {
    const { cookies, sub } = await registerPasskey("judy@example.com", credId("cred-judy-1"), 0);
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email: "judy@example.com" },
    });
    mockRegistration(credId("cred-judy-2"), 0);
    await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: optionsRes.json().ceremony_id, response: credentialResponse(credId("cred-judy-2")) },
    });

    const list = (
      await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookies) })
    ).json();
    expect(list).toHaveLength(2);

    const revokeRes = await app.inject({
      method: "DELETE",
      url: apiUrl(`/me/passkeys/${list[0].id}`),
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
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email: "leo@example.com" },
    });
    mockRegistration(credId("cred-leo"), 0);
    await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: optionsRes.json().ceremony_id, response: credentialResponse(credId("cred-leo")) },
    });
    const { cookies: cookiesB } = await registerPasskey("leo2@example.com", credId("cred-leo2"), 0);

    const [{ id: kimCredentialId }] = (
      await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookiesA) })
    ).json();

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
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email: "mia@example.com" },
    });
    const ceremonyId = optionsRes.json().ceremony_id;
    await db.query("UPDATE webauthn_challenges SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      ceremonyId,
    ]);

    mockRegistration(credId("cred-mia"), 0);
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: ceremonyId, response: credentialResponse(credId("cred-mia")) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("STORY-014 · a concurrent verify race on the same ceremony has exactly one winner", async () => {
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email: "nate@example.com" },
    });
    const ceremonyId = optionsRes.json().ceremony_id;
    mockRegistration(credId("cred-nate"), 0);
    const body = { ceremony_id: ceremonyId, response: credentialResponse(credId("cred-nate")) };

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: apiUrl("/auth/passkey/verify"), payload: body }),
      app.inject({ method: "POST", url: apiUrl("/auth/passkey/verify"), payload: body }),
    ]);

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
    const secondOptionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email: "tina@example.com" },
    });
    mockRegistration(credId("cred-tina-2"), 0);
    await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: secondOptionsRes.json().ceremony_id, response: credentialResponse(credId("cred-tina-2")) },
    });

    const list = (
      await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookies) })
    ).json();
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
        service.revokePasskey(sub, list[0].id),
        service.revokePasskey(sub, list[1].id),
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
    });

    afterEach(async () => {
      await apiApp.close();
    });

    it("registers a passkey and then lists/renames/revokes it end to end through the full guard/interceptor chain", async () => {
      const optionsRes = await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/options"),
        payload: { purpose: "registration", email: "sam@example.com" },
      });
      expect(optionsRes.statusCode).toBe(201);
      const ceremonyId = optionsRes.json().ceremony_id;

      mockRegistration(credId("cred-sam"), 0);
      const verifyRes = await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/verify"),
        payload: { ceremony_id: ceremonyId, response: credentialResponse(credId("cred-sam")) },
      });
      expect(verifyRes.statusCode).toBe(200);
      const cookies = extractAuthCookies(verifyRes);

      // Register a second credential so revoking the first isn't refused as
      // the last-remaining-credential case (unrelated to this test's point).
      const secondOptionsRes = await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/options"),
        payload: { purpose: "registration", email: "sam@example.com" },
      });
      mockRegistration(credId("cred-sam-2"), 0);
      await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/verify"),
        payload: { ceremony_id: secondOptionsRes.json().ceremony_id, response: credentialResponse(credId("cred-sam-2")) },
      });

      const listRes = await apiApp.inject({
        method: "GET",
        url: apiUrl("/me/passkeys"),
        cookies: sessionCookieHeader(cookies),
      });
      expect(listRes.statusCode).toBe(200);
      const credentials = listRes.json();
      expect(credentials).toHaveLength(2);

      const renameRes = await apiApp.inject({
        method: "PATCH",
        url: apiUrl(`/me/passkeys/${credentials[0].id}`),
        payload: { device_label: "Sam's Yubikey" },
        ...mutatingHeaders(cookies),
      });
      expect(renameRes.statusCode).toBe(200);

      const revokeRes = await apiApp.inject({
        method: "DELETE",
        url: apiUrl(`/me/passkeys/${credentials[0].id}`),
        ...mutatingHeaders(cookies),
      });
      expect(revokeRes.statusCode).toBe(200);
    });

    it("rejects /me/passkeys with no session cookie (AuthGuard still runs — this route is not @Public())", async () => {
      const res = await apiApp.inject({ method: "GET", url: apiUrl("/me/passkeys") });
      expect(res.statusCode).toBe(401);
    });

    it("STORY-014 · GET /me/passkeys never includes another user's credentials", async () => {
      const optionsA = await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/options"),
        payload: { purpose: "registration", email: "paul@example.com" },
      });
      mockRegistration(credId("cred-paul"), 0);
      const verifyA = await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/verify"),
        payload: { ceremony_id: optionsA.json().ceremony_id, response: credentialResponse(credId("cred-paul")) },
      });
      const cookiesA = extractAuthCookies(verifyA);

      const optionsQuinn = await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/options"),
        payload: { purpose: "registration", email: "quinn@example.com" },
      });
      mockRegistration(credId("cred-quinn"), 0);
      await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/verify"),
        payload: { ceremony_id: optionsQuinn.json().ceremony_id, response: credentialResponse(credId("cred-quinn")) },
      });

      const optionsB = await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/options"),
        payload: { purpose: "registration", email: "quinn2@example.com" },
      });
      mockRegistration(credId("cred-quinn2"), 0);
      const verifyB = await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/verify"),
        payload: { ceremony_id: optionsB.json().ceremony_id, response: credentialResponse(credId("cred-quinn2")) },
      });
      const cookiesB = extractAuthCookies(verifyB);

      const listA = (
        await apiApp.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookiesA) })
      ).json();
      const listB = (
        await apiApp.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookiesB) })
      ).json();

      expect(listA.map((c: { id: string }) => c.id)).not.toEqual(
        expect.arrayContaining(listB.map((c: { id: string }) => c.id)),
      );
      expect(listB.map((c: { id: string }) => c.id)).not.toEqual(
        expect.arrayContaining(listA.map((c: { id: string }) => c.id)),
      );
    });

    it("STORY-014 · rejects an unknown key on a real production contract (passkeyRenameRequestSchema) through the real endpoint", async () => {
      const optionsRes = await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/options"),
        payload: { purpose: "registration", email: "rex@example.com" },
      });
      mockRegistration(credId("cred-rex"), 0);
      const verifyRes = await apiApp.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/verify"),
        payload: { ceremony_id: optionsRes.json().ceremony_id, response: credentialResponse(credId("cred-rex")) },
      });
      const cookies = extractAuthCookies(verifyRes);
      const [{ id }] = (
        await apiApp.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: sessionCookieHeader(cookies) })
      ).json();

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
