import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { registerCookiePlugin } from "../../src/api/register-cookies.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { EMAIL_SENDER, type EmailMessage, type EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import {
  OAUTH_CLIENT,
  type OauthAuthorizationUrlInput,
  type OauthClient,
  type OauthExchangeInput,
  type OauthIdentity,
  type OauthPkcePair,
} from "../../src/modules/identity/ports/oauth-client.js";
import { hash as argon2Hash } from "../../src/lib/crypto/argon2id.js";
import { normalizeEmail, hashEmailKey } from "../../src/lib/auth/email-otp.js";

// STORY-016 — Phase D. Real Postgres (testcontainers, never mock the DB);
// the only thing faked is delivery itself, at the EMAIL_SENDER port
// boundary (same port-plus-fake-adapter precedent as OAUTH_CLIENT in
// test/integration/identity-oauth-pkce.spec.ts and DEK_PROVISIONER) — no
// real network call, no mocking of the argon2id/timing/generation
// primitives already unit-tested in Phase C.
//
// These tests are written against routes/wiring that do not exist yet
// (email-otp.controller.ts/email-otp.service.ts/the module registration —
// all later tasks). Every scenario below is expected to fail red right now;
// see the accompanying report for the confirmed failure reason per test.
//
// Dangerous area disclosure: this file exercises the OTP attempt-budget/
// invalidation and rate-limit ledger logic (credit-ledger-adjacent
// correctness: exactly-once consumption under concurrency) — second-
// engineer review required alongside email-otp.service.ts.
//
// HTTP status assumption (flagged for confirmation before implementation):
// POST /auth/otp/request is assumed to answer 201 on success, mirroring the
// sibling "issue a challenge/resource" endpoints in this module
// (POST /auth/passkey/options and POST /auth/oauth/:provider/start, both
// un-annotated Nest POSTs — i.e. Nest's default 201). The story does not
// pin this explicitly; POST /auth/otp/verify's 200 IS pinned by D8.
const OTP_REQUEST_SUCCESS_STATUS = 201;

class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  /** All 8-digit codes ever sent to `email` (normalized match), oldest first. */
  codesFor(email: string): string[] {
    const target = normalizeEmail(email);
    return this.sent
      .filter((m) => normalizeEmail(m.to) === target)
      .map((m) => m.textBody.match(/\b\d{8}\b/)?.[0])
      .filter((code): code is string => code !== undefined);
  }

  latestCodeFor(email: string): string | undefined {
    const codes = this.codesFor(email);
    return codes.at(-1);
  }
}

// Minimal fake for the ONE cross-story test that needs an OAuth-created
// unverified account (D2 promotion). Deliberately thinner than
// identity-oauth-pkce.spec.ts's FakeOauthClient (no PKCE-verifier-queue
// bookkeeping) — this file's OAuth usage is a fixture, not the thing under
// test.
class MinimalFakeOauthClient implements OauthClient {
  private readonly exchanges = new Map<string, OauthIdentity>();

  registerExchange(code: string, identity: OauthIdentity): void {
    this.exchanges.set(code, identity);
  }

  async generatePkce(): Promise<OauthPkcePair> {
    return { verifier: randomUUID(), challenge: randomUUID() };
  }

  authorizationUrl(input: OauthAuthorizationUrlInput): string {
    const url = new URL(`https://fake-provider.example.com/${input.provider}/authorize`);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    return url.toString();
  }

