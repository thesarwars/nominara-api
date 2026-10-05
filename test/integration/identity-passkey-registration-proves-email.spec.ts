import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
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
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, REFRESH_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { computeCsrfToken } from "../../src/lib/auth/csrf.js";
import { EMAIL_SENDER } from "../../src/modules/identity/ports/email-sender.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { apiUrl } from "../support/api-url.js";
import { eachRequestFromItsOwnClient } from "../support/distinct-source.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../support/test-valkey.js";
import { dataOf } from "../support/envelope.js";

// STORY-173 — an anonymous caller could bind their own passkey to ANY existing
// account and receive a session for it: POST /auth/passkey/options (public)
// found-or-created the users row for the typed address and returned the
// EXISTING user's id, and POST /auth/passkey/verify (public) inserted the
// caller's credential for that id, promoted unverified -> active, and minted a
// session. Dangerous area (identity): written failing-first against that code.
//
// What these tests pin, from the hazard rather than from the fix:
//   - no anonymous request ever yields a credential or session for an address
//     whose control nobody has proved;
//   - an existing account's row is never touched by an anonymous request (not
//     its credentials, not its status, not even the casing of its address);
//   - the anonymous surface answers identically whether or not the address
//     has an account — asserted on the SQL statements issued, not on latency;
//   - `status = 'active'` is only ever reached with email_verified_at set.
//
// @simplewebauthn/server's verify* functions are mocked (STORY-014: a ceremony
// is never hand-verified); the API pool connects as the real runtime role so
// the new statements are proven against its actual grants.
vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>("@simplewebauthn/server");
  return { ...actual, verifyRegistrationResponse: vi.fn(), verifyAuthenticationResponse: vi.fn() };
});
const registrationMock = verifyRegistrationResponse as unknown as Mock;
const assertionMock = verifyAuthenticationResponse as unknown as Mock;

const CSRF_SECRET = "test-csrf-secret";

interface Cookies {
  access: string;
  csrf: string;
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

function mockRegistration(id: string): void {
  registrationMock.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0 },
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
}

function mockAssertion(newCounter: number): void {
  assertionMock.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter, credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
}

function cookiesOf(res: { cookies: Array<{ name: string; value: string }> }): Cookies {
  const byName = new Map(res.cookies.map((c) => [c.name, c.value]));
  return { access: byName.get(ACCESS_COOKIE_NAME)!, csrf: byName.get(CSRF_COOKIE_NAME)! };
}

function mutating(c: Cookies): { headers: Record<string, string>; cookies: Record<string, string> } {
  return {
    headers: { [CSRF_HEADER_NAME]: c.csrf },
    cookies: { [ACCESS_COOKIE_NAME]: c.access, [CSRF_COOKIE_NAME]: c.csrf },
  };
}

function claimsOf(c: Cookies): { sub: string; sid: string } {
  return JSON.parse(Buffer.from(c.access.split(".")[1]!, "base64url").toString("utf8"));
}

/** Removes the per-request identifier so two responses to different requests can be compared byte for byte. */
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

const VOLATILE_HEADERS = new Set(["date", "x-request-id", "content-length", "ratelimit-remaining", "x-ratelimit-remaining"]);
function stableHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !VOLATILE_HEADERS.has(key)));
}

