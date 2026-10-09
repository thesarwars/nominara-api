import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { IdentityService } from "../../src/modules/identity/identity.service.js";
import type { SessionService } from "../../src/modules/identity/session.service.js";
import type { RegistrationVerifyRequest } from "../../src/modules/identity/dto/index.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../support/test-valkey.js";

// STORY-173 — supersedes STORY-015's "bundled STORY-014 fix", which asserted
// the OPPOSITE: that a completed passkey registration promotes users.status
// from 'unverified' to 'active'. That promotion treated "someone completed a
// WebAuthn ceremony" as proof of control of the address, which it is not — it
// was half of an anonymous account takeover and let a passkey-only account
// reach 'active' with email_verified_at NULL. Only an email one-time code
// proves an address. This isolates the guarantee against a fake pg client:
// registering a credential issues no status change, and issues no credential
// insert at all unless the account's proof is read first.
vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>("@simplewebauthn/server");
  return { ...actual, verifyRegistrationResponse: vi.fn() };
});
const verifyRegistrationMock = verifyRegistrationResponse as unknown as Mock;

describe("STORY-173 · IdentityService.verifyRegistration never promotes users.status", () => {
  const originalEnv = { ...process.env };
  const userId = "01926a1e-0000-7000-8000-000000000001";

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";
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
    process.env.VALKEY_CACHE_URL = testCacheRedisUrl();
    process.env.QUEUE_REDIS_URL = testQueueRedisUrl();
    process.env.ENGINE_TOKEN_BUCKETS = '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}';
    process.env.QUEUE_JOB_SIGNING_KEY = Buffer.alloc(32, 1).toString("base64");
    process.env.QUEUE_JOB_SIGNING_KID = "test-queue-kid-1";
    verifyRegistrationMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function harness(proved: boolean) {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("UPDATE webauthn_challenges")) {
          return { rows: [{ challenge: Buffer.from("challenge") }] };
        }
        if (sql.includes("FROM users") && sql.includes("email_verified_at IS NOT NULL")) {
          return { rows: proved ? [{ id: userId, email: "a@example.com" }] : [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const sessions = { createSession: vi.fn() } as unknown as SessionService;
    verifyRegistrationMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0 },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    return { queries, service: new IdentityService(pool, sessions), sessions };
  }
  const fresh = { lastStrongAuthAt: new Date(), lastStrongAuthMethod: "email_otp" };
  const body = {
    ceremony_id: "01926a1e-0000-7000-8000-000000000002",
    response: { id: "cred-1", rawId: "cred-1", type: "public-key", clientExtensionResults: {}, response: {} },
  } as unknown as RegistrationVerifyRequest;

  it("registers a credential for a proved account without touching users.status and without minting a session", async () => {
    const { queries, service, sessions } = harness(true);
    await service.verifyRegistration(userId, fresh, body);
    expect(queries.some((q) => q.includes("INSERT INTO user_credentials"))).toBe(true);
    expect(queries.filter((q) => /UPDATE\s+users/i.test(q))).toEqual([]);
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it("inserts nothing for an account whose address is not proved", async () => {
    const { queries, service } = harness(false);
    await expect(service.verifyRegistration(userId, fresh, body)).rejects.toThrow(/not been verified/);
    expect(queries.some((q) => q.includes("INSERT INTO user_credentials"))).toBe(false);
    expect(queries).toContain("ROLLBACK");
  });
});
