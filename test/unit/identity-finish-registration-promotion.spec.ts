import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { IdentityService } from "../../src/modules/identity/identity.service.js";
import type { SessionService, SessionTokens } from "../../src/modules/identity/session.service.js";
import type { PasskeyVerifyRequest } from "../../src/modules/identity/dto/index.js";

// STORY-015 — unit-level regression for the bundled STORY-014 fix: without
// this UPDATE, every passkey user stays 'unverified' forever and silently
// loses the workspace-create right this story's AC4 gate reads
// (users.status). The end-to-end HTTP proof lives alongside it in
// test/integration/identity-oauth-pkce.spec.ts; this test isolates the
// promotion itself against a fake pg client, no real database.
vi.mock("@simplewebauthn/server", async () => {
  const actual = await vi.importActual<typeof import("@simplewebauthn/server")>("@simplewebauthn/server");
  return { ...actual, verifyRegistrationResponse: vi.fn() };
});
const verifyRegistrationMock = verifyRegistrationResponse as unknown as Mock;

describe("STORY-015 · IdentityService.finishRegistration promotes users.status", () => {
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
    process.env.VALKEY_CACHE_URL = "redis://localhost:6379";
    verifyRegistrationMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("issues UPDATE users SET status = 'active' ... for the registering user_id after a verified attestation", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        if (sql.startsWith("UPDATE webauthn_challenges")) {
          return {
            rows: [
              { id: "ceremony-1", purpose: "registration", user_id: userId, challenge: Buffer.from("challenge") },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const tokens: SessionTokens = { sid: "sid-1", accessToken: "a", refreshToken: "r", csrfToken: "c" };
    const sessions = { createSession: vi.fn().mockResolvedValue(tokens) } as unknown as SessionService;

    verifyRegistrationMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0 },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });

    const service = new IdentityService(pool, sessions);
    const result = await service.verifyPasskey({
      ceremony_id: "01926a1e-0000-7000-8000-000000000002",
      response: { id: "cred-1", rawId: "cred-1", type: "public-key", clientExtensionResults: {}, response: {} },
    } as unknown as PasskeyVerifyRequest);

    expect(result).toBe(tokens);
    const promotion = queries.find((q) => q.sql.includes("UPDATE users SET status = 'active'"));
    expect(promotion).toBeDefined();
    expect(promotion!.params).toEqual([userId]);
  });
});
