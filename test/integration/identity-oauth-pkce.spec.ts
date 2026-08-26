import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { apiUrl } from "../support/api-url.js";
import { eachRequestFromItsOwnClient } from "../support/distinct-source.js";
import { dataOf } from "../support/envelope.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import {
  OAUTH_CLIENT,
  type OauthAuthorizationUrlInput,
  type OauthClient,
  type OauthExchangeInput,
  type OauthIdentity,
  type OauthPkcePair,
} from "../../src/modules/identity/ports/oauth-client.js";

// STORY-015 — Tasks 5-14. Real Postgres (testcontainers, never mock the
// DB); the only thing mocked is the provider itself, at the OAUTH_CLIENT
// port boundary (same port-plus-fake-adapter precedent as
// src/modules/workspaces/ports/dek-provisioner.ts) — no real network call,
// no mocking of `openid-client` internals.
//
// These tests are written against routes/wiring that do not exist yet
// (oauth.controller.ts/oauth.service.ts/the openid-client adapter/
// src/lib/auth/oauth-state.ts — all later tasks). Every scenario below is
// expected to fail red right now; see the accompanying report for the
// confirmed failure reason per test.
//
// Dangerous area disclosure: this file exercises state-signing/session-
// binding and the provider-subject-as-join-key account-resolution logic —
// second-engineer review required alongside oauth.service.ts.
//
// @simplewebauthn/server's verifyRegistrationResponse is mocked (Task 13's
// "add a passkey to an oauth account" setup) for the same reason
// identity-passkey-webauthn.spec.ts mocks it: hand-verifying a WebAuthn
// ceremony is out of scope here, only OUR persistence/wiring is.
vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>("@simplewebauthn/server");
  return { ...actual, verifyRegistrationResponse: vi.fn() };
});
const verifyRegistrationMock = verifyRegistrationResponse as unknown as Mock;

// Not yet exported by src/lib/auth/cookies.ts. This is the contract
// oauth.controller.ts is expected to add: an httpOnly, __Host-prefixed
// cookie, SameSite=Lax (so it still rides the top-level GET redirect back
// from the provider), set at /start and read back at /callback — hashed
// with oauth-state.ts's hashBinding() and compared against
// oauth_authorization_requests.binding_hash. security-and-tenancy.md §5:
// "state ... bound to the initiating session" — this cookie IS that binding.
const OAUTH_BINDING_COOKIE_NAME = "__Host-nominara-oauth-binding";

const PROVIDERS = ["google", "github", "microsoft"] as const;
const SENTINEL_PROVIDER_ERROR = "PROVIDER_INTERNAL_DETAIL_should_never_reach_the_client_9f3c";

class FakeOauthClient implements OauthClient {
  private readonly exchanges = new Map<string, OauthIdentity>();
  // FIFO pairing: generatePkce() is always called by /start immediately
  // before the matching registerExchange() for that same flow (every test
  // in this file awaits one before calling the other), so a queue
  // correctly binds each issued verifier to the code it was issued for —
  // without this, exchangeCode() ignored codeVerifier entirely and S4's
  // "omit the proof-key verifier" test wasn't a real negative test.
  private readonly verifierQueue: string[] = [];
  private readonly verifiersByCode = new Map<string, string>();

  registerExchange(code: string, identity: OauthIdentity): void {
    this.exchanges.set(code, identity);
    const verifier = this.verifierQueue.shift();
    if (verifier !== undefined) {
      this.verifiersByCode.set(code, verifier);
    }
  }

  async generatePkce(): Promise<OauthPkcePair> {
    const verifier = randomUUID();
    this.verifierQueue.push(verifier);
    return { verifier, challenge: randomUUID() };
  }

  authorizationUrl(input: OauthAuthorizationUrlInput): string {
    const url = new URL(`https://fake-provider.example.com/${input.provider}/authorize`);
    url.searchParams.set("client_id", "fake-client-id");
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", input.state);
    return url.toString();
  }

  async exchangeCode(input: OauthExchangeInput): Promise<OauthIdentity> {
    const identity = this.exchanges.get(input.code);
    if (!identity) {
      throw new Error(`fake provider: no identity registered for code ${input.code}`);
    }
    const expectedVerifier = this.verifiersByCode.get(input.code);
    if (expectedVerifier !== undefined && input.codeVerifier !== expectedVerifier) {
      throw new Error("fake provider: code_verifier does not match the one issued for this code");
    }
    return identity;
  }
}

interface StartResult {
  readonly statusCode: number;
  readonly authorizationUrl?: string | undefined;
  readonly state?: string | undefined;
  readonly bindingCookie?: string | undefined;
  readonly stateExpiresAt?: string | undefined;
}

interface AuthCookies {
  readonly access: string;
  readonly csrf: string;
}