  async exchangeCode(input: OauthExchangeInput): Promise<OauthIdentity> {
    const identity = this.exchanges.get(input.code);
    if (!identity) throw new Error(`fake provider: no identity registered for code ${input.code}`);
    return identity;
  }
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

function mutatingHeaders(cookies: AuthCookies): { headers: Record<string, string>; cookies: Record<string, string> } {
  return {
    headers: { [CSRF_HEADER_NAME]: cookies.csrf },
    cookies: { [ACCESS_COOKIE_NAME]: cookies.access, [CSRF_COOKIE_NAME]: cookies.csrf },
  };
}

describe("STORY-016 · email OTP fallback sign-in", () => {
  let container: StartedPostgreSqlContainer;
  let app: NestFastifyApplication;
  let db: Client;
  let fakeSender: FakeEmailSender;
  let fakeOauthClient: MinimalFakeOauthClient;
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

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    fakeSender = new FakeEmailSender();
    fakeOauthClient = new MinimalFakeOauthClient();
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(fakeSender)
      .overrideProvider(OAUTH_CLIENT)
      .useValue(fakeOauthClient)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await registerCookiePlugin(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    await db.end();
  });

  // ---- helpers -------------------------------------------------------------

  async function createUser(
    email: string,
    opts: { status?: string; deleted?: boolean } = {},
  ): Promise<string> {
    const status = opts.status ?? "active";
    const deletedAt = opts.deleted ? "now()" : "NULL";
    const result = await db.query<{ id: string }>(
      `INSERT INTO users (email, status, deleted_at) VALUES ($1, $2, ${deletedAt}) RETURNING id`,
      [email, status],
    );
    return result.rows[0]!.id;
  }

  // STORY-016 fix 2 — requestCode() defers the email-send call itself to
  // setImmediate so no synchronous send-adapter work sits on the response
  // path (code-reviewer finding); the HTTP response settles before that
  // callback runs, so tests reading fakeSender right after this resolves
  // need one macrotask tick to let the deferred send actually happen.
  async function requestOtp(email: string) {
    const res = await app.inject({ method: "POST", url: "/auth/otp/request", payload: { email } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return res;
  }

  function verifyOtp(email: string, code: string) {
    return app.inject({ method: "POST", url: "/auth/otp/verify", payload: { email, code } });
  }

  async function seedLiveCode(
    userId: string,
    plaintextCode: string,
    opts: { expiresInMs?: number } = {},
  ): Promise<string> {
    const codeHash = await argon2Hash(plaintextCode);
    const expiresInMs = opts.expiresInMs ?? 10 * 60 * 1000;
    const row = await db.query<{ id: string }>(
      `INSERT INTO email_otp_codes (user_id, code_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 millisecond' * $3) RETURNING id`,
      [userId, codeHash, expiresInMs],
    );
    return row.rows[0]!.id;
  }

  function wrongCodeFor(realCode: string): string {
    const asNumber = Number(realCode);
    const wrong = (asNumber + 1) % 1e8;
    return wrong.toString().padStart(8, "0");
  }

  // ---- Scenario 1 -----------------------------------------------------------

  it("STORY-016 · scenario 1 — request then verify a code: authenticated, session cookies set, a sessions row exists", async () => {
    const email = "s1@example.com";
    const userId = await createUser(email);

    const reqRes = await requestOtp(email);
    expect(reqRes.statusCode).toBe(OTP_REQUEST_SUCCESS_STATUS);
    expect(reqRes.json()).toEqual({ status: "sent", expires_in_seconds: 600 });

    const code = fakeSender.latestCodeFor(email);
    expect(code).toMatch(/^\d{8}$/);

    const verifyRes = await verifyOtp(email, code!);
    expect(verifyRes.statusCode).toBe(200);
    const cookies = extractAuthCookies(verifyRes);
    expect(cookies).not.toBeNull();

    const sessions = await db.query("SELECT id FROM sessions WHERE user_id = $1", [userId]);
    expect(sessions.rows.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Scenario 2 -----------------------------------------------------------

  it("STORY-016 · scenario 2 — request for an unknown address is byte-identical to a known address, and writes no email_otp_codes row", async () => {
    const knownEmail = "s2-known@example.com";
    const unknownEmail = "s2-unknown@example.com";
    await createUser(knownEmail);

    const before = await db.query("SELECT count(*)::int AS c FROM email_otp_codes");

    const unknownRes = await requestOtp(unknownEmail);
    const afterUnknown = await db.query("SELECT count(*)::int AS c FROM email_otp_codes");
    expect(afterUnknown.rows[0].c).toBe(before.rows[0].c);

    const knownRes = await requestOtp(knownEmail);
    const afterKnown = await db.query("SELECT count(*)::int AS c FROM email_otp_codes");
    expect(afterKnown.rows[0].c).toBe(before.rows[0].c + 1);

    expect(knownRes.statusCode).toBe(unknownRes.statusCode);
    expect(JSON.stringify(knownRes.json())).toBe(JSON.stringify(unknownRes.json()));
  });

  // ---- Scenario 4 -----------------------------------------------------------

  it("STORY-016 · scenario 4 — reusing an already-verified code is refused, and consumed_at does not change", async () => {
    const email = "s4@example.com";
    await createUser(email);
    await requestOtp(email);
    const code = fakeSender.latestCodeFor(email)!;

    const first = await verifyOtp(email, code);
    expect(first.statusCode).toBe(200);

    const row1 = await db.query("SELECT consumed_at FROM email_otp_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)", [email]);
    const consumedAtFirst = row1.rows[0].consumed_at;
    expect(consumedAtFirst).not.toBeNull();

    const second = await verifyOtp(email, code);
    expect(second.statusCode).not.toBe(200);

    const row2 = await db.query("SELECT consumed_at FROM email_otp_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)", [email]);
    expect(row2.rows[0].consumed_at).toEqual(consumedAtFirst);
  });

  // ---- Scenario 5 -----------------------------------------------------------

  it("STORY-016 · scenario 5 — an expired code is refused with a message byte-identical to any other rejection (reused code), not just 'some 4xx'", async () => {
    const expiredEmail = "s5-expired@example.com";
    const expiredUserId = await createUser(expiredEmail);
    await seedLiveCode(expiredUserId, "11112222", { expiresInMs: -1000 });
    const expiredRes = await verifyOtp(expiredEmail, "11112222");
    expect(expiredRes.statusCode).toBeGreaterThanOrEqual(400);
    expect(expiredRes.statusCode).toBeLessThan(500);

    const reusedEmail = "s5-reused@example.com";
    await createUser(reusedEmail);
    await requestOtp(reusedEmail);
    const reusedCode = fakeSender.latestCodeFor(reusedEmail)!;
    await verifyOtp(reusedEmail, reusedCode); // first use succeeds
    const reusedRejection = await verifyOtp(reusedEmail, reusedCode); // second use is the reference rejection

    expect(expiredRes.statusCode).toBe(reusedRejection.statusCode);
    expect(JSON.stringify(expiredRes.json())).toBe(JSON.stringify(reusedRejection.json()));
  });

  // ---- Scenario 6 -----------------------------------------------------------

  it("STORY-016 · scenario 6 — exhausting the attempt budget then presenting the correct code is still refused, and the row is INVALIDATED, not merely rejected", async () => {
    const email = "s6@example.com";
    await createUser(email);
    await requestOtp(email);
    const code = fakeSender.latestCodeFor(email)!;
    const wrong = wrongCodeFor(code);

    for (let i = 0; i < 5; i++) {
      const res = await verifyOtp(email, wrong);
      expect(res.statusCode).not.toBe(200);
    }

    const finalRes = await verifyOtp(email, code);
    expect(finalRes.statusCode).not.toBe(200);

    const row = await db.query(
      "SELECT invalidated_at, invalidated_reason FROM email_otp_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)",
      [email],
    );
    expect(row.rows[0].invalidated_at).not.toBeNull();
    expect(row.rows[0].invalidated_reason).toBe("attempts_exhausted");
  });

  // ---- Scenario 7 -----------------------------------------------------------

  it("STORY-016 · scenario 7 — a 4th request within an hour for the same address is refused with a retry hint", async () => {
    const email = "s7@example.com";
    await createUser(email);

    await requestOtp(email);
    await requestOtp(email);
    await requestOtp(email);
    const fourth = await requestOtp(email);

    expect(fourth.statusCode).toBe(429);
    const body = fourth.json() as { code: string; details: { retry_after_seconds: number } };
    expect(body.code).toBe("rate_limited");
    expect(body.details.retry_after_seconds).toBeGreaterThan(0);
    expect(body.details.retry_after_seconds).toBeLessThanOrEqual(3600);
  });

  // ---- Scenario 8 -----------------------------------------------------------

  it("STORY-016 · scenario 8 — requesting twice and verifying the first invalidates the second (superseded) and it can no longer be verified", async () => {
    const email = "s8@example.com";
    await createUser(email);
    await requestOtp(email);
    await requestOtp(email);
    const [firstCode, secondCode] = fakeSender.codesFor(email);
    expect(firstCode).toBeDefined();
    expect(secondCode).toBeDefined();
    expect(firstCode).not.toBe(secondCode);

    const verifyFirst = await verifyOtp(email, firstCode!);
    expect(verifyFirst.statusCode).toBe(200);

    const rows = await db.query(
      "SELECT invalidated_at, invalidated_reason, consumed_at FROM email_otp_codes WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY created_at ASC",
      [email],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].consumed_at).not.toBeNull();
    expect(rows.rows[1].invalidated_at).not.toBeNull();
    expect(rows.rows[1].invalidated_reason).toBe("superseded");

    const verifySecond = await verifyOtp(email, secondCode!);
    expect(verifySecond.statusCode).not.toBe(200);
  });

  // ---- Scenario 9 -----------------------------------------------------------

  it("STORY-016 · scenario 9 — stored codes are Argon2id-hashed, never plaintext, anywhere in the row", async () => {
    const email = "s9@example.com";
    await createUser(email);
    await requestOtp(email);
    const code = fakeSender.latestCodeFor(email)!;

    const row = await db.query(
      "SELECT * FROM email_otp_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)",
      [email],
    );
    expect(row.rows).toHaveLength(1);
    const record = row.rows[0];
    expect(record.code_hash).toMatch(/^\$argon2id\$/);
    for (const [column, value] of Object.entries(record)) {
      expect(String(value), `column ${column} contained the plaintext code`).not.toContain(code);
    }
  });

  // ---- Widen: boundary code values -------------------------------------------

  for (const boundaryCode of ["00000000", "99999999"]) {
    it(`STORY-016 · boundary — code "${boundaryCode}" verifies correctly when it is the stored (hashed) code`, async () => {
      const email = `s-boundary-${boundaryCode}@example.com`;
      const userId = await createUser(email);
      await seedLiveCode(userId, boundaryCode);

      const res = await verifyOtp(email, boundaryCode);
      expect(res.statusCode).toBe(200);
      const cookies = extractAuthCookies(res);
      expect(cookies).not.toBeNull();
    });
  }

  // ---- Widen: rate-limit window boundary -------------------------------------

  it("STORY-016 · widen — rate-limit window: just-under-1h since the first of 3 is still limited; just-over-1h allows again", async () => {
    const email = "s-window@example.com";
    await createUser(email);
    const emailHash = hashEmailKey(normalizeEmail(email), process.env.OTP_EMAIL_HASH_PEPPER!);

    await db.query(
      `INSERT INTO email_otp_requests (email_hash, created_at)
       SELECT $1, now() - interval '59 minutes' FROM generate_series(1, 3)`,
      [emailHash],
    );

    const stillLimited = await requestOtp(email);
    expect(stillLimited.statusCode).toBe(429);

    await db.query("UPDATE email_otp_requests SET created_at = now() - interval '61 minutes' WHERE email_hash = $1", [
      emailHash,
    ]);

    const allowedAgain = await requestOtp(email);
    expect(allowedAgain.statusCode).toBe(OTP_REQUEST_SUCCESS_STATUS);
  });

  // ---- Widen: verify for an address that never requested anything -----------

  it("STORY-016 · widen — verify for an address that never requested anything fails with the same neutral message as any other rejection, and writes no row", async () => {
    const neverRequestedEmail = "s-never-requested@example.com";

    const referenceEmail = "s-reference-wrong-code@example.com";
    await createUser(referenceEmail);
    await requestOtp(referenceEmail);
    const realCode = fakeSender.latestCodeFor(referenceEmail)!;
    const referenceRejection = await verifyOtp(referenceEmail, wrongCodeFor(realCode));
    expect(referenceRejection.statusCode).not.toBe(200);

    const before = await db.query("SELECT count(*)::int AS c FROM email_otp_codes");
    const neverRequestedRejection = await verifyOtp(neverRequestedEmail, "12345678");
    const after = await db.query("SELECT count(*)::int AS c FROM email_otp_codes");

    expect(neverRequestedRejection.statusCode).toBe(referenceRejection.statusCode);
    expect(JSON.stringify(neverRequestedRejection.json())).toBe(JSON.stringify(referenceRejection.json()));
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  // ---- Widen: case/whitespace normalization ----------------------------------

  it("STORY-016 · widen — requesting with surrounding whitespace and different case, then verifying with the normalized address, succeeds", async () => {
    const normalizedEmail = "user@example.com";
    await createUser(normalizedEmail);

    const reqRes = await requestOtp(" User@Example.COM ");
    expect(reqRes.statusCode).toBe(OTP_REQUEST_SUCCESS_STATUS);

    const code = fakeSender.latestCodeFor(normalizedEmail);
    expect(code).toMatch(/^\d{8}$/);

    const verifyRes = await verifyOtp(normalizedEmail, code!);
    expect(verifyRes.statusCode).toBe(200);
  });

  // ---- Widen: suspended / soft-deleted user treated as unknown (D7) ---------

  it("STORY-016 · widen (D7) — a suspended user, a soft-deleted user, and a genuinely unknown address all get a byte-identical request response", async () => {
    const suspendedEmail = "s-suspended@example.com";
    const deletedEmail = "s-deleted@example.com";
    const unknownEmail = "s-truly-unknown@example.com";
    await createUser(suspendedEmail, { status: "suspended" });
    await createUser(deletedEmail, { deleted: true });

    const suspendedRes = await requestOtp(suspendedEmail);
    const deletedRes = await requestOtp(deletedEmail);
    const unknownRes = await requestOtp(unknownEmail);

    const bodies = [suspendedRes, deletedRes, unknownRes].map((r) => ({
      status: r.statusCode,
      body: JSON.stringify(r.json()),
    }));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });

  // ---- Concurrency: 10 parallel verifies of the same correct code -----------

  it("STORY-016 · concurrency — 10 parallel verifies of the SAME correct code: exactly one succeeds", async () => {
    const email = "s-concurrent-correct@example.com";
    const userId = await createUser(email);
    await requestOtp(email);
    const code = fakeSender.latestCodeFor(email)!;

    const sessionsBefore = await db.query("SELECT count(*)::int AS c FROM sessions WHERE user_id = $1", [userId]);

    const results = await Promise.all(Array.from({ length: 10 }, () => verifyOtp(email, code)));
    const successes = results.filter((r) => r.statusCode === 200).length;

    const sessionsAfter = await db.query("SELECT count(*)::int AS c FROM sessions WHERE user_id = $1", [userId]);

    expect(successes).toBe(1);
    expect(sessionsAfter.rows[0].c - sessionsBefore.rows[0].c).toBe(1);
  });

  // ---- Concurrency: 10 parallel wrong guesses -------------------------------

  it("STORY-016 · concurrency — 10 parallel wrong guesses against one code: attempts lands at exactly 5, invalidated", async () => {
    const email = "s-concurrent-wrong@example.com";
    await createUser(email);
    await requestOtp(email);
    const code = fakeSender.latestCodeFor(email)!;
    const wrong = wrongCodeFor(code);

    await Promise.all(Array.from({ length: 10 }, () => verifyOtp(email, wrong)));

    const row = await db.query(
      "SELECT attempts, invalidated_at, invalidated_reason FROM email_otp_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)",
      [email],
    );
    expect(row.rows[0].attempts).toBe(5);
    expect(row.rows[0].invalidated_at).not.toBeNull();
    expect(row.rows[0].invalidated_reason).toBe("attempts_exhausted");
  });

  // ---- Concurrency: rate-limit check-then-insert race (fix 3) ---------------

  it("STORY-016 · concurrency — 5 parallel requests for the same brand-new address never let more than 3/hour through the ledger", async () => {
    const email = "s-concurrent-rate-limit@example.com";
    await createUser(email);

    const results = await Promise.all(Array.from({ length: 5 }, () => requestOtp(email)));
    const successes = results.filter((r) => r.statusCode === OTP_REQUEST_SUCCESS_STATUS).length;
    const refused = results.filter((r) => r.statusCode === 429).length;

    expect(successes).toBe(3);
    expect(refused).toBe(2);

    const emailHash = hashEmailKey(normalizeEmail(email), process.env.OTP_EMAIL_HASH_PEPPER!);
    const row = await db.query("SELECT count(*)::int AS c FROM email_otp_requests WHERE email_hash = $1", [emailHash]);
    expect(row.rows[0].c).toBe(3);
  });

  // ---- Gap 1 (qa-reviewer, AC4/D5): unknown addresses are rate-limited identically to known ones ----

  it("STORY-016 · gap 1 (AC4/D5) — an address with NO account at all is rate-limited on the 4th request, identically to a known address", async () => {
    const knownEmail = "gap1-known@example.com";
    const unknownEmail = "gap1-unknown@example.com";
    await createUser(knownEmail);

    const knownResults = [];
    for (let i = 0; i < 4; i++) knownResults.push(await requestOtp(knownEmail));
    expect(knownResults.map((r) => r.statusCode)).toEqual([201, 201, 201, 429]);

    const unknownResults = [];
    for (let i = 0; i < 4; i++) unknownResults.push(await requestOtp(unknownEmail));
    expect(unknownResults.map((r) => r.statusCode)).toEqual([201, 201, 201, 429]);

    // The 4th (rate-limited) response for the unknown address must be
    // byte-identical to the known address's 4th response — a differing
    // outcome between the two on this 4th request would itself be an
    // enumeration oracle, the exact thing D5 exists to prevent.
    expect(JSON.stringify(unknownResults[3]!.json())).toBe(JSON.stringify(knownResults[3]!.json()));
  });

  // ---- Gap 2 (qa-reviewer, AC6): every internal rejection path cross-compares byte-identical ----

  it("STORY-016 · gap 2 (AC6) — wrong-code, expired-code, exhausted-attempts, and unknown-address rejections are ALL byte-identical to each other", async () => {
    // wrong_code
    const wrongCodeEmail = "gap2-wrong-code@example.com";
    await createUser(wrongCodeEmail);
    await requestOtp(wrongCodeEmail);
    const wrongCodeReal = fakeSender.latestCodeFor(wrongCodeEmail)!;
    const wrongCodeRes = await verifyOtp(wrongCodeEmail, wrongCodeFor(wrongCodeReal));
    expect(wrongCodeRes.statusCode).not.toBe(200);

    // no_live_codes via expiry
    const expiredEmail = "gap2-expired@example.com";
    const expiredUserId = await createUser(expiredEmail);
    await seedLiveCode(expiredUserId, "11112222", { expiresInMs: -1000 });
    const expiredRes = await verifyOtp(expiredEmail, "11112222");
    expect(expiredRes.statusCode).not.toBe(200);

    // no_live_codes via attempts_exhausted
    const exhaustedEmail = "gap2-exhausted@example.com";
    await createUser(exhaustedEmail);
    await requestOtp(exhaustedEmail);
    const exhaustedReal = fakeSender.latestCodeFor(exhaustedEmail)!;
    const exhaustedWrong = wrongCodeFor(exhaustedReal);
    for (let i = 0; i < 5; i++) {
      await verifyOtp(exhaustedEmail, exhaustedWrong);
    }
    const exhaustedRes = await verifyOtp(exhaustedEmail, exhaustedReal);
    expect(exhaustedRes.statusCode).not.toBe(200);

    // unknown_address
    const unknownRes = await verifyOtp("gap2-unknown@example.com", "12345678");
    expect(unknownRes.statusCode).not.toBe(200);

    const shapes = [
      { label: "wrong_code", status: wrongCodeRes.statusCode, body: JSON.stringify(wrongCodeRes.json()) },
      { label: "expired_code", status: expiredRes.statusCode, body: JSON.stringify(expiredRes.json()) },
      { label: "exhausted_attempts", status: exhaustedRes.statusCode, body: JSON.stringify(exhaustedRes.json()) },
      { label: "unknown_address", status: unknownRes.statusCode, body: JSON.stringify(unknownRes.json()) },
    ];

    // Explicit multi-way check: every pair, not just each-against-the-first,
    // so a leak confined to one internal bucket (e.g. only no_live_codes
    // diverging) cannot hide behind a comparison ordering that happens not
    // to exercise that pair.
    for (const a of shapes) {
      for (const b of shapes) {
        expect(a.status, `${a.label} vs ${b.label} status`).toBe(b.status);
        expect(a.body, `${a.label} vs ${b.label} body`).toBe(b.body);
      }
    }
  });

  // ---- Gap 3 (qa-reviewer, AC4): the per-source (30/min) rate limit is independently enforced ----

  it("STORY-016 · gap 3 (AC4) — the per-source (30/min) limit refuses the 31st request even though every address is well under its own 3/hour limit", async () => {
    const source = "203.0.113.55";
    const emails = Array.from({ length: 31 }, (_, i) => `gap3-source-${i}@example.com`);
    for (const email of emails) {
      await createUser(email);
    }

    const results = [];
    for (const email of emails) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/otp/request",
        remoteAddress: source,
        payload: { email },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      results.push(res);
    }

    expect(results.slice(0, 30).map((r) => r.statusCode)).toEqual(Array(30).fill(OTP_REQUEST_SUCCESS_STATUS));

    const last = results[30]!;
    expect(last.statusCode).toBe(429);
    const body = last.json() as { code: string; details: { retry_after_seconds: number } };
    expect(body.code).toBe("rate_limited");
    expect(body.details.retry_after_seconds).toBeGreaterThan(0);
    expect(body.details.retry_after_seconds).toBeLessThanOrEqual(60);
  });

  // ---- Cross-story: D2 promotion unlocks the workspace-create right ---------

  it("STORY-016 · D2 cross-story — an OAuth-created unverified user is refused POST /workspaces until they complete an OTP verification for that email, after which it succeeds", async () => {
    const email = "cross-story-otp-promotion@example.com";

    // Step 1: sign in via OAuth with a provider-UNVERIFIED email (STORY-015
    // semantics) — creates the account 'unverified', still issues a session.
    const startRes = await app.inject({ method: "POST", url: "/auth/oauth/google/start" });
    expect(startRes.statusCode).toBe(201);
    const startBody = startRes.json() as { authorization_url: string };
    const state = new URL(startBody.authorization_url).searchParams.get("state")!;
    fakeOauthClient.registerExchange("code-cross-story", {
      externalSubject: "sub-cross-story",
      email,
      emailVerified: false,
    });
    const bindingCookie = startRes.cookies.find((c) => c.name === "__Host-nominara-oauth-binding")?.value;
    const callbackRes = await app.inject({
      method: "GET",
      url: `/auth/oauth/google/callback?${new URLSearchParams({ state, code: "code-cross-story" }).toString()}`,
      cookies: bindingCookie ? { "__Host-nominara-oauth-binding": bindingCookie } : {},
    });
    expect(callbackRes.statusCode).toBe(200);
    expect((callbackRes.json() as { user_status: string }).user_status).toBe("unverified");
    const loginCookies = extractAuthCookies(callbackRes);
    expect(loginCookies).not.toBeNull();

    const beforeRow = await db.query("SELECT status FROM users WHERE email = $1", [email]);
    expect(beforeRow.rows[0].status).toBe("unverified");

    // Step 2: refused, matching STORY-015's existing gate.
    const refused = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Should Still Be Refused" },
      ...mutatingHeaders(loginCookies!),
    });
    expect(refused.statusCode).toBe(403);

    // Step 3: complete an OTP verification for the SAME address.
    const otpReq = await requestOtp(email);
    expect(otpReq.statusCode).toBe(OTP_REQUEST_SUCCESS_STATUS);
    const code = fakeSender.latestCodeFor(email)!;
    const otpVerify = await verifyOtp(email, code);
    expect(otpVerify.statusCode).toBe(200);
    const otpCookies = extractAuthCookies(otpVerify);
    expect(otpCookies).not.toBeNull();

    const afterRow = await db.query("SELECT status, email_verified_at FROM users WHERE email = $1", [email]);
    expect(afterRow.rows[0].status).toBe("active");
    expect(afterRow.rows[0].email_verified_at).not.toBeNull();

    // Step 4: now succeeds.
    const allowed = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "Now Allowed" },
      ...mutatingHeaders(otpCookies!),
    });
    expect(allowed.statusCode).toBe(201);
  });
});
