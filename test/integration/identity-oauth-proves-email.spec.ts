import { randomUUID } from "node:crypto";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { EMAIL_SENDER } from "../../src/modules/identity/ports/email-sender.js";
import { OAUTH_CLIENT, type OauthClient, type OauthIdentity } from "../../src/modules/identity/ports/oauth-client.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { apiUrl } from "../support/api-url.js";
import { eachRequestFromItsOwnClient } from "../support/distinct-source.js";
import { dataOf } from "../support/envelope.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../support/test-valkey.js";

// STORY-173 (audit follow-up) — the pre-hijack survived through OAuth. An
// attacker signed in with a provider that did NOT verify the victim's address;
// that created an `unverified` account with the attacker's credential attached,
// the owner's later email-code proof revoked it, and signing in again with the
// same provider identity quietly UN-revoked it. Dangerous area (identity):
// these tests were written against that behaviour first.
//
// Owner decisions, 2026-10-05, pinned below:
//   (1) a provider-UNVERIFIED sign-in binds no credential, creates no account,
//       mints no session — and says so honestly (403, details.reason =
//       email_not_verified) so the client can send the person to the email code;
//   (2) a provider-VERIFIED sign-in that meets an `unverified` row nobody has
//       proved CLAIMS it, as a first proof, in one transaction; a PROVED row is
//       never claimed (that would be auto-linking by email);
//   and, from the audit: the first-proof revocation is durable; a session is
//   minted in the transaction that decides who the user is; connecting or
//   disconnecting a provider needs a proved address and a fresh step-up.
vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>("@simplewebauthn/server");
  return { ...actual, verifyRegistrationResponse: vi.fn(), verifyAuthenticationResponse: vi.fn() };
});
const registrationMock = verifyRegistrationResponse as unknown as Mock;
const assertionMock = verifyAuthenticationResponse as unknown as Mock;

const CSRF_SECRET = "test-csrf-secret";
const BINDING = "__Host-nominara-oauth-binding";
type Cookies = { access: string; csrf: string };

class FakeOauth implements OauthClient {
  readonly byCode = new Map<string, OauthIdentity>();
  async generatePkce() {
    return { verifier: randomUUID(), challenge: randomUUID() };
  }
  authorizationUrl(input: { provider: string; redirectUri: string; state: string; codeChallenge: string }) {
    const url = new URL(`https://fake.example/${input.provider}`);
    url.searchParams.set("state", input.state);
    return url.toString();
  }
  async exchangeCode(input: { code: string }) {
    const identity = this.byCode.get(input.code);
    if (!identity) throw new Error("no identity");
    return identity;
  }
}

function credId(label: string): string {
  return Buffer.from(label, "utf8").toString("base64url");
}
function credentialResponse(id: string) {
  return {
    id,
    rawId: id,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: { clientDataJSON: "x", attestationObject: "y", authenticatorData: "z", signature: "s" },
  };
}
function cookiesOf(res: { cookies: Array<{ name: string; value: string }> }): Cookies | null {
  const byName = new Map(res.cookies.map((c) => [c.name, c.value]));
  const access = byName.get(ACCESS_COOKIE_NAME);
  const csrf = byName.get(CSRF_COOKIE_NAME);
  return access && csrf ? { access, csrf } : null;
}
function mutating(c: Cookies) {
  return { headers: { [CSRF_HEADER_NAME]: c.csrf }, cookies: { [ACCESS_COOKIE_NAME]: c.access, [CSRF_COOKIE_NAME]: c.csrf } };
}
function claimsOf(c: Cookies): { sub: string; sid: string } {
  return JSON.parse(Buffer.from(c.access.split(".")[1]!, "base64url").toString("utf8"));
}
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "request_id" && key !== "computed_at")
        .map(([key, v]) => [key, scrub(v)]),
    );
  }
  return value;
}