describe("STORY-173 · passkey registration proves the address", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };
  const sent: Array<{ to: string; textBody: string }> = [];

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
      // STORY-174 — the run's own throwaway Valkey containers, never a developer's.
      VALKEY_CACHE_URL: testCacheRedisUrl(),
      QUEUE_REDIS_URL: testQueueRedisUrl(),
      ENGINE_TOKEN_BUCKETS:
        '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}',
      QUEUE_JOB_SIGNING_KEY: Buffer.alloc(32, 3).toString("base64"),
      QUEUE_JOB_SIGNING_KID: "test-queue-kid-1",
      DATABASE_URL: container.getConnectionUri(),
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
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue({
        send: async (message: { to: string; textBody: string }) => {
          sent.push(message);
        },
      })
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

  async function seedUser(options: {
    email?: string;
    status?: "active" | "unverified";
    verified?: boolean;
  } = {}): Promise<{ id: string; email: string }> {
    const email = options.email ?? `u-${randomUUID()}@example.com`;
    const verified = options.verified ?? true;
    const result = await db.query<{ id: string }>(
      `INSERT INTO users (email, status, email_verified_at) VALUES ($1, $2, $3) RETURNING id`,
      [email, options.status ?? "active", verified ? new Date() : null],
    );
    return { id: result.rows[0]!.id, email };
  }

  async function seedPasskey(userId: string, label: string): Promise<void> {
    await db.query(
      `INSERT INTO user_credentials (user_id, kind, credential_id, public_key, sign_count)
       VALUES ($1, 'passkey', $2, $3, 0)`,
      [userId, Buffer.from(credId(label), "base64url"), Buffer.from([9, 9, 9])],
    );
  }

  async function mailTo(email: string, after: number): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const message = sent.slice(after).find((m) => m.to === email.trim().toLowerCase());
      if (message) return message.textBody;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no code was mailed to ${email}`);
  }

  async function requestCode(email: string) {
    return app.inject({ method: "POST", url: apiUrl("/auth/otp/request"), payload: { email } });
  }

  /** The real email-OTP sign-in: request, read the mailed code, verify. */
  async function otpSignIn(email: string): Promise<Cookies> {
    const before = sent.length;
    const requested = await requestCode(email);
    expect(requested.statusCode).toBeLessThan(300);
    const code = /\b(\d{8})\b/.exec(await mailTo(email, before))![1]!;
    const verified = await app.inject({ method: "POST", url: apiUrl("/auth/otp/verify"), payload: { email, code } });
    expect(verified.statusCode).toBe(200);
    return cookiesOf(verified);
  }

  async function addPasskeyOptions(cookies: Cookies | null, body: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: apiUrl("/me/passkeys/options"),
      payload: body,
      ...(cookies ? mutating(cookies) : {}),
    });
  }

  async function addPasskeyVerify(cookies: Cookies | null, ceremonyId: string, label: string) {
    mockRegistration(credId(label));
    return app.inject({
      method: "POST",
      url: apiUrl("/me/passkeys/verify"),
      payload: { ceremony_id: ceremonyId, response: credentialResponse(credId(label)) },
      ...(cookies ? mutating(cookies) : {}),
    });
  }

  /** options + verify, expecting success. */
  async function addPasskey(cookies: Cookies, label: string): Promise<void> {
    const options = await addPasskeyOptions(cookies);
    expect(options.statusCode).toBe(201);
    const verified = await addPasskeyVerify(cookies, dataOf<{ ceremony_id: string }>(options).ceremony_id, label);
    expect(verified.statusCode).toBe(200);
  }

  async function passkeySignIn(label: string, counter = 1) {
    const options = await app.inject({ method: "POST", url: apiUrl("/auth/passkey/options"), payload: { purpose: "assertion" } });
    expect(options.statusCode).toBe(201);
    mockAssertion(counter);
    return app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: dataOf<{ ceremony_id: string }>(options).ceremony_id, response: credentialResponse(credId(label)) },
    });
  }

  async function anonymousRegistrationOptions(email: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "registration", email, ...extra },
    });
  }

  async function counts(): Promise<{ users: number; credentials: number; sessions: number; challenges: number }> {
    const result = await db.query<{ users: number; credentials: number; sessions: number; challenges: number }>(
      `SELECT (SELECT count(*) FROM users)::int AS users,
              (SELECT count(*) FROM user_credentials)::int AS credentials,
              (SELECT count(*) FROM sessions)::int AS sessions,
              (SELECT count(*) FROM webauthn_challenges)::int AS challenges`,
    );
    return result.rows[0]!;
  }

  /** Every SQL statement issued by the application pool while `fn` runs, whitespace-normalised, parameters excluded. */
  async function statementsDuring<T>(fn: () => Promise<T>): Promise<{ statements: string[]; result: T }> {
    const statements: string[] = [];
    const proto = Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const raw = proto.query;
    const spy = vi.spyOn(proto, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      const first = args[0];
      const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
      // The test's own `db` client is a separate Client; only the app's traffic counts.
      if (text !== undefined && this !== db) statements.push(text.replace(/\s+/g, " ").trim());
      return raw.apply(this, args as never);
    });
    try {
      const result = await fn();
      return { statements, result };
    } finally {
      spy.mockRestore();
    }
  }

  // ---- AC1 · the takeover (auditor repro X1) --------------------------------

  it("STORY-173 · AC1 — an anonymous caller cannot bind a passkey to an existing verified account (X1)", async () => {
    const victim = await seedUser({ email: "victim@corp.example" });
    await seedPasskey(victim.id, "victims-own-key");
    const before = await counts();

    const options = await anonymousRegistrationOptions(victim.email);
    expect(options.statusCode).toBe(400);

    // The attacker has no ceremony to complete; even a fabricated one gets nothing.
    mockRegistration(credId("attacker-key"));
    const verify = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: randomUUID(), response: credentialResponse(credId("attacker-key")) },
    });
    expect(verify.statusCode).toBe(400);
    expect(verify.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)).toBeUndefined();

    expect(await counts()).toEqual(before);
    const credentials = await db.query("SELECT id FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL", [victim.id]);
    expect(credentials.rows).toHaveLength(1);
  });

  it("STORY-173 · AC1 — a registration ceremony can never be completed at the anonymous verify route", async () => {
    // The anonymous route no longer starts a registration, but a ceremony row
    // minted for an account (by the authenticated route) must not be
    // redeemable there either: a leaked ceremony id is a bearer token.
    const owner = await seedUser();
    const cookies = await otpSignIn(owner.email);
    const options = await addPasskeyOptions(cookies);
    expect(options.statusCode).toBe(201);
    const ceremonyId = dataOf<{ ceremony_id: string }>(options).ceremony_id;
    const sessionsBefore = (await counts()).sessions;

    mockRegistration(credId("stolen-ceremony"));
    const anonymous = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: ceremonyId, response: credentialResponse(credId("stolen-ceremony")) },
    });
    expect(anonymous.statusCode).toBe(400);
    expect(anonymous.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)).toBeUndefined();
    expect((await counts()).sessions).toBe(sessionsBefore);
    const credential = await db.query("SELECT id FROM user_credentials WHERE credential_id = $1", [
      Buffer.from(credId("stolen-ceremony"), "base64url"),
    ]);
    expect(credential.rows).toHaveLength(0);

    // ... and the refusal did not consume the owner's ceremony.
    const completed = await addPasskeyVerify(cookies, ceremonyId, "owners-key");
    expect(completed.statusCode).toBe(200);
  });

  it("STORY-173 · AC1 — the public verify route refuses a ceremony of the wrong purpose and does not consume it", async () => {
    // A registration-purpose row with no owner is unreachable through the API
    // today; the claim must still key on purpose, so a future code path that
    // produced one could never be redeemed as a sign-in.
    const ceremony = randomUUID();
    await db.query(
      `INSERT INTO webauthn_challenges (id, purpose, user_id, challenge, rp_id, origin, expires_at)
       VALUES ($1, 'registration', NULL, $2, 'localhost', 'http://localhost:3000', now() + interval '5 minutes')`,
      [ceremony, Buffer.from("c")],
    );
    const res = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: ceremony, response: credentialResponse(credId("anything")) },
    });
    expect(res.statusCode).toBe(400);
    const row = await db.query("SELECT consumed_at FROM webauthn_challenges WHERE id = $1", [ceremony]);
    expect(row.rows[0].consumed_at).toBeNull();
  });

  // ---- AC2 · uniform anonymous surface ---------------------------------------

  it("STORY-173 · AC2 — anonymous registration is the same refusal, with the same statements, for an existing and a new address", async () => {
    const existing = await seedUser({ email: "exists@corp.example" });
    const fresh = "nobody-has-this@corp.example";
    const before = await counts();

    const known = await statementsDuring(() => anonymousRegistrationOptions(existing.email));
    const unknown = await statementsDuring(() => anonymousRegistrationOptions(fresh));

    expect(known.result.statusCode).toBe(unknown.result.statusCode);
    expect(known.result.statusCode).toBe(400);
    expect(scrub(known.result.json())).toEqual(scrub(unknown.result.json()));
    expect(stableHeaders(known.result.headers)).toEqual(stableHeaders(unknown.result.headers));
    expect(known.statements).toEqual(unknown.statements);
    // The refusal is decided before any account lookup: nothing about the
    // address can reach a query, so nothing can differ between the two.
    expect(known.statements.filter((s) => /users|user_credentials|webauthn_challenges/.test(s))).toEqual([]);
    expect(await counts()).toEqual(before);
  });

  it("STORY-173 · AC2 — an OTP request is the same response, status and statements for an existing and a new address", async () => {
    const existing = await seedUser({ email: "known@corp.example" });
    const fresh = "brand-new@corp.example";

    const sentBefore = sent.length;
    const known = await statementsDuring(() => requestCode(existing.email));
    const unknown = await statementsDuring(() => requestCode(fresh));

    expect(known.result.statusCode).toBe(unknown.result.statusCode);
    expect(scrub(known.result.json())).toEqual(scrub(unknown.result.json()));
    expect(stableHeaders(known.result.headers)).toEqual(stableHeaders(unknown.result.headers));
    // Same work, in the same order — including the account lookup and the
    // code write: an unknown address no longer takes a different branch.
    expect(known.statements).toEqual(unknown.statements);

    // Both addresses receive a code (the old unknown-address branch mailed nothing).
    await mailTo(existing.email, sentBefore);
    await mailTo(fresh, sentBefore);
  });

  it("STORY-173 · MINOR-E — an account removed between the lookup and the code insert (the sweep, racing) is the same uniform response, not a 500 (Z16)", async () => {
    const address = "swept-mid-request@corp.example";
    await seedUser({ email: address, verified: false, status: "unverified" });
    const baseline = await requestCode("baseline-uniform@corp.example");

    const proto = Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const raw = proto.query;
    let removed = false;
    vi.spyOn(proto, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
      const text = typeof args[0] === "string" ? args[0] : undefined;
      if (text?.startsWith("INSERT INTO email_otp_codes") && !removed && this !== db) {
        removed = true;
        // the sweep's DELETE lands in the gap
        return db.query("DELETE FROM users WHERE email = $1", [address]).then(() => raw.apply(this, args as never));
      }
      return raw.apply(this, args as never);
    });
    const sentBefore = sent.length;
    const res = await requestCode(address);
    vi.restoreAllMocks();

    expect(removed).toBe(true);
    expect(res.statusCode).toBe(baseline.statusCode);
    expect(scrub(res.json())).toEqual(scrub(baseline.json()));
    // nothing is mailed for an account that no longer exists
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.slice(sentBefore).filter((m) => m.to === address)).toEqual([]);
  });

  it("STORY-173 · AC2 — completing a ceremony for an unknown id, a used id and a registration id is one refusal", async () => {
    const owner = await seedUser();
    const cookies = await otpSignIn(owner.email);
    const options = await addPasskeyOptions(cookies);
    const registrationCeremony = dataOf<{ ceremony_id: string }>(options).ceremony_id;
    const usedOptions = await app.inject({ method: "POST", url: apiUrl("/auth/passkey/options"), payload: { purpose: "assertion" } });
    const usedCeremony = dataOf<{ ceremony_id: string }>(usedOptions).ceremony_id;
    await db.query("UPDATE webauthn_challenges SET consumed_at = now() WHERE id = $1", [usedCeremony]);

    const bodies = [];
    for (const ceremony of [randomUUID(), usedCeremony, registrationCeremony]) {
      const res = await app.inject({
        method: "POST",
        url: apiUrl("/auth/passkey/verify"),
        payload: { ceremony_id: ceremony, response: credentialResponse(credId("x")) },
      });
      expect(res.statusCode).toBe(400);
      bodies.push(scrub(res.json()));
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  // ---- AC3 · an anonymous request never rewrites an existing row ----------------

  it("STORY-173 · AC3 — no anonymous request rewrites an existing account's stored address or casing", async () => {
    const stored = "MiXeD.Case@Corp.Example";
    const victim = await seedUser({ email: stored });

    await anonymousRegistrationOptions("mixed.case@corp.example");
    await anonymousRegistrationOptions("MIXED.CASE@CORP.EXAMPLE", { display_name: "Mallory" });
    await requestCode("MIXED.CASE@corp.example");
    await requestCode("  mixed.case@corp.example  ");

    const row = await db.query<{ email: string }>("SELECT email::text AS email FROM users WHERE id = $1", [victim.id]);
    expect(row.rows).toEqual([{ email: stored }]);
    expect((await db.query("SELECT id FROM users WHERE email = $1", [stored])).rows).toHaveLength(1);
  });

  // ---- AC4 · the legitimate flow: prove the address, then add the passkey -------------

  it("STORY-173 · AC4 — a new account proves its address by OTP, then adds its first passkey, and signs in with it", async () => {
    const email = "new.person@corp.example";

    const before = sent.length;
    expect((await requestCode(email)).statusCode).toBeLessThan(300);
    // The request created an account that nothing can use yet.
    const created = await db.query<{ id: string; status: string; email_verified_at: Date | null }>(
      "SELECT id, status, email_verified_at FROM users WHERE email = $1",
      [email],
    );
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]).toMatchObject({ status: "unverified", email_verified_at: null });
    const userId = created.rows[0]!.id;
    expect((await db.query("SELECT 1 FROM user_credentials WHERE user_id = $1", [userId])).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM sessions WHERE user_id = $1", [userId])).rows).toHaveLength(0);

    const code = /\b(\d{8})\b/.exec(await mailTo(email, before))![1]!;
    const verified = await app.inject({ method: "POST", url: apiUrl("/auth/otp/verify"), payload: { email, code } });
    expect(verified.statusCode).toBe(200);
    const cookies = cookiesOf(verified);
    expect(claimsOf(cookies).sub).toBe(userId);
    expect((await db.query("SELECT status, email_verified_at FROM users WHERE id = $1", [userId])).rows[0]).toMatchObject({
      status: "active",
    });

    await addPasskey(cookies, "first-key");
    const credential = await db.query("SELECT user_id FROM user_credentials WHERE credential_id = $1 AND revoked_at IS NULL", [
      Buffer.from(credId("first-key"), "base64url"),
    ]);
    expect(credential.rows).toEqual([{ user_id: userId }]);

    // The passkey signs the same person back in, and the account can act.
    const signedIn = await passkeySignIn("first-key", 1);
    expect(signedIn.statusCode).toBe(200);
    const again = cookiesOf(signedIn);
    expect(claimsOf(again).sub).toBe(userId);
    const workspace = await app.inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      payload: { name: "Proven Owner Workspace" },
      ...mutating(again),
    });
    expect(workspace.statusCode).toBe(201);
  });

  it("STORY-173 · AC4 — an existing user signs in with an existing passkey", async () => {
    const user = await seedUser();
    await seedPasskey(user.id, "existing-key");
    const res = await passkeySignIn("existing-key", 1);
    expect(res.statusCode).toBe(200);
    expect(claimsOf(cookiesOf(res)).sub).toBe(user.id);
  });

  // ---- AC5 · no credential or session for an address nobody proved --------------------

  it("STORY-173 · AC5 — pre-hijack: an attacker cannot plant a passkey on an address before its owner exists (X2)", async () => {
    const target = "target@corp.example";

    // Every route the attacker can reach without proving the address.
    const registration = await anonymousRegistrationOptions(target);
    expect(registration.statusCode).toBe(400);
    mockRegistration(credId("planted-key"));
    const verify = await app.inject({
      method: "POST",
      url: apiUrl("/auth/passkey/verify"),
      payload: { ceremony_id: randomUUID(), response: credentialResponse(credId("planted-key")) },
    });
    expect(verify.statusCode).toBe(400);
    const unauthenticated = await addPasskeyOptions(null);
    expect(unauthenticated.statusCode).toBe(401);

    expect((await db.query("SELECT 1 FROM user_credentials")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM sessions")).rows).toHaveLength(0);

    // The owner arrives later and proves the address by OTP: the account that
    // results has no credential but theirs to add, and the planted key is not
    // a credential of anyone.
    const owner = await otpSignIn(target);
    const planted = await passkeySignIn("planted-key", 1);
    expect(planted.statusCode).toBe(400);
    expect(planted.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)).toBeUndefined();
    expect((await db.query("SELECT 1 FROM user_credentials")).rows).toHaveLength(0);
    expect(claimsOf(owner).sub).toBeDefined();
  });

  it("STORY-173 · AC5 — a passkey on a row whose address was never proved yields no session", async () => {
    const legacy = await seedUser({ verified: false, status: "active" });
    await seedPasskey(legacy.id, "legacy-planted");
    const sessionsBefore = (await counts()).sessions;

    const res = await passkeySignIn("legacy-planted", 1);
    expect(res.statusCode).toBe(400);
    expect(res.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)).toBeUndefined();
    expect((await counts()).sessions).toBe(sessionsBefore);
  });

  it("STORY-173 · AC5 — a signed-in account whose address is unproven cannot add a passkey", async () => {
    // e.g. an OAuth account the provider did not verify (STORY-015).
    const unproven = await seedUser({ verified: false, status: "unverified" });
    const session = await app.get(SessionService).createSession(unproven.id, new Date(), "email_otp");
    const cookies: Cookies = { access: session.accessToken, csrf: session.csrfToken };
    const challengesBefore = (await counts()).challenges;

    const res = await addPasskeyOptions(cookies);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    expect((await counts()).challenges).toBe(challengesBefore);
  });

  it("STORY-173 · AC5 — a suspended account, even with a proved address, cannot add a passkey", async () => {
    const user = await seedUser({ status: "active" });
    await db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [user.id]);
    const session = await app.get(SessionService).createSession(user.id, new Date(), "email_otp");
    const res = await addPasskeyOptions({ access: session.accessToken, csrf: session.csrfToken });
    expect(res.statusCode).toBe(403);
  });

  it("STORY-173 · AC5 — an address proved after the ceremony began is re-checked at verify (the account is never bound unproven)", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    const options = await addPasskeyOptions(cookies);
    const ceremonyId = dataOf<{ ceremony_id: string }>(options).ceremony_id;
    await db.query("UPDATE users SET email_verified_at = NULL WHERE id = $1", [user.id]);

    const res = await addPasskeyVerify(cookies, ceremonyId, "late-key");
    expect(res.statusCode).toBe(403);
    expect((await db.query("SELECT 1 FROM user_credentials WHERE user_id = $1", [user.id])).rows).toHaveLength(0);
  });

  // ---- AC6 · 'active' only with proof ------------------------------------------

  it("STORY-173 · AC6 — no sequence of anonymous requests leaves an active account without a verified address", async () => {
    const emails = ["a1@corp.example", "a2@corp.example", "a3@corp.example"];
    for (const email of emails) {
      await anonymousRegistrationOptions(email);
      await requestCode(email);
      await app.inject({ method: "POST", url: apiUrl("/auth/otp/verify"), payload: { email, code: "00000000" } });
      await passkeySignIn("nothing", 1);
    }
    const unproven = await db.query("SELECT email, status FROM users WHERE status = 'active' AND email_verified_at IS NULL AND email NOT LIKE '%@nominara.invalid'",
    );
    expect(unproven.rows).toEqual([]);
    expect((await db.query("SELECT status FROM users WHERE email = ANY($1)", [emails])).rows.every((r: { status: string }) => r.status === "unverified")).toBe(
      true,
    );
    expect((await counts()).sessions).toBe(0);
  });

  it("STORY-173 · AC6 — adding a passkey never changes an account's status", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    const before = (await db.query("SELECT status, email_verified_at FROM users WHERE id = $1", [user.id])).rows[0];
    await addPasskey(cookies, "status-key");
    expect((await db.query("SELECT status, email_verified_at FROM users WHERE id = $1", [user.id])).rows[0]).toEqual(before);
  });

  // ---- AC7 · the first proof revokes everything that predates it ----------------

  it("STORY-173 · AC7 — the first proof of an address revokes every credential and session that predates it", async () => {
    const legacy = await seedUser({ email: "legacy@corp.example", verified: false, status: "active" });
    await seedPasskey(legacy.id, "attackers-planted-key");
    await db.query(
      `INSERT INTO user_credentials (user_id, kind, provider, external_subject)
       VALUES ($1, 'oauth', 'google', 'attacker-subject')`,
      [legacy.id],
    );
    const attackerSession = await app.get(SessionService).createSession(legacy.id);

    const owner = await otpSignIn(legacy.email);

    const live = await db.query("SELECT id FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL", [legacy.id]);
    expect(live.rows).toEqual([]);
    const old = await db.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM sessions WHERE id = $1", [attackerSession.sid]);
    expect(old.rows[0]!.revoked_at).not.toBeNull();
    const refreshed = await app.inject({
      method: "POST",
      url: apiUrl("/auth/refresh"),
      cookies: { [REFRESH_COOKIE_NAME]: attackerSession.refreshToken, [CSRF_COOKIE_NAME]: attackerSession.csrfToken },
      headers: { [CSRF_HEADER_NAME]: computeCsrfToken(attackerSession.sid, CSRF_SECRET) },
    });
    expect(refreshed.statusCode).toBe(401);
    const planted = await passkeySignIn("attackers-planted-key", 1);
    expect(planted.statusCode).toBe(400);

    // The owner's own session is not collateral damage.
    const mine = await app.inject({ method: "GET", url: apiUrl("/me/passkeys"), cookies: { [ACCESS_COOKIE_NAME]: owner.access } });
    expect(mine.statusCode).toBe(200);
  });

  it("STORY-173 · AC7 — a later OTP sign-in by an already-proven account revokes nothing", async () => {
    const user = await seedUser();
    await seedPasskey(user.id, "keep-me");
    await otpSignIn(user.email);
    const live = await db.query("SELECT id FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
    expect(live.rows).toHaveLength(1);
  });

  // ---- AC8 · adding a passkey to an existing account needs a session AND a step-up --------

  it("STORY-173 · AC8 — an existing account can add a passkey only from a signed-in, freshly re-authenticated session", async () => {
    const user = await seedUser();
    await seedPasskey(user.id, "first-device");

    // No session at all.
    expect((await addPasskeyOptions(null)).statusCode).toBe(401);

    // A session with no strong re-authentication (an OAuth or demo session).
    const plain = await app.get(SessionService).createSession(user.id);
    const plainCookies: Cookies = { access: plain.accessToken, csrf: plain.csrfToken };
    const refused = await addPasskeyOptions(plainCookies);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe("step_up_required");
    expect(refused.json().error.details.methods).toEqual(expect.arrayContaining(["webauthn", "email_otp"]));

    // A fresh OTP sign-in satisfies it.
    const fresh = await otpSignIn(user.email);
    await addPasskey(fresh, "second-device");
    const live = await db.query("SELECT id FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
    expect(live.rows).toHaveLength(2);
  });

  it("STORY-173 · AC8 — the step-up window is five minutes, checked at options and again at verify", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    const options = await addPasskeyOptions(cookies);
    expect(options.statusCode).toBe(201);
    const ceremonyId = dataOf<{ ceremony_id: string }>(options).ceremony_id;

    await db.query("UPDATE sessions SET last_strong_auth_at = now() - interval '4 minutes 50 seconds' WHERE id = $1", [claimsOf(cookies).sid]);
    expect((await addPasskeyOptions(cookies)).statusCode).toBe(201);

    await db.query("UPDATE sessions SET last_strong_auth_at = now() - interval '5 minutes 10 seconds' WHERE id = $1", [claimsOf(cookies).sid]);
    const stale = await addPasskeyOptions(cookies);
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe("step_up_required");
    const staleVerify = await addPasskeyVerify(cookies, ceremonyId, "stale-key");
    expect(staleVerify.statusCode).toBe(401);
    expect(staleVerify.json().error.code).toBe("step_up_required");
    expect((await db.query("SELECT 1 FROM user_credentials WHERE user_id = $1", [user.id])).rows).toHaveLength(0);
  });

  it("STORY-173 · AC8 — signing in with a passkey is itself a fresh strong authentication", async () => {
    const user = await seedUser();
    await seedPasskey(user.id, "device-one");
    const signedIn = cookiesOf(await passkeySignIn("device-one", 1));
    await addPasskey(signedIn, "device-two");
    const row = await db.query("SELECT last_strong_auth_method FROM sessions WHERE id = $1", [claimsOf(signedIn).sid]);
    expect(row.rows[0].last_strong_auth_method).toBe("webauthn");
  });

  it("STORY-173 · AC8 — an OTP sign-in records email_otp as the strong-auth method", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    const row = await db.query<{ last_strong_auth_at: Date | null; last_strong_auth_method: string | null }>(
      "SELECT last_strong_auth_at, last_strong_auth_method FROM sessions WHERE id = $1",
      [claimsOf(cookies).sid],
    );
    expect(row.rows[0]!.last_strong_auth_method).toBe("email_otp");
    expect(row.rows[0]!.last_strong_auth_at).not.toBeNull();
  });

  // ---- AC9 · a ceremony is bound to the account that began it -----------------------------

  it("STORY-173 · AC9 — one account cannot complete another account's registration ceremony", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const aliceCookies = await otpSignIn(alice.email);
    const bobCookies = await otpSignIn(bob.email);
    const options = await addPasskeyOptions(aliceCookies);
    const ceremonyId = dataOf<{ ceremony_id: string }>(options).ceremony_id;

    const stolen = await addPasskeyVerify(bobCookies, ceremonyId, "bobs-key");
    expect(stolen.statusCode).toBe(400);
    expect((await db.query("SELECT 1 FROM user_credentials WHERE user_id = $1", [bob.id])).rows).toHaveLength(0);

    // Alice's ceremony was not consumed by Bob's attempt.
    const ok = await addPasskeyVerify(aliceCookies, ceremonyId, "alices-key");
    expect(ok.statusCode).toBe(200);
    expect((await db.query("SELECT user_id FROM user_credentials WHERE credential_id = $1", [Buffer.from(credId("alices-key"), "base64url")])).rows).toEqual([
      { user_id: alice.id },
    ]);
  });

  it("STORY-173 · AC9 — an assertion ceremony cannot be used to register a credential", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    const assertion = await app.inject({ method: "POST", url: apiUrl("/auth/passkey/options"), payload: { purpose: "assertion" } });
    const res = await addPasskeyVerify(cookies, dataOf<{ ceremony_id: string }>(assertion).ceremony_id, "wrong-purpose");
    expect(res.statusCode).toBe(400);
    expect((await db.query("SELECT 1 FROM user_credentials WHERE user_id = $1", [user.id])).rows).toHaveLength(0);
  });

  it("STORY-173 · AC9 — a registration ceremony is single-use and expires", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    const first = await addPasskeyOptions(cookies);
    const ceremonyId = dataOf<{ ceremony_id: string }>(first).ceremony_id;
    expect((await addPasskeyVerify(cookies, ceremonyId, "once")).statusCode).toBe(200);
    expect((await addPasskeyVerify(cookies, ceremonyId, "twice")).statusCode).toBe(400);

    const second = await addPasskeyOptions(cookies);
    const expiring = dataOf<{ ceremony_id: string }>(second).ceremony_id;
    await db.query("UPDATE webauthn_challenges SET expires_at = now() - interval '1 minute' WHERE id = $1", [expiring]);
    expect((await addPasskeyVerify(cookies, expiring, "late")).statusCode).toBe(400);
  });

  it("STORY-173 · AC9 — the credentials already registered are excluded from the new ceremony", async () => {
    const user = await seedUser();
    await seedPasskey(user.id, "already-here");
    const cookies = await otpSignIn(user.email);
    const options = await addPasskeyOptions(cookies);
    const exclude = dataOf<{ options: { excludeCredentials: Array<{ id: string }> } }>(options).options.excludeCredentials;
    expect(exclude.map((c) => c.id)).toEqual([credId("already-here")]);
  });

  // ---- AC10 · contract ---------------------------------------------------------

  it("STORY-173 · AC10 — the add-passkey body is strict: an email in it is a 400, never an account selector", async () => {
    const user = await seedUser();
    const cookies = await otpSignIn(user.email);
    const res = await addPasskeyOptions(cookies, { email: "someone-else@corp.example" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
    expect((await counts()).challenges).toBe(0);
  });

  // ---- AC11 · observability ----------------------------------------------------

  it("STORY-173 · AC11 — a refusal is counted with its reason and logged without the address", async () => {
    const lines: string[] = [];
    const capture = (message: unknown): void => {
      lines.push(typeof message === "string" ? message : JSON.stringify(message));
    };
    vi.spyOn(Logger.prototype, "log").mockImplementation(capture);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(capture);

    const unproven = await seedUser({ email: "secret.person@corp.example", verified: false, status: "unverified" });
    const session = await app.get(SessionService).createSession(unproven.id, new Date(), "email_otp");
    const res = await addPasskeyOptions({ access: session.accessToken, csrf: session.csrfToken });
    expect(res.statusCode).toBe(403);

    const metric = lines.find((l) => l.includes("nominara_identity_credential_change_refused_total"));
    expect(metric).toBeDefined();
    expect(metric).toContain("address_unproven");
    expect(metric).toContain("passkey_add");
    expect(lines.filter((l) => l.includes("secret.person"))).toEqual([]);
  });

  it("STORY-173 · AC11 — the first proof is counted with the number of credentials and sessions it revoked", async () => {
    const lines: string[] = [];
    const capture = (message: unknown): void => {
      lines.push(typeof message === "string" ? message : JSON.stringify(message));
    };
    vi.spyOn(Logger.prototype, "log").mockImplementation(capture);
    const legacy = await seedUser({ email: "counted@corp.example", verified: false, status: "active" });
    await seedPasskey(legacy.id, "to-be-revoked");
    await otpSignIn(legacy.email);

    const metric = lines.find((l) => l.includes("nominara_identity_first_proof_revocation_total"));
    expect(metric).toBeDefined();
    expect(lines.filter((l) => l.includes("counted@corp.example"))).toEqual([]);
  });
});
