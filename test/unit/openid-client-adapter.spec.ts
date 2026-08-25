import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

// QA-ADDED: OpenidClientAdapter has ZERO coverage. The integration suite
// overrides OAUTH_CLIENT with a fake whose authorizationUrl() itself sets
// code_challenge_method=S256 — so scenario 1's PKCE assertions test the
// FIXTURE, not the real adapter. These tests cover the parts of the real
// adapter that need no network: generatePkce() and authorizationUrl().
const ENV = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  DATABASE_URL_POOLED: "postgres://u:p@localhost:6432/db",
  WEBAUTHN_RP_ID: "localhost",
  WEBAUTHN_RP_NAME: "Nominara",
  WEBAUTHN_ORIGIN: "http://localhost:3000",
  AUTH_TOKEN_ED25519_PRIVATE_KEY: "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1",
  AUTH_TOKEN_ED25519_PUBLIC_KEY: "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=",
  AUTH_TOKEN_ED25519_KID: "test-kid-1",
  CSRF_SECRET: "test-csrf-secret",
  WORKSPACE_DEK_WRAPPING_KEY: Buffer.alloc(32, 7).toString("base64"),
  OAUTH_REDIRECT_BASE_URL: "https://api.example.com",
  OAUTH_STATE_SECRET: "test-oauth-state-secret",
  OTP_EMAIL_HASH_PEPPER: "test-otp-email-hash-pepper",
  OTP_EMAIL_FROM: "Nominara <no-reply@nominara.test>",
  VALKEY_CACHE_URL: "redis://localhost:6379",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GITHUB_OAUTH_CLIENT_ID: "github-client-id",
  MICROSOFT_OAUTH_CLIENT_ID: "microsoft-client-id",
};

describe("STORY-015 · OpenidClientAdapter.generatePkce — the real S256 relationship", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("challenge is exactly BASE64URL(SHA-256(verifier)) — the S256 method it advertises", async () => {
    const { OpenidClientAdapter } = await import("../../src/modules/identity/adapters/openid-client.adapter.js");
    const adapter = new OpenidClientAdapter();
    const { verifier, challenge } = await adapter.generatePkce();
    const expected = createHash("sha256").update(verifier, "ascii").digest("base64url");
    expect(challenge).toBe(expected);
    expect(challenge).not.toBe(verifier);
    // RFC 7636 §4.1: 43..128 chars from the unreserved set.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("a fresh verifier on every call", async () => {
    const { OpenidClientAdapter } = await import("../../src/modules/identity/adapters/openid-client.adapter.js");
    const adapter = new OpenidClientAdapter();
    const a = await adapter.generatePkce();
    const b = await adapter.generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("STORY-015 · OpenidClientAdapter.authorizationUrl — real provider redirects", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  for (const provider of ["google", "github", "microsoft"] as const) {
    it(`${provider}: sends code_challenge + S256, echoes state, and NEVER leaks the verifier`, async () => {
      const { OpenidClientAdapter } = await import("../../src/modules/identity/adapters/openid-client.adapter.js");
      const adapter = new OpenidClientAdapter();
      const url = new URL(
        adapter.authorizationUrl({
          provider,
          redirectUri: "https://api.example.com/auth/oauth/" + provider + "/callback",
          codeChallenge: "challenge-value-abc",
          state: "state-value-xyz",
        }),
      );
      expect(url.protocol).toBe("https:");
      expect(url.searchParams.get("code_challenge")).toBe("challenge-value-abc");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("state")).toBe("state-value-xyz");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe(`${provider}-client-id`);
      expect(url.searchParams.get("redirect_uri")).toBe(
        `https://api.example.com/auth/oauth/${provider}/callback`,
      );
      expect(url.searchParams.get("code_verifier")).toBeNull();
      expect(url.toString()).not.toContain("client_secret");
    });
  }

  it("refuses to build a redirect for an unconfigured provider rather than sending an empty client_id", async () => {
    const { OpenidClientAdapter } = await import("../../src/modules/identity/adapters/openid-client.adapter.js");
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    const adapter = new OpenidClientAdapter();
    expect(() =>
      adapter.authorizationUrl({
        provider: "google",
        redirectUri: "https://api.example.com/auth/oauth/google/callback",
        codeChallenge: "c",
        state: "s",
      }),
    ).toThrow(/not configured/);
  });
});