describe("STORY-173 · OAuth never binds an address nobody proved", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: NestFastifyApplication;
  let fake: FakeOauth;
  const sent: Array<{ to: string; textBody: string }> = [];
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
    Object.assign(process.env, {
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_RP_NAME: "Nominara",
      WEBAUTHN_ORIGIN: "http://localhost:3000",
      AUTH_TOKEN_ED25519_PRIVATE_KEY: "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1",
      AUTH_TOKEN_ED25519_PUBLIC_KEY: "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=",
      AUTH_TOKEN_ED25519_KID: "test-kid-1",
      CSRF_SECRET,
      WORKSPACE_DEK_WRAPPING_KEY: Buffer.alloc(32, 17).toString("base64"),
      OAUTH_REDIRECT_BASE_URL: "http://localhost:3000",
      OAUTH_STATE_SECRET: "test-oauth-state-secret",
      OTP_EMAIL_HASH_PEPPER: "test-otp-email-hash-pepper",
      OTP_EMAIL_FROM: "Nominara <no-reply@nominara.test>",
      VALKEY_CACHE_URL: testCacheRedisUrl(),
      QUEUE_REDIS_URL: testQueueRedisUrl(),
      ENGINE_TOKEN_BUCKETS:
        '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}',
      QUEUE_JOB_SIGNING_KEY: Buffer.alloc(32, 3).toString("base64"),
      QUEUE_JOB_SIGNING_KID: "test-queue-kid-1",
      DATABASE_URL: container.getConnectionUri(),
      GOOGLE_OAUTH_CLIENT_ID: "g",
      MICROSOFT_OAUTH_CLIENT_ID: "m",
      GITHUB_OAUTH_CLIENT_ID: "h",
    });
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    process.env.DATABASE_URL_POOLED = `postgres://nominara_app:${encodeURIComponent(password)}@${container.getHost()}:${container.getMappedPort(5432)}/${container.getDatabase()}`;

    registrationMock.mockReset();
    assertionMock.mockReset();
    sent.length = 0;
    fake = new FakeOauth();
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({
        send: async (message: { to: string; textBody: string }) => {
          sent.push(message);
        },
      })
      .overrideProvider(OAUTH_CLIENT)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    eachRequestFromItsOwnClient(app);
  }, 90_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await db.end();
  });

  // ---- helpers ------------------------------------------------------------

  /** Full OAuth round trip. `link` supplies the session that is connecting a provider. */
  async function oauth(provider: string, identity: OauthIdentity, opts: { link?: Cookies } = {}) {
    const path = opts.link ? `/auth/oauth/${provider}/link/start` : `/auth/oauth/${provider}/start`;
    const start = await app.inject({ method: "POST", url: apiUrl(path), ...(opts.link ? mutating(opts.link) : {}) });
    if (start.statusCode >= 400) return { status: start.statusCode, cookies: null, json: start.json() as Record<string, any> };
    const state = new URL(dataOf<{ authorization_url: string }>(start).authorization_url).searchParams.get("state")!;
    const binding = start.cookies.find((c) => c.name === BINDING)?.value;
    const code = randomUUID();
    fake.byCode.set(code, identity);
    const cookies: Record<string, string> = {
      ...(binding ? { [BINDING]: binding } : {}),
      ...(opts.link ? { [ACCESS_COOKIE_NAME]: opts.link.access } : {}),
    };
    const cb = await app.inject({
      method: "GET",
      url: apiUrl(`/auth/oauth/${provider}/callback?state=${encodeURIComponent(state)}&code=${code}`),
      cookies,
    });
    return { status: cb.statusCode, cookies: cookiesOf(cb), json: cb.json() as Record<string, any> };
  }

  async function mailTo(email: string, after: number): Promise<string> {
    for (let i = 0; i < 100; i += 1) {
      const message = sent.slice(after).find((m) => m.to === email.toLowerCase());
      if (message) return /\b(\d{8})\b/.exec(message.textBody)![1]!;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("no mail");
  }
  async function otpRequest(email: string) {
    const before = sent.length;
    const res = await app.inject({ method: "POST", url: apiUrl("/auth/otp/request"), payload: { email } });
    return { status: res.statusCode, code: () => mailTo(email, before) };
  }
  async function otpVerify(email: string, code: string) {
    const res = await app.inject({ method: "POST", url: apiUrl("/auth/otp/verify"), payload: { email, code } });
    return { status: res.statusCode, cookies: cookiesOf(res) };
  }
  async function otpSignIn(email: string): Promise<Cookies> {
    const requested = await otpRequest(email);
    const verified = await otpVerify(email, await requested.code());
    expect(verified.status).toBe(200);
    return verified.cookies!;
  }
  async function seedUser(options: { email?: string; verified?: boolean; status?: string } = {}) {
    const email = options.email ?? `u-${randomUUID()}@corp.example`;
    const result = await db.query<{ id: string }>(
      "INSERT INTO users (email, status, email_verified_at) VALUES ($1, $2, $3) RETURNING id",
      [email, options.status ?? "active", (options.verified ?? true) ? new Date() : null],
    );
    return { id: result.rows[0]!.id, email };
  }
  async function seedOauthCredential(userId: string, provider: string, subject: string): Promise<string> {
    const result = await db.query<{ id: string }>(
      "INSERT INTO user_credentials (user_id, kind, provider, external_subject) VALUES ($1, 'oauth', $2, $3) RETURNING id",
      [userId, provider, subject],
    );
    return result.rows[0]!.id;
  }
  async function credential(id: string) {
    return (await db.query("SELECT revoked_at, revoked_reason FROM user_credentials WHERE id = $1", [id])).rows[0]!;
  }
  async function sessionRow(sid: string) {
    return (await db.query("SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1", [sid])).rows[0]!;
  }
  async function counts() {
    return (
      await db.query<{ users: number; credentials: number; sessions: number }>(
        `SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM user_credentials)::int AS credentials,
                (SELECT count(*) FROM sessions)::int AS sessions`,
      )
    ).rows[0]!;
  }
  async function meStatus(c: Cookies): Promise<number> {
    return (await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: { [ACCESS_COOKIE_NAME]: c.access } })).statusCode;
  }
  async function statementsDuring<T>(fn: () => Promise<T>): Promise<{ statements: string[]; result: T }> {
    const statements: string[] = [];
    const proto = Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const raw = proto.query;
    const spy = vi.spyOn(proto, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      const first = args[0];
      const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
      if (text !== undefined && this !== db) statements.push(text.replace(/\s+/g, " ").trim());
      return raw.apply(this, args as never);
    });
    try {
      return { statements, result: await fn() };
    } finally {
      spy.mockRestore();
    }
  }
  async function passkeySignIn(label: string, counter: number) {
    const options = await app.inject({ method: "POST", url: apiUrl("/auth/passkey/options"), payload: { purpose: "assertion" } });
    assertionMock.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: counter, credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: dataOf<{ ceremony_id: string }>(options).ceremony_id, response: credentialResponse(credId(label)) },
    });
    return { status: res.statusCode, cookies: cookiesOf(res), json: res.json() as Record<string, any> };
  }
  async function addPasskey(c: Cookies, label: string) {
    const options = await app.inject({ method: "POST", url: apiUrl("/me/passkeys/options"), payload: {}, ...mutating(c) });
    if (options.statusCode !== 201) return { status: options.statusCode, json: options.json() as Record<string, any> };
    registrationMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: credId(label), publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    const verified = await app.inject({
      method: "POST",
      url: apiUrl("/me/passkeys/verify"),
      payload: { ceremony_id: dataOf<{ ceremony_id: string }>(options).ceremony_id, response: credentialResponse(credId(label)) },
      ...mutating(c),
    });
    return { status: verified.statusCode, json: verified.json() as Record<string, any> };
  }

  // ---- decision (1): refuse an unverified provider ----------------------------

  it("STORY-173 · OAuth-1 — a provider that did NOT verify the address binds nothing, creates nothing and mints nothing", async () => {
    const before = await counts();
    const res = await oauth("microsoft", { externalSubject: "ms-planter", email: "victim@corp.example", emailVerified: false });

    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("forbidden");
    expect(res.json.error.details.reason).toBe("email_not_verified");
    expect(res.json.error.message).toMatch(/email code/i);
    expect(res.json.error.message).not.toContain("victim@corp.example");
    expect(res.cookies).toBeNull();
    expect(await counts()).toEqual(before);
  });

  it("STORY-173 · OAuth-1 — the refusal is identical whether or not an account exists for the address", async () => {
    const existing = await seedUser({ email: "exists@corp.example" });
    const known = await statementsDuring(() =>
      oauth("microsoft", { externalSubject: "ms-a", email: existing.email, emailVerified: false }),
    );
    const unknown = await statementsDuring(() =>
      oauth("microsoft", { externalSubject: "ms-b", email: "nobody@corp.example", emailVerified: false }),
    );
    expect(known.result.status).toBe(unknown.result.status);
    expect(scrub(known.result.json)).toEqual(scrub(unknown.result.json));
    expect(known.statements).toEqual(unknown.statements);
  });

  it("STORY-173 · OAuth-1 — an unverified provider with NO email is still the neutral oauth_failed, not the email refusal", async () => {
    const res = await oauth("github", { externalSubject: "gh-no-email", email: null, emailVerified: false });
    expect(res.status).toBe(400);
    expect(res.json.error.details.reason).toBe("oauth_failed");
  });

  // ---- BLOCKER-1: the first-proof revocation is durable (auditor Y3, Y4) -------------

  it("STORY-173 · BLOCKER-1 — a credential revoked by the first proof is not brought back by signing in again (Y3)", async () => {
    // A row from before the fix: an unproved address with the planter's OAuth
    // credential and a live session.
    const target = `victim-${randomUUID()}@corp.example`;
    const planted = await seedUser({ email: target, verified: false, status: "unverified" });
    const credentialId = await seedOauthCredential(planted.id, "microsoft", "ms-planter");
    const plantedSession = await app.get(SessionService).createSession(planted.id);

    await otpSignIn(target); // the owner proves the address

    expect(await credential(credentialId)).toMatchObject({ revoked_reason: "address_proved" });
    expect((await credential(credentialId)).revoked_at).not.toBeNull();
    expect((await sessionRow(plantedSession.sid)).revoked_at).not.toBeNull();
    const sessionsBefore = (await counts()).sessions;

    const again = await oauth("microsoft", { externalSubject: "ms-planter", email: target, emailVerified: false });
    expect(again.status).not.toBe(200);
    expect(again.cookies).toBeNull();
    const verified = await oauth("microsoft", { externalSubject: "ms-planter", email: target, emailVerified: true });
    expect(verified.status).not.toBe(200);
    expect(verified.cookies).toBeNull();
    expect((await credential(credentialId)).revoked_at).not.toBeNull();
    expect((await counts()).sessions).toBe(sessionsBefore);
  });

  it("STORY-173 · BLOCKER-1 — a credential a person unlinked themselves IS reactivated by signing in (the old behaviour, kept)", async () => {
    const user = await seedUser();
    const credentialId = await seedOauthCredential(user.id, "google", "g-mine");
    await db.query("UPDATE user_credentials SET revoked_at = now(), revoked_reason = 'user' WHERE id = $1", [credentialId]);
    const res = await oauth("google", { externalSubject: "g-mine", email: user.email, emailVerified: true });
    expect(res.status).toBe(200);
    expect(await credential(credentialId)).toEqual({ revoked_at: null, revoked_reason: null });
  });

  it("STORY-173 · BLOCKER-1 — a LEGACY revoked credential (no reason recorded) is reactivated as before", async () => {
    const user = await seedUser();
    const credentialId = await seedOauthCredential(user.id, "google", "g-legacy");
    await db.query("UPDATE user_credentials SET revoked_at = now() WHERE id = $1", [credentialId]);
    const res = await oauth("google", { externalSubject: "g-legacy", email: user.email, emailVerified: true });
    expect(res.status).toBe(200);
  });

  it("STORY-173 · BLOCKER-1 — a credential on an account whose address was never proved yields no session", async () => {
    const legacy = await seedUser({ verified: false, status: "unverified" });
    await seedOauthCredential(legacy.id, "microsoft", "ms-legacy");
    const before = await counts();
    const res = await oauth("microsoft", { externalSubject: "ms-legacy", email: legacy.email, emailVerified: false });
    expect(res.status).toBe(403);
    expect(res.json.error.details.reason).toBe("email_not_verified");
    expect(res.cookies).toBeNull();
    expect(await counts()).toEqual(before);
  });

  it("STORY-173 · BLOCKER-1 — a suspended account gets no OAuth session", async () => {
    const user = await seedUser({ status: "suspended" });
    await seedOauthCredential(user.id, "google", "g-susp");
    const res = await oauth("google", { externalSubject: "g-susp", email: user.email, emailVerified: true });
    expect(res.status).toBe(400);
    expect(res.cookies).toBeNull();
  });

  it("STORY-173 · BLOCKER-1 — an unproved session cannot link a provider, so nothing survives the first proof through a link (Y4)", async () => {
    const target = `victim2-${randomUUID()}@corp.example`;
    const planted = await seedUser({ email: target, verified: false, status: "unverified" });
    const session = await app.get(SessionService).createSession(planted.id, new Date(), "email_otp");
    const link = await oauth("google", { externalSubject: "g-attacker", email: "attacker@gmail.example", emailVerified: true }, {
      link: { access: session.accessToken, csrf: session.csrfToken },
    });
    expect(link.status).toBe(403);
    expect(link.json.error.details.reason).toBe("email_not_verified");
    expect((await db.query("SELECT 1 FROM user_credentials WHERE external_subject = 'g-attacker'")).rows).toHaveLength(0);
  });

  // ---- MAJOR-1: the session is minted in the deciding transaction (Y5) ------------------

  it("STORY-173 · MAJOR-1 — an OAuth sign-in mints its session inside the transaction that resolves the account (Y5)", async () => {
    const user = await seedUser();
    await seedOauthCredential(user.id, "google", "g-tx");
    const { statements } = await statementsDuring(() =>
      oauth("google", { externalSubject: "g-tx", email: user.email, emailVerified: true }),
    );
    const begin = statements.indexOf("BEGIN");
    const insert = statements.findIndex((s) => s.startsWith("INSERT INTO sessions"));
    const commit = statements.indexOf("COMMIT", begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(insert);
  });

  it("STORY-173 · MAJOR-1 — a link mints its session inside the transaction that adds the credential", async () => {
    const user = await seedUser();
    const owner = await otpSignIn(user.email);
    const { statements } = await statementsDuring(() =>
      oauth("google", { externalSubject: "g-link-tx", email: "x@gmail.example", emailVerified: true }, { link: owner }),
    );
    const insertCredential = statements.findIndex((s) => s.startsWith("INSERT INTO user_credentials"));
    const insertSession = statements.findIndex((s) => s.startsWith("INSERT INTO sessions"));
    const commit = statements.indexOf("COMMIT", insertCredential);
    expect(insertCredential).toBeGreaterThanOrEqual(0);
    expect(insertSession).toBeGreaterThan(insertCredential);
    expect(commit).toBeGreaterThan(insertSession);
  });

  it("STORY-173 · MAJOR-1 — a passkey sign-in mints its session inside the transaction that re-checks the credential", async () => {
    const user = await seedUser();
    await db.query(
      "INSERT INTO user_credentials (user_id, kind, credential_id, public_key, sign_count) VALUES ($1, 'passkey', $2, $3, 0)",
      [user.id, Buffer.from(credId("tx-key"), "base64url"), Buffer.from([1, 2, 3])],
    );
    const { statements } = await statementsDuring(() => passkeySignIn("tx-key", 1));
    const insertSession = statements.findIndex((s) => s.startsWith("INSERT INTO sessions"));
    const begin = statements.lastIndexOf("BEGIN", insertSession);
    const commit = statements.indexOf("COMMIT", insertSession);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(insertSession);
    expect(statements.slice(begin, insertSession).some((s) => s.includes("FROM users") && s.includes("FOR SHARE"))).toBe(true);
  });

  // ---- MAJOR-2: connecting or disconnecting needs a proved address and a step-up (Y10) --

  it("STORY-173 · MAJOR-2 — a stolen, stale session of a PROVED account cannot link the thief's own provider (Y10)", async () => {
    const victim = await seedUser();
    const cookies = await otpSignIn(victim.email);
    await db.query("UPDATE sessions SET last_strong_auth_at = now() - interval '2 days' WHERE id = $1", [claimsOf(cookies).sid]);

    const link = await oauth("google", { externalSubject: "g-thief", email: "thief@gmail.example", emailVerified: true }, { link: cookies });
    expect(link.status).toBe(401);
    expect(link.json.error.code).toBe("step_up_required");
    expect((await db.query("SELECT 1 FROM user_credentials WHERE external_subject = 'g-thief'")).rows).toHaveLength(0);
    // The thief can still sign up for THEIR OWN address, but never as the victim.
    const later = await oauth("google", { externalSubject: "g-thief", email: "thief@gmail.example", emailVerified: true });
    expect(later.status).toBe(200);
    expect(claimsOf(later.cookies!).sub).not.toBe(victim.id);
  });

  it("STORY-173 · MAJOR-2 — a session with no strong authentication at all (an OAuth session) cannot link either", async () => {
    const user = await seedUser();
    const session = await app.get(SessionService).createSession(user.id);
    const link = await oauth("github", { externalSubject: "gh-x", email: "x@example.com", emailVerified: true }, {
      link: { access: session.accessToken, csrf: session.csrfToken },
    });
    expect(link.status).toBe(401);
    expect(link.json.error.code).toBe("step_up_required");
  });

  it("STORY-173 · MAJOR-2 — a proved, freshly authenticated account links a provider and signs in with it", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    const link = await oauth("google", { externalSubject: "g-owner", email: "owner@gmail.example", emailVerified: true }, { link: cookies });
    expect(link.status).toBe(200);
    expect(link.json.data.outcome).toBe("linked");
    const signedIn = await oauth("google", { externalSubject: "g-owner", email: "owner@gmail.example", emailVerified: true });
    expect(signedIn.status).toBe(200);
    expect(claimsOf(signedIn.cookies!).sub).toBe(user.id);
  });

  it("STORY-173 · MAJOR-2 — the step-up is checked again at the callback, after the time spent at the provider", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    const start = await app.inject({ method: "POST", url: apiUrl("/auth/oauth/google/link/start"), ...mutating(cookies) });
    expect(start.statusCode).toBe(201);
    await db.query("UPDATE sessions SET last_strong_auth_at = now() - interval '6 minutes' WHERE id = $1", [claimsOf(cookies).sid]);
    const state = new URL(dataOf<{ authorization_url: string }>(start).authorization_url).searchParams.get("state")!;
    const code = randomUUID();
    fake.byCode.set(code, { externalSubject: "g-slow", email: "slow@gmail.example", emailVerified: true });
    const cb = await app.inject({
      method: "GET",
      url: apiUrl(`/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=${code}`),
      cookies: { [BINDING]: start.cookies.find((c) => c.name === BINDING)!.value, [ACCESS_COOKIE_NAME]: cookies.access },
    });
    expect(cb.statusCode).toBe(401);
    expect(cb.json().error.code).toBe("step_up_required");
    expect((await db.query("SELECT 1 FROM user_credentials WHERE external_subject = 'g-slow'")).rows).toHaveLength(0);
  });

  it("STORY-173 · MAJOR-2 — disconnecting a provider needs a fresh step-up", async () => {
    const user = await seedUser();
    await seedOauthCredential(user.id, "google", "g-keep");
    await db.query(
      "INSERT INTO user_credentials (user_id, kind, credential_id, public_key, sign_count) VALUES ($1, 'passkey', $2, $3, 0)",
      [user.id, Buffer.from(credId("other-method"), "base64url"), Buffer.from([1])],
    );
    const stale = await app.get(SessionService).createSession(user.id);
    const refused = await app.inject({
      method: "DELETE",
      url: apiUrl("/me/oauth/google"),
      ...mutating({ access: stale.accessToken, csrf: stale.csrfToken }),
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe("step_up_required");
    expect((await db.query("SELECT 1 FROM user_credentials WHERE external_subject = 'g-keep' AND revoked_at IS NULL")).rows).toHaveLength(1);

    const fresh = await otpSignIn(user.email);
    const ok = await app.inject({ method: "DELETE", url: apiUrl("/me/oauth/google"), ...mutating(fresh) });
    expect(ok.statusCode).toBe(200);
    expect((await db.query("SELECT revoked_reason FROM user_credentials WHERE external_subject = 'g-keep'")).rows[0].revoked_reason).toBe("user");
  });

  // ---- decision (2): claim an unproved row, never a proved one ----------------------------

  it("STORY-173 · MAJOR-3 — an OTP-squatted address no longer blocks a provider-verified sign-up (Y8)", async () => {
    const target = `squat-${randomUUID()}@corp.example`;
    await otpRequest(target); // the squatter creates the row and cannot read the code
    const squatted = (await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [target])).rows[0]!.id;

    const res = await oauth("google", { externalSubject: "g-real-owner", email: target, emailVerified: true });
    expect(res.status).toBe(200);
    expect(claimsOf(res.cookies!).sub).toBe(squatted);
    const row = (await db.query("SELECT status, email_verified_at FROM users WHERE id = $1", [squatted])).rows[0];
    expect(row.status).toBe("active");
    expect(row.email_verified_at).not.toBeNull();
    expect((await db.query("SELECT user_id FROM user_credentials WHERE external_subject = 'g-real-owner'")).rows).toEqual([
      { user_id: squatted },
    ]);
    expect((await db.query("SELECT count(*)::int AS n FROM users WHERE email = $1", [target])).rows[0].n).toBe(1);
  });

  it("STORY-173 · MAJOR-3 — claiming an unproved row is a first proof: what predates it is revoked, durably, in the same transaction", async () => {
    const target = `claim-${randomUUID()}@corp.example`;
    const legacy = await seedUser({ email: target, verified: false, status: "active" });
    await db.query(
      "INSERT INTO user_credentials (user_id, kind, credential_id, public_key, sign_count) VALUES ($1, 'passkey', $2, $3, 0)",
      [legacy.id, Buffer.from(credId("attackers-key"), "base64url"), Buffer.from([1])],
    );
    const attackerOauth = await seedOauthCredential(legacy.id, "microsoft", "ms-attacker");
    const attackerSession = await app.get(SessionService).createSession(legacy.id);

    const { statements, result } = await statementsDuring(() =>
      oauth("google", { externalSubject: "g-owner-claims", email: target, emailVerified: true }),
    );
    expect(result.status).toBe(200);

    expect((await db.query("SELECT revoked_reason FROM user_credentials WHERE credential_id = $1", [Buffer.from(credId("attackers-key"), "base64url")])).rows[0]).toEqual({
      revoked_reason: "address_proved",
    });
    expect(await credential(attackerOauth)).toMatchObject({ revoked_reason: "address_proved" });
    expect((await sessionRow(attackerSession.sid)).revoked_reason).toBe("address_proved");
    expect(await passkeySignIn("attackers-key", 1).then((r) => r.status)).toBe(400);
    expect((await oauth("microsoft", { externalSubject: "ms-attacker", email: target, emailVerified: true })).status).not.toBe(200);
    expect(await meStatus(result.cookies!)).toBe(200);

    // one transaction: lock, revoke, proof, credential, session, commit
    const begin = statements.indexOf("BEGIN");
    const commit = statements.indexOf("COMMIT", begin);
    const between = statements.slice(begin, commit);
    for (const needle of ["FOR UPDATE", "UPDATE user_credentials SET revoked_at", "UPDATE sessions SET revoked_at", "INSERT INTO user_credentials", "INSERT INTO sessions"]) {
      expect(between.some((s) => s.includes(needle)), needle).toBe(true);
    }
  });

  it("STORY-173 · MAJOR-3 — a PROVED row is never claimed: that is auto-linking by email, and stays email_collision", async () => {
    const owner = await seedUser({ email: "proved@corp.example" });
    const credentialsBefore = (await counts()).credentials;
    const res = await oauth("google", { externalSubject: "g-other-subject", email: owner.email, emailVerified: true });
    expect(res.status).toBe(400);
    expect(res.json.error.details.reason).toBe("oauth_failed");
    expect(res.cookies).toBeNull();
    expect((await counts()).credentials).toBe(credentialsBefore);
  });

  it("STORY-173 · MAJOR-3 — a SUSPENDED unproved row is not claimed either", async () => {
    const suspended = await seedUser({ email: "susp-unproved@corp.example", verified: false, status: "suspended" });
    const res = await oauth("google", { externalSubject: "g-claim-susp", email: suspended.email, emailVerified: true });
    expect(res.status).toBe(400);
    expect((await db.query("SELECT status, email_verified_at FROM users WHERE id = $1", [suspended.id])).rows[0]).toMatchObject({
      status: "suspended",
      email_verified_at: null,
    });
  });

  it("STORY-173 · OAuth — a provider-verified sign-up for a brand-new address still creates an active, proved account", async () => {
    const res = await oauth("google", { externalSubject: "g-new", email: "brand.new@corp.example", emailVerified: true });
    expect(res.status).toBe(200);
    expect(res.json.data.user_status).toBe("active");
    const row = (await db.query("SELECT status, email_verified_at FROM users WHERE email = 'brand.new@corp.example'")).rows[0];
    expect(row.status).toBe("active");
    expect(row.email_verified_at).not.toBeNull();
  });

  // ---- MINOR-1: suspended and erased accounts do not sign in with a passkey (Y7) -------------

  it("STORY-173 · MINOR-1 — a suspended account's passkey yields no session (Y7)", async () => {
    const user = await seedUser();
    await db.query(
      "INSERT INTO user_credentials (user_id, kind, credential_id, public_key, sign_count) VALUES ($1, 'passkey', $2, $3, 0)",
      [user.id, Buffer.from(credId("k-susp"), "base64url"), Buffer.from([1])],
    );
    await db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [user.id]);
    const res = await passkeySignIn("k-susp", 1);
    expect(res.status).toBe(400);
    expect(res.cookies).toBeNull();
  });

  it("STORY-173 · MINOR-1 — an erased account's passkey yields no session (Y7)", async () => {
    const user = await seedUser();
    await db.query(
      "INSERT INTO user_credentials (user_id, kind, credential_id, public_key, sign_count) VALUES ($1, 'passkey', $2, $3, 0)",
      [user.id, Buffer.from(credId("k-del"), "base64url"), Buffer.from([1])],
    );
    await db.query(
      "UPDATE users SET status = 'deleted', deleted_at = now(), email = 'deleted+' || id || '@nominara.invalid' WHERE id = $1",
      [user.id],
    );
    const res = await passkeySignIn("k-del", 1);
    expect(res.status).toBe(400);
    expect(res.cookies).toBeNull();
  });

  // ---- MINOR-2: a duplicate credential id is the uniform 400 (Y6) ---------------------------

  it("STORY-173 · MINOR-2 — a credential id already registered to another account is the uniform 400, never a 500 (Y6)", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const first = await addPasskey(await otpSignIn(a.email), "same-id");
    expect(first.status).toBe(200);
    const second = await addPasskey(await otpSignIn(b.email), "same-id");
    expect(second.status).toBe(400);

    // The same body as a plainly bad attestation: nothing says the id exists.
    registrationMock.mockResolvedValue({ verified: false });
    const cookies = await otpSignIn(b.email);
    const options = await app.inject({ method: "POST", url: apiUrl("/me/passkeys/options"), payload: {}, ...mutating(cookies) });
    const bad = await app.inject({
      method: "POST",
      url: apiUrl("/me/passkeys/verify"),
      payload: { ceremony_id: dataOf<{ ceremony_id: string }>(options).ceremony_id, response: credentialResponse(credId("whatever")) },
      ...mutating(cookies),
    });
    expect(scrub(second.json)).toEqual(scrub(bad.json()));
    expect((await db.query("SELECT 1 FROM user_credentials WHERE user_id = $1 AND kind = 'passkey'", [b.id])).rows).toHaveLength(0);
  });

  it("STORY-173 · MINOR-2 — the same account registering the same credential id twice is also the 400", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    expect((await addPasskey(cookies, "twice")).status).toBe(200);
    expect((await addPasskey(cookies, "twice")).status).toBe(400);
  });

  // ---- MINOR-4: the proof is pinned while the credential is written ------------------------------

  it("STORY-173 · MINOR-4 — the proof of the address cannot be withdrawn between the check and the credential insert (FOR SHARE)", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    const options = await app.inject({ method: "POST", url: apiUrl("/me/passkeys/options"), payload: {}, ...mutating(cookies) });
    registrationMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: credId("pinned"), publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });

    const proto = Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const raw = proto.query;
    let withdrawal: Promise<unknown> | null = null;
    let withdrawalDone = false;
    let doneWhenInsertRuns: boolean | null = null;
    vi.spyOn(proto, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      const text = typeof args[0] === "string" ? args[0] : undefined;
      if (text?.startsWith("INSERT INTO user_credentials") && withdrawal === null && this !== db) {
        // The proof check has run and its transaction is open. Try to withdraw
        // the proof from outside, and give it time to complete if it can.
        const other = new Client({ connectionString: container.getConnectionUri() });
        withdrawal = other
          .connect()
          .then(() => other.query("UPDATE users SET email_verified_at = NULL WHERE id = $1", [user.id]))
          .then(() => {
            withdrawalDone = true;
          })
          .finally(() => other.end());
        return new Promise((resolve) => {
          setTimeout(() => {
            doneWhenInsertRuns = withdrawalDone;
            resolve(raw.apply(this, args as never));
          }, 500);
        });
      }
      return raw.apply(this, args as never);
    });

    const res = await app.inject({
      method: "POST",
      url: apiUrl("/me/passkeys/verify"),
      payload: { ceremony_id: dataOf<{ ceremony_id: string }>(options).ceremony_id, response: credentialResponse(credId("pinned")) },
      ...mutating(cookies),
    });
    await withdrawal;
    expect(res.statusCode).toBe(200);
    // While the credential was being written the proof was still pinned: the
    // withdrawal had not been able to complete.
    expect(doneWhenInsertRuns).toBe(false);
  });
});