function extractAuthCookies(res: { cookies: Array<{ name: string; value: string }> }): AuthCookies | null {
  const byName = new Map(res.cookies.map((c) => [c.name, c.value]));
  const access = byName.get(ACCESS_COOKIE_NAME);
  const csrf = byName.get(CSRF_COOKIE_NAME);
  if (!access || !csrf) return null;
  return { access, csrf };
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

function decodeClaims(token: string): { sub: string } {
  const [, payloadB64url] = token.split(".");
  return JSON.parse(Buffer.from(payloadB64url!, "base64url").toString("utf8"));
}

// STORY-024 decision D12 — `oauth_failed` is NOT one of api-specification.md
// §2's 28 codes, and `problemErrorSchema.code` is a closed union, so it cannot
// travel as itself. ProblemFilter maps it to `validation_failed` and preserves
// the original condition as `error.details.reason`. OauthFailedException is
// unchanged and still throws `oauth_failed` internally — the mapping is at the
// wire boundary only, which is what AC1 means by "a filter maps it to the wire
// shape". Asserting both halves here keeps the mapping honest: a regression
// that dropped `reason` would still be caught.
function expectOauthFailure(body: unknown): void {
  const error = (body as { error?: { code?: string; details?: { reason?: string } } }).error;
  expect(error?.code).toBe("validation_failed");
  expect(error?.details?.reason).toBe("oauth_failed");
}

describe("STORY-015 · OAuth 2.1 + PKCE for google/github/microsoft", () => {
  let container: StartedPostgreSqlContainer;
  let app: NestFastifyApplication;
  let db: Client;
  let fakeClient: FakeOauthClient;
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

    fakeClient = new FakeOauthClient();
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(OAUTH_CLIENT)
      .useValue(fakeClient)
      .compile();
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

  // ---- helpers -------------------------------------------------------------

  async function startFlow(
    provider: string,
    opts: { purpose?: "login" | "link"; cookies?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<StartResult> {
    const path = opts.purpose === "link" ? `/auth/oauth/${provider}/link/start` : `/auth/oauth/${provider}/start`;
    const res = await app.inject({
      method: "POST",
      url: apiUrl(path),
      ...(opts.cookies ? { cookies: opts.cookies } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    if (res.statusCode >= 400) {
      return { statusCode: res.statusCode };
    }
    // STORY-024 T10 — the success body is enveloped; the resource is under `data`.
    const body = dataOf<{ authorization_url: string; state_expires_at: string }>(res);
    const url = new URL(body.authorization_url);
    const bindingCookie = res.cookies.find((c) => c.name === OAUTH_BINDING_COOKIE_NAME)?.value;
    return {
      statusCode: res.statusCode,
      authorizationUrl: body.authorization_url,
      state: url.searchParams.get("state") ?? undefined,
      bindingCookie,
      stateExpiresAt: body.state_expires_at,
    };
  }

  function callback(provider: string, query: Record<string, string>, cookies: Record<string, string> = {}) {
    const qs = new URLSearchParams(query).toString();
    return app.inject({ method: "GET", url: apiUrl(`/auth/oauth/${provider}/callback?${qs}`), cookies });
  }

  async function completeLogin(
    provider: string,
    identity: OauthIdentity,
    code: string,
  ): Promise<{ statusCode: number; cookies: AuthCookies | null; body: unknown }> {
    const start = await startFlow(provider);
    fakeClient.registerExchange(code, identity);
    const res = await callback(
      provider,
      { state: start.state ?? "", code },
      start.bindingCookie ? { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie } : {},
    );
    return { statusCode: res.statusCode, cookies: extractAuthCookies(res), body: res.json?.() };
  }

  async function registerPasskeyForEmail(email: string, credentialIdB64url: string): Promise<void> {
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email },
    });
    verifyRegistrationMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: credentialIdB64url, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0 },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: {
        ceremony_id: dataOf<{ ceremony_id: string }>(optionsRes).ceremony_id,
        response: {
          id: credentialIdB64url,
          rawId: credentialIdB64url,
          type: "public-key",
          clientExtensionResults: {},
          response: { clientDataJSON: "x", attestationObject: "y" },
        },
      },
    });
  }

  // ---- Task 5 / Test Scenario 1 -------------------------------------------

  for (const provider of PROVIDERS) {
    it(`STORY-015 · scenario 1 (${provider}) — start carries PKCE + signed state; callback creates the user and an oauth credential, and sets session cookies`, async () => {
      const start = await startFlow(provider);
      expect(start.statusCode).toBe(201);
      const url = new URL(start.authorizationUrl!);
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(start.state).toBeTruthy();
      expect(start.bindingCookie).toBeTruthy();

      const email = `${provider}-user@example.com`;
      const identity: OauthIdentity = { externalSubject: `${provider}-sub-1`, email, emailVerified: true };
      fakeClient.registerExchange("code-1", identity);
      const callbackRes = await callback(
        provider,
        { state: start.state!, code: "code-1" },
        { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie! },
      );
      expect(callbackRes.statusCode).toBe(200);
      const body = dataOf<{ outcome: string; user_status: string }>(callbackRes);
      expect(body.outcome).toBe("signed_in");
      expect(body.user_status).toBe("active");
      const cookies = extractAuthCookies(callbackRes);
      expect(cookies).not.toBeNull();

      const userRow = await db.query("SELECT id, status FROM users WHERE email = $1", [email]);
      expect(userRow.rows).toHaveLength(1);
      const credRow = await db.query(
        "SELECT kind, provider, external_subject FROM user_credentials WHERE user_id = $1 AND kind = 'oauth'",
        [userRow.rows[0].id],
      );
      expect(credRow.rows).toHaveLength(1);
      expect(credRow.rows[0]).toEqual({ kind: "oauth", provider, external_subject: identity.externalSubject });
    });
  }

  // ---- Task 6 / Test Scenario 2 -------------------------------------------

  it("STORY-015 · scenario 2 — replaying an already-consumed state on a second callback is refused", async () => {
    const start = await startFlow("google");
    fakeClient.registerExchange("code-replay", {
      externalSubject: "sub-replay",
      email: "replay@example.com",
      emailVerified: true,
    });
    const cookies = start.bindingCookie ? { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie } : {};

    const first = await callback("google", { state: start.state ?? "", code: "code-replay" }, cookies);
    expect(first.statusCode).toBe(200);

    const replay = await callback("google", { state: start.state ?? "", code: "code-replay" }, cookies);
    expect(replay.statusCode).toBe(400);
    const body = replay.json();
    expectOauthFailure(body);
  });

  // ---- Task 7 / Test Scenario 3 -------------------------------------------

  it("STORY-015 · scenario 3 — a valid, unconsumed state presented with no session-binding cookie is refused", async () => {
    const start = await startFlow("google");
    fakeClient.registerExchange("code-no-binding", {
      externalSubject: "sub-no-binding",
      email: "no-binding@example.com",
      emailVerified: true,
    });

    const res = await callback("google", { state: start.state ?? "", code: "code-no-binding" }, {});
    expect(res.statusCode).toBe(400);
    expectOauthFailure(res.json());
  });

  it("STORY-015 · scenario 3 — a valid, unconsumed state presented with the WRONG session-binding cookie is refused", async () => {
    const start = await startFlow("google");
    fakeClient.registerExchange("code-wrong-binding", {
      externalSubject: "sub-wrong-binding",
      email: "wrong-binding@example.com",
      emailVerified: true,
    });

    const res = await callback(
      "google",
      { state: start.state ?? "", code: "code-wrong-binding" },
      { [OAUTH_BINDING_COOKIE_NAME]: "not-the-value-issued-at-start" },
    );
    expect(res.statusCode).toBe(400);
    expectOauthFailure(res.json());
  });

  // ---- Task 8 / Test Scenario 4 -------------------------------------------

  it("STORY-015 · scenario 4 — token exchange uses only the server-held verifier from the claimed request row, never request input", async () => {
    const start = await startFlow("google");
    const { verifyState } = await import("../../src/lib/auth/oauth-state.js");
    const requestId = verifyState(start.state ?? "", process.env.OAUTH_STATE_SECRET!);
    expect(requestId).not.toBeNull();
    const stored = await db.query<{ code_verifier: string }>(
      "SELECT code_verifier FROM oauth_authorization_requests WHERE id = $1",
      [requestId],
    );
    const storedVerifier = stored.rows[0]!.code_verifier;

    const exchangeSpy = vi.spyOn(fakeClient, "exchangeCode");
    fakeClient.registerExchange("code-verifier-proof", {
      externalSubject: "sub-verifier-proof",
      email: "verifier-proof@example.com",
      emailVerified: true,
    });

    const res = await callback(
      "google",
      {
        state: start.state ?? "",
        code: "code-verifier-proof",
        // Not a modeled field (oauthCallbackQuerySchema is deliberately
        // non-strict) — an attacker-controlled value that must never reach
        // the token exchange.
        code_verifier: "attacker-supplied-should-never-be-used",
      },
      start.bindingCookie ? { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie } : {},
    );
    expect(res.statusCode).toBe(200);
    expect(exchangeSpy).toHaveBeenCalledWith(expect.objectContaining({ codeVerifier: storedVerifier }));
    expect(exchangeSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ codeVerifier: "attacker-supplied-should-never-be-used" }),
    );
  });

  it("STORY-015 · scenario 4 — omitting the proof-key verifier server-side (no matching authorization request) is refused", async () => {
    // No /start ever ran for this state — there is no server-held verifier
    // at all for the callback to use, simulating "the verifier was omitted."
    const res = await callback("google", { state: "not-a-real-state-token", code: "some-code" }, {});
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("STORY-015 · scenario 4 — a wrong code_verifier stored on the request row is a REAL rejection (proves the fake's PKCE check is not vacuous)", async () => {
    const start = await startFlow("google");
    fakeClient.registerExchange("code-tampered-verifier", {
      externalSubject: "sub-tampered-verifier",
      email: "tampered-verifier@example.com",
      emailVerified: true,
    });
    const { verifyState } = await import("../../src/lib/auth/oauth-state.js");
    const requestId = verifyState(start.state ?? "", process.env.OAUTH_STATE_SECRET!);
    await db.query("UPDATE oauth_authorization_requests SET code_verifier = 'not-the-issued-verifier' WHERE id = $1", [
      requestId,
    ]);

    const res = await callback(
      "google",
      { state: start.state ?? "", code: "code-tampered-verifier" },
      { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie! },
    );
    expect(res.statusCode).toBe(400);
    expectOauthFailure(res.json());
    const created = await db.query("SELECT id FROM users WHERE email = 'tampered-verifier@example.com'");
    expect(created.rows).toHaveLength(0);
  });

  // ---- Task 9 / Test Scenario 5 -------------------------------------------

  it("STORY-015 · scenario 5 — an unverified email creates the account unverified, with no workspace-create right", async () => {
    const login = await completeLogin(
      "microsoft",
      { externalSubject: "sub-unverified", email: "unverified@example.com", emailVerified: false },
      "code-unverified",
    );
    expect(login.statusCode).toBe(200);
    // STORY-024 T10 — the success body is enveloped; the resource is under `data`.
    expect((login.body as { data: { user_status: string } }).data.user_status).toBe("unverified");

    const userRow = await db.query("SELECT status, email_verified_at FROM users WHERE email = $1", [
      "unverified@example.com",
    ]);
    expect(userRow.rows[0].status).toBe("unverified");
    expect(userRow.rows[0].email_verified_at).toBeNull();

    expect(login.cookies).not.toBeNull();
    const createRes = await app.inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      payload: { name: "Should Be Refused" },
      ...mutatingHeaders(login.cookies!),
    });
    expect(createRes.statusCode).toBe(403);
  });

  // ---- Task 10 / Test Scenario 6 -------------------------------------------

  it("STORY-015 · scenario 6 — same subject, changed email on a later callback resolves to the same account and never overwrites the local email", async () => {
    const first = await completeLogin(
      "github",
      { externalSubject: "sub-stable", email: "original@example.com", emailVerified: true },
      "code-first-email",
    );
    expect(first.statusCode).toBe(200);
    const firstSub = decodeClaims(first.cookies!.access).sub;

    const second = await completeLogin(
      "github",
      { externalSubject: "sub-stable", email: "changed@example.com", emailVerified: true },
      "code-second-email",
    );
    expect(second.statusCode).toBe(200);
    const secondSub = decodeClaims(second.cookies!.access).sub;

    expect(secondSub).toBe(firstSub);

    const userRow = await db.query("SELECT email FROM users WHERE id = $1", [firstSub]);
    expect(userRow.rows[0].email).toBe("original@example.com");

    const credRows = await db.query(
      "SELECT count(*)::int AS count FROM user_credentials WHERE user_id = $1 AND kind = 'oauth' AND provider = 'github'",
      [firstSub],
    );
    expect(credRows.rows[0].count).toBe(1);
  });

  // ---- Task 11 / Test Scenario 7 -------------------------------------------

  it("STORY-015 · scenario 7 — same email, different subject does not resolve to the existing account (uniform neutral failure, never an auto-link)", async () => {
    const first = await completeLogin(
      "google",
      { externalSubject: "sub-owner", email: "shared@example.com", emailVerified: true },
      "code-owner",
    );
    expect(first.statusCode).toBe(200);
    const ownerSub = decodeClaims(first.cookies!.access).sub;

    const impostor = await completeLogin(
      "google",
      { externalSubject: "sub-impostor", email: "shared@example.com", emailVerified: true },
      "code-impostor",
    );
    // Never a 200 that resolves to (or silently creates alongside) the
    // existing account by email — the same neutral failure shape as
    // scenarios 2/3.
    expect(impostor.statusCode).toBe(400);
    expectOauthFailure(impostor.body);

    const usersWithEmail = await db.query("SELECT id FROM users WHERE email = $1", ["shared@example.com"]);
    expect(usersWithEmail.rows).toHaveLength(1);
    expect(usersWithEmail.rows[0].id).toBe(ownerSub);

    const impostorCred = await db.query(
      "SELECT id FROM user_credentials WHERE provider = 'google' AND external_subject = 'sub-impostor'",
    );
    expect(impostorCred.rows).toHaveLength(0);
  });

  // ---- QA-ADDED (temporary): join-key shapes not covered by S6/S7 -----------

  it("STORY-015 · S6 shape — the SAME subject under a DIFFERENT provider is a different account (provider is part of the join key)", async () => {
    const g = await completeLogin(
      "google",
      { externalSubject: "12345", email: "shared-sub-google@example.com", emailVerified: true },
      "code-shared-sub-google",
    );
    expect(g.statusCode).toBe(200);
    const googleUser = decodeClaims(g.cookies!.access).sub;

    const h = await completeLogin(
      "github",
      { externalSubject: "12345", email: "shared-sub-github@example.com", emailVerified: true },
      "code-shared-sub-github",
    );
    expect(h.statusCode).toBe(200);
    expect(decodeClaims(h.cookies!.access).sub).not.toBe(googleUser);
  });

  it("STORY-015 · S6 shape — a known subject reporting a NULL email still resolves by subject, never rejected for the missing email", async () => {
    const first = await completeLogin(
      "google",
      { externalSubject: "sub-null-email", email: "null-email@example.com", emailVerified: true },
      "code-null-email-1",
    );
    expect(first.statusCode).toBe(200);
    const userId = decodeClaims(first.cookies!.access).sub;

    const second = await completeLogin(
      "google",
      { externalSubject: "sub-null-email", email: null, emailVerified: false },
      "code-null-email-2",
    );
    expect(second.statusCode).toBe(200);
    expect(decodeClaims(second.cookies!.access).sub).toBe(userId);
    const row = await db.query("SELECT email, status FROM users WHERE id = $1", [userId]);
    expect(row.rows[0]).toEqual({ email: "null-email@example.com", status: "active" });
  });

  it("STORY-015 · S7 shape — an UNKNOWN subject with a NULL email is refused and creates nothing", async () => {
    const before = await db.query("SELECT count(*)::int AS c FROM users");
    const res = await completeLogin(
      "microsoft",
      { externalSubject: "sub-no-email-at-all", email: null, emailVerified: false },
      "code-no-email",
    );
    expect(res.statusCode).toBe(400);
    const after = await db.query("SELECT count(*)::int AS c FROM users");
    expect(after.rows[0].c).toBe(before.rows[0].c);
    const cred = await db.query("SELECT id FROM user_credentials WHERE external_subject = 'sub-no-email-at-all'");
    expect(cred.rows).toHaveLength(0);
  });

  it("STORY-015 · S7 shape — same email in DIFFERENT CASE with a different subject still never auto-links (citext)", async () => {
    const owner = await completeLogin(
      "google",
      { externalSubject: "sub-case-owner", email: "CaseTest@example.com", emailVerified: true },
      "code-case-owner",
    );
    expect(owner.statusCode).toBe(200);
    const ownerId = decodeClaims(owner.cookies!.access).sub;

    const impostor = await completeLogin(
      "google",
      { externalSubject: "sub-case-impostor", email: "casetest@EXAMPLE.com", emailVerified: true },
      "code-case-impostor",
    );
    expect(impostor.statusCode).toBe(400);
    const creds = await db.query("SELECT id FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL", [ownerId]);
    expect(creds.rows).toHaveLength(1);
    const cred = await db.query("SELECT id FROM user_credentials WHERE external_subject = 'sub-case-impostor'");
    expect(cred.rows).toHaveLength(0);
  });

  it("STORY-015 · S7 shape — a different subject on the email of an EXISTING PASSKEY-only user never auto-links onto it", async () => {
    const email = "passkey-only@example.com";
    await registerPasskeyForEmail(email, Buffer.from("cred-passkey-only", "utf8").toString("base64url"));
    const owner = await db.query("SELECT id FROM users WHERE email = $1", [email]);
    expect(owner.rows).toHaveLength(1);

    const res = await completeLogin(
      "google",
      { externalSubject: "sub-passkey-hijack", email, emailVerified: true },
      "code-passkey-hijack",
    );
    expect(res.statusCode).toBe(400);
    const creds = await db.query(
      "SELECT kind FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL",
      [owner.rows[0].id],
    );
    expect(creds.rows.map((r: { kind: string }) => r.kind)).toEqual(["passkey"]);
  });

  // ---- Task 12 / AC5 --------------------------------------------------------

  it("STORY-015 · AC5 — POST /auth/oauth/:provider/link/start with no authenticated session is refused with 401", async () => {
    const res = await app.inject({ method: "POST", url: apiUrl("/auth/oauth/google/link/start") });
    expect(res.statusCode).toBe(401);
  });

  it("STORY-015 · AC5 — a login-purpose callback never links onto an existing, currently-authenticated account", async () => {
    const owner = await completeLogin(
      "google",
      { externalSubject: "sub-owner-2", email: "owner2@example.com", emailVerified: true },
      "code-owner-2",
    );
    expect(owner.statusCode).toBe(200);
    const ownerSub = decodeClaims(owner.cookies!.access).sub;

    // A plain (purpose=login) start+callback for an unrelated identity,
    // while the owner's session cookies happen to still be present on the
    // request — must never link onto ownerSub.
    const start = await startFlow("google", { cookies: sessionCookieHeader(owner.cookies!) });
    fakeClient.registerExchange("code-unrelated", {
      externalSubject: "sub-unrelated",
      email: "unrelated@example.com",
      emailVerified: true,
    });
    const res = await callback(
      "google",
      { state: start.state ?? "", code: "code-unrelated" },
      {
        ...(start.bindingCookie ? { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie } : {}),
        ...sessionCookieHeader(owner.cookies!),
      },
    );
    expect(res.statusCode).toBe(200);
    const newSub = decodeClaims(extractAuthCookies(res)!.access).sub;
    expect(newSub).not.toBe(ownerSub);
  });

  it("STORY-015 · AC5 — a link-purpose callback presented without the authenticated session that started it is refused", async () => {
    const owner = await completeLogin(
      "google",
      { externalSubject: "sub-owner-3", email: "owner3@example.com", emailVerified: true },
      "code-owner-3",
    );
    expect(owner.statusCode).toBe(200);

    const start = await startFlow("microsoft", { purpose: "link", ...mutatingHeaders(owner.cookies!) });
    expect(start.statusCode).toBe(201);
    fakeClient.registerExchange("code-link-no-session", {
      externalSubject: "sub-link-no-session",
      email: "link-no-session@example.com",
      emailVerified: true,
    });

    // Same binding cookie as issued, but the authenticated session that
    // started the link is absent this time.
    const res = await callback(
      "microsoft",
      { state: start.state ?? "", code: "code-link-no-session" },
      start.bindingCookie ? { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie } : {},
    );
    expect(res.statusCode).toBe(400);
    expectOauthFailure(res.json());
  });

  // ---- QA-ADDED (temporary): CSRF enforcement on /link/start ---------------

  it("STORY-015 · AC5 — /link/start with a valid session cookie but NO CSRF header is refused 403", async () => {
    const owner = await completeLogin(
      "google",
      { externalSubject: "sub-csrf-1", email: "csrf1@example.com", emailVerified: true },
      "code-csrf-1",
    );
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/auth/oauth/google/link/start"),
      cookies: { [ACCESS_COOKIE_NAME]: owner.cookies!.access, [CSRF_COOKIE_NAME]: owner.cookies!.csrf },
    });
    expect(res.statusCode).toBe(403);
  });

  it("STORY-015 · AC5 — /link/start with a WRONG CSRF header is refused 403", async () => {
    const owner = await completeLogin(
      "google",
      { externalSubject: "sub-csrf-2", email: "csrf2@example.com", emailVerified: true },
      "code-csrf-2",
    );
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/auth/oauth/google/link/start"),
      headers: { [CSRF_HEADER_NAME]: "not-the-right-token" },
      cookies: { [ACCESS_COOKIE_NAME]: owner.cookies!.access, [CSRF_COOKIE_NAME]: owner.cookies!.csrf },
    });
    expect(res.statusCode).toBe(403);
  });

  it("STORY-015 · AC5 — /link/start with a CSRF header borrowed from ANOTHER user's session is refused 403", async () => {
    const owner = await completeLogin(
      "google",
      { externalSubject: "sub-csrf-3", email: "csrf3@example.com", emailVerified: true },
      "code-csrf-3",
    );
    const other = await completeLogin(
      "github",
      { externalSubject: "sub-csrf-4", email: "csrf4@example.com", emailVerified: true },
      "code-csrf-4",
    );
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/auth/oauth/google/link/start"),
      headers: { [CSRF_HEADER_NAME]: other.cookies!.csrf },
      cookies: { [ACCESS_COOKIE_NAME]: owner.cookies!.access, [CSRF_COOKIE_NAME]: other.cookies!.csrf },
    });
    expect(res.statusCode).toBe(403);
  });

  it("STORY-015 · scenario 8 — DELETE /me/oauth/:provider with NO CSRF header is refused 403", async () => {
    const owner = await completeLogin(
      "google",
      { externalSubject: "sub-csrf-5", email: "csrf5@example.com", emailVerified: true },
      "code-csrf-5",
    );
    const res = await app.inject({
      method: "DELETE",
      url: apiUrl("/me/oauth/google"),
      cookies: { [ACCESS_COOKIE_NAME]: owner.cookies!.access, [CSRF_COOKIE_NAME]: owner.cookies!.csrf },
    });
    expect(res.statusCode).toBe(403);
  });

  // ---- Task 13 / Test Scenario 8 -------------------------------------------

  it("STORY-015 · scenario 8 — unlinking the only remaining authentication method is refused with 409", async () => {
    const login = await completeLogin(
      "google",
      { externalSubject: "sub-only-method", email: "only-method@example.com", emailVerified: true },
      "code-only-method",
    );
    expect(login.statusCode).toBe(200);

    const res = await app.inject({
      method: "DELETE",
      url: apiUrl("/me/oauth/google"),
      ...mutatingHeaders(login.cookies!),
    });
    expect(res.statusCode).toBe(409);
  });

  it("STORY-015 · scenario 8 — unlinking succeeds when a passkey also remains", async () => {
    const login = await completeLogin(
      "google",
      { externalSubject: "sub-with-passkey", email: "with-passkey@example.com", emailVerified: true },
      "code-with-passkey",
    );
    expect(login.statusCode).toBe(200);

    await registerPasskeyForEmail("with-passkey@example.com", Buffer.from("cred-oauth-unlink", "utf8").toString("base64url"));

    const res = await app.inject({
      method: "DELETE",
      url: apiUrl("/me/oauth/google"),
      ...mutatingHeaders(login.cookies!),
    });
    expect(res.statusCode).toBe(200);
  });

  // ---- QA-ADDED (temporary): concurrent replay of one state -----------------

  it("STORY-015 · scenario 2 (concurrency) — two callbacks racing the SAME state: exactly one succeeds", async () => {
    const start = await startFlow("google");
    fakeClient.registerExchange("code-race", {
      externalSubject: "sub-race",
      email: "race@example.com",
      emailVerified: true,
    });
    const cookies = start.bindingCookie ? { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie } : {};

    const [a, b] = await Promise.all([
      callback("google", { state: start.state ?? "", code: "code-race" }, cookies),
      callback("google", { state: start.state ?? "", code: "code-race" }, cookies),
    ]);
    const successes = [a, b].filter((r) => r.statusCode === 200).length;
    const users = await db.query("SELECT count(*)::int AS c FROM users WHERE email = $1", ["race@example.com"]);
    expect({ successes, users: users.rows[0].c }).toEqual({ successes: 1, users: 1 });
  });

  it("STORY-015 · scenario 2 (concurrency, EXISTING account) — two callbacks racing one state mint at most ONE session", async () => {
    await completeLogin(
      "google",
      { externalSubject: "sub-race-existing", email: "race-existing@example.com", emailVerified: true },
      "code-race-existing-first",
    );
    const before = await db.query("SELECT count(*)::int AS c FROM sessions");

    const start = await startFlow("google");
    fakeClient.registerExchange("code-race-existing", {
      externalSubject: "sub-race-existing",
      email: "race-existing@example.com",
      emailVerified: true,
    });
    const cookies = start.bindingCookie ? { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie } : {};
    const [a, b] = await Promise.all([
      callback("google", { state: start.state ?? "", code: "code-race-existing" }, cookies),
      callback("google", { state: start.state ?? "", code: "code-race-existing" }, cookies),
    ]);
    const successes = [a, b].filter((r) => r.statusCode === 200).length;
    const after = await db.query("SELECT count(*)::int AS c FROM sessions");
    expect({ successes, newSessions: after.rows[0].c - before.rows[0].c }).toEqual({ successes: 1, newSessions: 1 });
  });

  // ---- STORY-015 follow-up (code-review) — advisory-lock fix for the ------
  // ---- create-path race a mere FOR UPDATE cannot close --------------------

  it("STORY-015 · advisory-lock fix — two concurrent FIRST-TIME callbacks for the SAME brand-new subject (different state/code each) create exactly one user and one credential", async () => {
    // Two SEPARATE authorization flows (distinct state/code/binding cookie
    // each) so the pre-existing state-single-use claim never rejects either
    // one — this is what makes the race land inside resolveOrCreateForLogin
    // itself, unlike the "racing the SAME state" tests above.
    //
    // A bare Promise.all of the two callbacks does NOT reliably land inside
    // the vulnerable window on localhost: measured directly with hrtime
    // while diagnosing this test, one full transaction (BEGIN..COMMIT)
    // consistently completes in ~1-3ms, well before the second concurrent
    // request's handler even reaches its own BEGIN — so an un-forced race
    // here would be flaky-to-silent rather than a reliable regression
    // guard. To force a genuine overlap deterministically (the same thing
    // the code-reviewer did by hand-interleaving two raw pg connections),
    // this test-only patch delays the FIRST call that reaches the
    // credential lookup for our brand-new subject, just long enough for
    // the second concurrent request to run its own lookup and insert
    // first. It patches pg's Client.prototype.query directly (never
    // oauth.service.ts) and is restored in the `finally` block below.
    //
    // Each leg uses a DIFFERENT email (same provider + same external
    // subject) so this test isolates the credential-uniqueness race this
    // commit fixes from the separate, pre-existing FOR-UPDATE-on-email
    // check a few lines below it in oauth.service.ts — that's a distinct
    // mechanism this story does not touch.
    const externalSubject = "sub-brand-new-concurrent";
    const identityA: OauthIdentity = { externalSubject, email: "brand-new-concurrent-a@example.com", emailVerified: true };
    const identityB: OauthIdentity = { externalSubject, email: "brand-new-concurrent-b@example.com", emailVerified: true };

    const originalQuery = Client.prototype.query;
    let delayedOnce = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Client.prototype as any).query = function (this: Client, ...args: any[]) {
      const text: unknown = typeof args[0] === "string" ? args[0] : args[0]?.text;
      const values: unknown = typeof args[0] === "string" ? args[1] : args[0]?.values;
      const isTargetCredentialLookup =
        typeof text === "string" &&
        text.includes("FROM user_credentials") &&
        text.includes("FOR UPDATE") &&
        Array.isArray(values) &&
        values[1] === externalSubject;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resultPromise = originalQuery.apply(this, args as any) as unknown as Promise<unknown>;
      if (isTargetCredentialLookup && !delayedOnce) {
        delayedOnce = true;
        return resultPromise.then((result) => new Promise((resolve) => setTimeout(() => resolve(result), 200)));
      }
      return resultPromise;
    };

    try {
      const startA = await startFlow("google");
      const startB = await startFlow("google");
      fakeClient.registerExchange("code-concurrent-a", identityA);
      fakeClient.registerExchange("code-concurrent-b", identityB);
      const cookiesA = startA.bindingCookie ? { [OAUTH_BINDING_COOKIE_NAME]: startA.bindingCookie } : {};
      const cookiesB = startB.bindingCookie ? { [OAUTH_BINDING_COOKIE_NAME]: startB.bindingCookie } : {};

      const [a, b] = await Promise.all([
        callback("google", { state: startA.state ?? "", code: "code-concurrent-a" }, cookiesA),
        callback("google", { state: startB.state ?? "", code: "code-concurrent-b" }, cookiesB),
      ]);

      // Neither side may see a bare/untyped 500 (the ux_credentials_oauth
      // duplicate-key error this fix closes) — both are a clean success
      // resolving to the SAME account.
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(dataOf<{ outcome: string }>(a).outcome).toBe("signed_in");
      expect(dataOf<{ outcome: string }>(b).outcome).toBe("signed_in");

      const cookiesOfA = extractAuthCookies(a);
      const cookiesOfB = extractAuthCookies(b);
      expect(cookiesOfA).not.toBeNull();
      expect(cookiesOfB).not.toBeNull();
      expect(decodeClaims(cookiesOfA!.access).sub).toBe(decodeClaims(cookiesOfB!.access).sub);

      const creds = await db.query(
        "SELECT count(*)::int AS c FROM user_credentials WHERE kind = 'oauth' AND provider = 'google' AND external_subject = $1",
        [externalSubject],
      );
      expect(creds.rows[0].c).toBe(1);
      const users = await db.query("SELECT count(*)::int AS c FROM users WHERE id = $1", [
        decodeClaims(cookiesOfA!.access).sub,
      ]);
      expect(users.rows[0].c).toBe(1);
    } finally {
      Client.prototype.query = originalQuery;
    }
  });

  // ---- QA-ADDED (temporary): STORY-014 bundled status-promotion fix --------

  it("STORY-015 · bundled STORY-014 fix — a completed passkey registration promotes users.status from 'unverified' to 'active'", async () => {
    const email = "passkey-promote@example.com";
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email },
    });
    expect(optionsRes.statusCode).toBe(201);
    const before = await db.query("SELECT status FROM users WHERE email = $1", [email]);
    expect(before.rows[0].status).toBe("unverified");

    await registerPasskeyForEmail(email, Buffer.from("cred-promote", "utf8").toString("base64url"));

    const after = await db.query("SELECT status FROM users WHERE email = $1", [email]);
    expect(after.rows[0].status).toBe("active");
  });

  it("STORY-015 · bundled STORY-014 fix — a passkey-registered user can create a workspace over HTTP (the exact regression the fix exists to prevent)", async () => {
    const email = "passkey-workspace@example.com";
    const optionsRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email },
    });
    verifyRegistrationMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: "cred-ws-b64", publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0 },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    const verifyRes = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: {
        ceremony_id: dataOf<{ ceremony_id: string }>(optionsRes).ceremony_id,
        response: {
          id: "cred-ws-b64",
          rawId: "cred-ws-b64",
          type: "public-key",
          clientExtensionResults: {},
          response: { clientDataJSON: "x", attestationObject: "y" },
        },
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    const cookies = extractAuthCookies(verifyRes);
    expect(cookies).not.toBeNull();

    const createRes = await app.inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      payload: { name: "Passkey Owned Workspace" },
      ...mutatingHeaders(cookies!),
    });
    expect(createRes.statusCode).toBe(201);
  });

  // ---- QA-ADDED (temporary): concurrent last-credential unlink -------------

  it("STORY-015 · scenario 8 (concurrency) — two concurrent unlinks on a user with exactly TWO credentials never self-lock-out", async () => {
    const login = await completeLogin(
      "google",
      { externalSubject: "sub-race-unlink", email: "race-unlink@example.com", emailVerified: true },
      "code-race-unlink-google",
    );
    expect(login.statusCode).toBe(200);
    const userId = decodeClaims(login.cookies!.access).sub;

    // Link a SECOND provider through the real link flow.
    const linkStart = await startFlow("github", { purpose: "link", ...mutatingHeaders(login.cookies!) });
    expect(linkStart.statusCode).toBe(201);
    fakeClient.registerExchange("code-race-unlink-github", {
      externalSubject: "sub-race-unlink-gh",
      email: "race-unlink-gh@example.com",
      emailVerified: true,
    });
    const linkRes = await callback(
      "github",
      { state: linkStart.state ?? "", code: "code-race-unlink-github" },
      {
        [OAUTH_BINDING_COOKIE_NAME]: linkStart.bindingCookie!,
        [ACCESS_COOKIE_NAME]: login.cookies!.access,
      },
    );
    expect(linkRes.statusCode).toBe(200);
    expect(dataOf<{ outcome: string }>(linkRes).outcome).toBe("linked");

    const activeBefore = await db.query(
      "SELECT count(*)::int AS c FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
    expect(activeBefore.rows[0].c).toBe(2);

    const [a, b] = await Promise.all([
      app.inject({ method: "DELETE", url: apiUrl("/me/oauth/google"), ...mutatingHeaders(login.cookies!) }),
      app.inject({ method: "DELETE", url: apiUrl("/me/oauth/github"), ...mutatingHeaders(login.cookies!) }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    const activeAfter = await db.query(
      "SELECT count(*)::int AS c FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
    // Exactly one succeeds; the user is NEVER left with zero auth methods.
    expect({ codes, remaining: activeAfter.rows[0].c }).toEqual({ codes: [200, 409], remaining: 1 });
  });

  // ---- QA-ADDED (temporary): raw-response leak sweep ------------------------

  it("STORY-015 · scenario 9 (raw sweep) — no provider detail leaks in BODY or HEADERS, across every rejection channel", async () => {
    const S1 = "SENTINEL_PROVIDER_ERROR_CODE_a1b2";
    const S2 = "SENTINEL_PROVIDER_ERROR_DESC_c3d4";
    const S3 = "SENTINEL_EXCHANGE_THROW_e5f6";
    const S4 = "SENTINEL_COLLIDING_EMAIL_g7h8@example.com";
    const dump: Array<{ label: string; status: number; body: string; headers: string }> = [];

    // (a) provider returned error + error_description
    const a = await startFlow("google");
    const ra = await callback(
      "google",
      { state: a.state ?? "", error: S1, error_description: S2 },
      { [OAUTH_BINDING_COOKIE_NAME]: a.bindingCookie! },
    );
    dump.push({ label: "provider_error", status: ra.statusCode, body: ra.payload, headers: JSON.stringify(ra.headers) });

    // (b) token exchange threw with a sentinel message
    const b = await startFlow("google");
    vi.spyOn(fakeClient, "exchangeCode").mockRejectedValueOnce(new Error(S3));
    const rb = await callback(
      "google",
      { state: b.state ?? "", code: "irrelevant" },
      { [OAUTH_BINDING_COOKIE_NAME]: b.bindingCookie! },
    );
    dump.push({ label: "exchange_failed", status: rb.statusCode, body: rb.payload, headers: JSON.stringify(rb.headers) });
    vi.restoreAllMocks();

    // (c) email collision — the colliding address must not be echoed
    await completeLogin("google", { externalSubject: "sub-leak-owner", email: S4, emailVerified: true }, "code-leak-owner");
    const c = await startFlow("google");
    fakeClient.registerExchange("code-leak-impostor", {
      externalSubject: "sub-leak-impostor",
      email: S4,
      emailVerified: true,
    });
    const rc = await callback(
      "google",
      { state: c.state ?? "", code: "code-leak-impostor" },
      { [OAUTH_BINDING_COOKIE_NAME]: c.bindingCookie! },
    );
    dump.push({ label: "email_collision", status: rc.statusCode, body: rc.payload, headers: JSON.stringify(rc.headers) });

    // (d) replay, (e) wrong binding — bodies must be byte-identical to (a)
    const d = await startFlow("google");
    fakeClient.registerExchange("code-leak-replay", {
      externalSubject: "sub-leak-replay",
      email: "leak-replay@example.com",
      emailVerified: true,
    });
    await callback("google", { state: d.state ?? "", code: "code-leak-replay" }, { [OAUTH_BINDING_COOKIE_NAME]: d.bindingCookie! });
    const rd = await callback("google", { state: d.state ?? "", code: "code-leak-replay" }, { [OAUTH_BINDING_COOKIE_NAME]: d.bindingCookie! });
    dump.push({ label: "replay", status: rd.statusCode, body: rd.payload, headers: JSON.stringify(rd.headers) });

    const e = await startFlow("google");
    const re = await callback("google", { state: e.state ?? "", code: "x" }, { [OAUTH_BINDING_COOKIE_NAME]: "wrong" });
    dump.push({ label: "wrong_binding", status: re.statusCode, body: re.payload, headers: JSON.stringify(re.headers) });


    for (const entry of dump) {
      for (const sentinel of [S1, S2, S3, S4]) {
        expect(entry.body, `${entry.label} body leaked ${sentinel}`).not.toContain(sentinel);
        expect(entry.headers, `${entry.label} headers leaked ${sentinel}`).not.toContain(sentinel);
      }
    }
    // Every rejection is indistinguishable once request_id is normalized.
    const normalized = dump.map((entry) => ({
      status: entry.status,
      // STORY-024 T9 — the body now carries TWO request identifiers: the one
      // OauthFailedException puts in details, and the one §2 requires on every
      // error. Both vary per request and neither distinguishes a rejection
      // path, so both are normalised — the `g` flag is what makes that true.
      body: entry.body.replace(/"request_id":"[^"]*"/g, '"request_id":"<X>"'),
    }));
    for (const n of normalized) {
      expect(n).toEqual(normalized[0]);
    }
  });

  // ---- QA-ADDED (temporary): relink-after-unlink --------------------------

  it("STORY-015 · relink after unlink — re-linking a previously unlinked provider must not 500 (ux_credentials_oauth is not partial on revoked_at)", async () => {
    const email = "relink@example.com";
    const login = await completeLogin(
      "google",
      { externalSubject: "sub-relink", email, emailVerified: true },
      "code-relink-1",
    );
    expect(login.statusCode).toBe(200);
    await registerPasskeyForEmail(email, Buffer.from("cred-relink", "utf8").toString("base64url"));

    const unlink = await app.inject({ method: "DELETE", url: apiUrl("/me/oauth/google"), ...mutatingHeaders(login.cookies!) });
    expect(unlink.statusCode).toBe(200);

    const start = await startFlow("google", { purpose: "link", ...mutatingHeaders(login.cookies!) });
    expect(start.statusCode).toBe(201);
    fakeClient.registerExchange("code-relink-2", { externalSubject: "sub-relink", email, emailVerified: true });
    const res = await callback(
      "google",
      { state: start.state ?? "", code: "code-relink-2" },
      { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie!, [ACCESS_COOKIE_NAME]: login.cookies!.access },
    );
    expect(res.statusCode).toBe(200);
    expect(dataOf<{ outcome: string }>(res).outcome).toBe("linked");

    const rows = await db.query(
      "SELECT revoked_at FROM user_credentials WHERE provider = 'google' AND external_subject = 'sub-relink'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].revoked_at).toBeNull();
  });

  it("STORY-015 · re-login after unlink — signing in again with an unlinked provider reactivates the SAME credential row, not a second one", async () => {
    const email = "relogin@example.com";
    const login = await completeLogin(
      "google",
      { externalSubject: "sub-relogin", email, emailVerified: true },
      "code-relogin-1",
    );
    const userId = decodeClaims(login.cookies!.access).sub;
    await registerPasskeyForEmail(email, Buffer.from("cred-relogin", "utf8").toString("base64url"));
    const unlink = await app.inject({ method: "DELETE", url: apiUrl("/me/oauth/google"), ...mutatingHeaders(login.cookies!) });
    expect(unlink.statusCode).toBe(200);

    const again = await completeLogin("google", { externalSubject: "sub-relogin", email, emailVerified: true }, "code-relogin-2");
    expect(again.statusCode).toBe(200);
    expect(decodeClaims(again.cookies!.access).sub).toBe(userId);

    const rows = await db.query(
      "SELECT revoked_at FROM user_credentials WHERE provider = 'google' AND external_subject = 'sub-relogin'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].revoked_at).toBeNull();
  });

  // ---- QA-ADDED (temporary): AC3 short-lived + binding-cookie hardening ----

  it("STORY-015 · AC3 — an EXPIRED but unconsumed state is refused (expires_at > now() is load-bearing)", async () => {
    const start = await startFlow("google");
    const { verifyState } = await import("../../src/lib/auth/oauth-state.js");
    const requestId = verifyState(start.state ?? "", process.env.OAUTH_STATE_SECRET!);
    await db.query(
      "UPDATE oauth_authorization_requests SET expires_at = now() - interval '1 second' WHERE id = $1",
      [requestId],
    );
    fakeClient.registerExchange("code-expired", {
      externalSubject: "sub-expired",
      email: "expired@example.com",
      emailVerified: true,
    });
    const res = await callback(
      "google",
      { state: start.state ?? "", code: "code-expired" },
      { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie! },
    );
    expect(res.statusCode).toBe(400);
    const created = await db.query("SELECT id FROM users WHERE email = 'expired@example.com'");
    expect(created.rows).toHaveLength(0);
  });

  it("STORY-015 · AC3 — the state TTL is at most 10 minutes and the row carries a matching expires_at", async () => {
    const before = Date.now();
    const start = await startFlow("google");
    const expiresAt = new Date(start.stateExpiresAt!).getTime();
    expect(expiresAt - before).toBeGreaterThan(0);
    expect(expiresAt - before).toBeLessThanOrEqual(10 * 60 * 1000 + 5_000);
  });

  it("STORY-015 · AC3 — the binding cookie is __Host- prefixed, httpOnly, Secure, SameSite=Lax (NOT Strict) and Path=/", async () => {
    const res = await app.inject({ method: "POST", url: apiUrl("/auth/oauth/google/start") });
    const cookie = res.cookies.find((c) => c.name === OAUTH_BINDING_COOKIE_NAME) as
      | { name: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; path?: string; maxAge?: number }
      | undefined;
    expect(cookie).toBeDefined();
    expect(cookie!.name.startsWith("__Host-")).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.secure).toBe(true);
    expect(String(cookie!.sameSite).toLowerCase()).toBe("lax");
    expect(cookie!.path).toBe("/");
  });

  // ---- QA-ADDED (temporary): untested rejection branches --------------------

  it("STORY-015 · S3 variant — a state issued for google, replayed on the GITHUB callback route, is refused (provider_mismatch)", async () => {
    const start = await startFlow("google");
    fakeClient.registerExchange("code-cross-provider", {
      externalSubject: "sub-cross-provider",
      email: "cross@example.com",
      emailVerified: true,
    });
    const res = await callback(
      "github",
      { state: start.state ?? "", code: "code-cross-provider" },
      { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie! },
    );
    expect(res.statusCode).toBe(400);
    expectOauthFailure(res.json());
    const created = await db.query("SELECT id FROM users WHERE email = 'cross@example.com'");
    expect(created.rows).toHaveLength(0);
  });

  it("STORY-015 · AC5 variant — a link callback completed while authenticated as a DIFFERENT user is refused and links nothing", async () => {
    const starter = await completeLogin(
      "google",
      { externalSubject: "sub-link-starter", email: "link-starter@example.com", emailVerified: true },
      "code-link-starter",
    );
    const other = await completeLogin(
      "github",
      { externalSubject: "sub-link-other", email: "link-other@example.com", emailVerified: true },
      "code-link-other",
    );
    const starterId = decodeClaims(starter.cookies!.access).sub;
    const otherId = decodeClaims(other.cookies!.access).sub;

    const start = await startFlow("microsoft", { purpose: "link", ...mutatingHeaders(starter.cookies!) });
    expect(start.statusCode).toBe(201);
    fakeClient.registerExchange("code-link-hijack", {
      externalSubject: "sub-link-hijack",
      email: "link-hijack@example.com",
      emailVerified: true,
    });
    const res = await callback(
      "microsoft",
      { state: start.state ?? "", code: "code-link-hijack" },
      { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie!, [ACCESS_COOKIE_NAME]: other.cookies!.access },
    );
    expect(res.statusCode).toBe(400);
    expectOauthFailure(res.json());
    for (const id of [starterId, otherId]) {
      const creds = await db.query(
        "SELECT provider FROM user_credentials WHERE user_id = $1 AND provider = 'microsoft' AND revoked_at IS NULL",
        [id],
      );
      expect(creds.rows, id).toHaveLength(0);
    }
  });

  it("STORY-015 · AC6 variant — linking a subject already linked to ANOTHER account is refused and never re-points the credential", async () => {
    const owner = await completeLogin(
      "google",
      { externalSubject: "sub-contested", email: "contested-owner@example.com", emailVerified: true },
      "code-contested-owner",
    );
    const ownerId = decodeClaims(owner.cookies!.access).sub;
    const thief = await completeLogin(
      "github",
      { externalSubject: "sub-thief", email: "thief@example.com", emailVerified: true },
      "code-thief",
    );
    const thiefId = decodeClaims(thief.cookies!.access).sub;

    const start = await startFlow("google", { purpose: "link", ...mutatingHeaders(thief.cookies!) });
    expect(start.statusCode).toBe(201);
    fakeClient.registerExchange("code-steal", {
      externalSubject: "sub-contested",
      email: "contested-owner@example.com",
      emailVerified: true,
    });
    const res = await callback(
      "google",
      { state: start.state ?? "", code: "code-steal" },
      { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie!, [ACCESS_COOKIE_NAME]: thief.cookies!.access },
    );
    expect(res.statusCode).toBe(400);
    expectOauthFailure(res.json());
    const row = await db.query(
      "SELECT user_id FROM user_credentials WHERE provider = 'google' AND external_subject = 'sub-contested' AND revoked_at IS NULL",
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].user_id).toBe(ownerId);
    const thiefGoogle = await db.query(
      "SELECT id FROM user_credentials WHERE user_id = $1 AND provider = 'google' AND revoked_at IS NULL",
      [thiefId],
    );
    expect(thiefGoogle.rows).toHaveLength(0);
  });

  it("STORY-015 · AC6 variant — linking a subject already REVOKED-linked to ANOTHER account is refused, never silently stolen", async () => {
    const owner = await completeLogin(
      "google",
      { externalSubject: "sub-contested-revoked", email: "contested-revoked-owner@example.com", emailVerified: true },
      "code-contested-revoked-owner",
    );
    const ownerId = decodeClaims(owner.cookies!.access).sub;
    await registerPasskeyForEmail(
      "contested-revoked-owner@example.com",
      Buffer.from("cred-contested-revoked", "utf8").toString("base64url"),
    );
    const ownerUnlink = await app.inject({
      method: "DELETE",
      url: apiUrl("/me/oauth/google"),
      ...mutatingHeaders(owner.cookies!),
    });
    expect(ownerUnlink.statusCode).toBe(200);

    const thief = await completeLogin(
      "github",
      { externalSubject: "sub-thief-revoked", email: "thief-revoked@example.com", emailVerified: true },
      "code-thief-revoked",
    );
    const thiefId = decodeClaims(thief.cookies!.access).sub;

    const start = await startFlow("google", { purpose: "link", ...mutatingHeaders(thief.cookies!) });
    expect(start.statusCode).toBe(201);
    fakeClient.registerExchange("code-steal-revoked", {
      externalSubject: "sub-contested-revoked",
      email: "contested-revoked-owner@example.com",
      emailVerified: true,
    });
    const res = await callback(
      "google",
      { state: start.state ?? "", code: "code-steal-revoked" },
      { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie!, [ACCESS_COOKIE_NAME]: thief.cookies!.access },
    );
    expect(res.statusCode).toBe(400);
    expectOauthFailure(res.json());

    const row = await db.query(
      "SELECT user_id, revoked_at FROM user_credentials WHERE provider = 'google' AND external_subject = 'sub-contested-revoked'",
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].user_id).toBe(ownerId);
    expect(row.rows[0].revoked_at).not.toBeNull();
    const thiefGoogle = await db.query(
      "SELECT id FROM user_credentials WHERE user_id = $1 AND provider = 'google'",
      [thiefId],
    );
    expect(thiefGoogle.rows).toHaveLength(0);
  });

  it("STORY-015 · scenario 8 variant — unlinking a provider the caller never linked is refused 403, not 409/200", async () => {
    const login = await completeLogin(
      "google",
      { externalSubject: "sub-never-linked", email: "never-linked@example.com", emailVerified: true },
      "code-never-linked",
    );
    const res = await app.inject({
      method: "DELETE",
      url: apiUrl("/me/oauth/microsoft"),
      ...mutatingHeaders(login.cookies!),
    });
    expect(res.statusCode).toBe(403);
  });

  it("STORY-015 · AC8 — the neutral error body carries a NON-EMPTY request identifier", async () => {
    const start = await startFlow("github");
    const res = await callback(
      "github",
      { state: start.state ?? "", error: "access_denied", error_description: SENTINEL_PROVIDER_ERROR },
      { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie! },
    );
    expect(res.statusCode).toBe(400);
    const body = res.json() as { detail: string; error: { details: { request_id: string }; request_id: string } };
    expectOauthFailure(body);
    expect(typeof body.error.details.request_id).toBe("string");
    expect(body.error.request_id, "§2 requires a request identifier on every error body").toBeTruthy();
    expect(body.error.details.request_id.length).toBeGreaterThan(0);
  });

  // ---- Task 14 / Test Scenario 9 -------------------------------------------

  it("STORY-015 · scenario 9 — a provider error returns a neutral message with a request identifier, never the provider's raw error text", async () => {
    const start = await startFlow("github");
    const res = await callback(
      "github",
      { state: start.state ?? "", error: "access_denied", error_description: SENTINEL_PROVIDER_ERROR },
      start.bindingCookie ? { [OAUTH_BINDING_COOKIE_NAME]: start.bindingCookie } : {},
    );
    expect(res.statusCode).toBe(400);
    const raw = res.payload;
    expect(raw).not.toContain(SENTINEL_PROVIDER_ERROR);
    const body = res.json() as { error: { details: { request_id: string } } };
    expectOauthFailure(body);
    expect(typeof body.error.details.request_id).toBe("string");
    expect(body.error.details.request_id.length).toBeGreaterThan(0);
  });

  // ---- STORY-023 T2 (RED step, coordinator-flagged defect) -----------------
  //
  // T0c's global `/v1` prefix (src/api/configure-app.ts, API_VERSION_PREFIX)
  // moved this route to `/v1/auth/oauth/:provider/callback`
  // (oauth.controller.ts:56, `@Get("auth/oauth/:provider/callback")` under
  // the prefix), but oauth.service.ts's private `redirectUriFor()` still
  // builds the UNPREFIXED "/auth/oauth/:provider/callback" and both hands it
  // to the provider as `redirect_uri` AND persists it to
  // `oauth_authorization_requests.redirect_uri`. In production the provider
  // redirects the browser back to a path this API no longer serves — a 404.
  //
  // Why the rest of this 1400-line suite never caught it: every OTHER
  // `callback()` call in this file reaches the handler through
  // `apiUrl(...)` (the real, prefixed router path) directly, never through
  // the value OauthService itself derived — and the real token-exchange
  // adapter (openid-client.adapter.ts:91) only ever rebuilds `currentUrl`
  // from the STORED redirect_uri, comparing it against itself, never against
  // the router. Nothing before this test connects "what OauthService
  // constructs" to "what the router serves" — the same class of gap as
  // this task's blocker B1, one layer down.
  //
  // Deliberately does NOT hard-code "/v1/auth/oauth/google/callback" — that
  // would just re-encode this bug's mirror image and pass forever even if
  // configureApp's prefix changed again. Two independent, non-hardcoded
  // checks instead: (1) exact equality against `apiUrl(...)`, the same
  // API_VERSION_PREFIX-derived seam every other test in this file already
  // trusts as the router's real path; (2) a LIVE probe of the real app
  // router with the EXACT path OauthService derived — the router's own
  // registered routes are the ultimate ground truth for "a path the Nest
  // router actually serves".
  it("STORY-023 · the redirect_uri POST /auth/oauth/:provider/start hands to the provider is a path the Nest router actually serves", async () => {
    const start = await startFlow("google");
    expect(start.statusCode).toBe(201);

    const authorizationUrl = new URL(start.authorizationUrl!);
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    expect(redirectUri, "start() must hand the provider a redirect_uri").toBeTruthy();
    const redirectPath = new URL(redirectUri!).pathname;

    // (1) — derived from API_VERSION_PREFIX via the same apiUrl() seam this
    // whole file already routes every real callback() call through.
    expect(redirectPath).toBe(apiUrl("/auth/oauth/google/callback"));

    // (2) — the router's own registered routes are the ultimate ground
    // truth: probing the EXACT path OauthService derived must not 404. No
    // query string is supplied, so a route that DOES exist still fails
    // downstream (missing state/code) — the only thing this proves is
    // whether the router recognizes the path shape at all.
    const probe = await app.inject({ method: "GET", url: redirectPath });
    expect(
      probe.statusCode,
      `the router returned 404 for the exact redirect_uri path OauthService constructed (${redirectPath}) — the provider would redirect the browser to a route this API does not serve`,
    ).not.toBe(404);
  });
});
