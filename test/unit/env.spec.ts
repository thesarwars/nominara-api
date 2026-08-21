import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "../../src/config/env.js";
import { envSchema } from "../../src/config/env.schema.js";

// STORY-022 scenario 6 — "Start with a required configuration value missing
// → Refuses to start, naming the value." Config validation lives at boot
// (src/config/env.schema.ts + env.ts), zod-based per STORY-022-E-4.

const VALID: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://nominara:nominara@localhost:5432/nominara",
  DATABASE_URL_POOLED: "postgres://nominara_app:x@localhost:6432/nominara",
  WEBAUTHN_RP_ID: "localhost",
  WEBAUTHN_RP_NAME: "Nominara",
  WEBAUTHN_ORIGIN: "http://localhost:3000",
  AUTH_TOKEN_ED25519_PRIVATE_KEY: "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1",
  AUTH_TOKEN_ED25519_PUBLIC_KEY: "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=",
  AUTH_TOKEN_ED25519_KID: "test-kid-1",
  CSRF_SECRET: "test-csrf-secret",
  WORKSPACE_DEK_WRAPPING_KEY: Buffer.alloc(32, 7).toString("base64"),
  // STORY-015 — OAuth 2.1 + PKCE. Required regardless of which provider
  // credentials are configured; the provider CLIENT_ID/SECRET pairs
  // themselves stay optional (tests fake the provider at a port boundary).
  OAUTH_REDIRECT_BASE_URL: "http://localhost:3000",
  OAUTH_STATE_SECRET: "test-oauth-state-secret",
};

describe("STORY-022 · env validation — refuses to start on missing/malformed config", () => {
  it("loads successfully with every required value present, applying documented defaults", () => {
    const env = loadEnv(VALID);
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.DATABASE_URL_POOLED).toBe(VALID.DATABASE_URL_POOLED);
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.GATEWAY_PORT).toBe(3001);
    expect(env.WORKER_GROUP).toBeUndefined();
    expect(env.WORKSPACE_KMS_KEY_ARN).toBe("local:dev");
  });

  it("STORY-021-E-10 · a WORKSPACE_DEK_WRAPPING_KEY that does not decode to 32 bytes throws, naming that exact key", () => {
    expect(() => loadEnv({ ...VALID, WORKSPACE_DEK_WRAPPING_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /WORKSPACE_DEK_WRAPPING_KEY/,
    );
  });

  it("a MISSING required var throws EnvValidationError naming that exact key", () => {
    const { DATABASE_URL: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it("an EMPTY STRING required var throws, naming that exact key", () => {
    expect(() => loadEnv({ ...VALID, DATABASE_URL_POOLED: "" })).toThrow(/DATABASE_URL_POOLED/);
  });

  it("a WHITESPACE-ONLY required var throws, naming that exact key", () => {
    expect(() => loadEnv({ ...VALID, DATABASE_URL: "   " })).toThrow(/DATABASE_URL/);
  });

  it("an invalid WORKER_GROUP value throws, naming that exact key", () => {
    expect(() => loadEnv({ ...VALID, WORKER_GROUP: "not-a-real-group" })).toThrow(/WORKER_GROUP/);
  });

  it("a non-numeric PORT throws, naming that exact key", () => {
    expect(() => loadEnv({ ...VALID, PORT: "not-a-number" })).toThrow(/PORT/);
  });

  it("STORY-015 · boots successfully with zero OAuth provider credentials present — every provider CLIENT_ID/SECRET is optional config", () => {
    const env = loadEnv(VALID);
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(env.GITHUB_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.GITHUB_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(env.MICROSOFT_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.MICROSOFT_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(env.OAUTH_REDIRECT_BASE_URL).toBe(VALID.OAUTH_REDIRECT_BASE_URL);
    expect(env.OAUTH_STATE_SECRET).toBe(VALID.OAUTH_STATE_SECRET);
  });

  it("STORY-015 · a MISSING OAUTH_STATE_SECRET throws, naming that exact key", () => {
    const { OAUTH_STATE_SECRET: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(/OAUTH_STATE_SECRET/);
  });

  it("STORY-015 · a MISSING OAUTH_REDIRECT_BASE_URL throws, naming that exact key", () => {
    const { OAUTH_REDIRECT_BASE_URL: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(/OAUTH_REDIRECT_BASE_URL/);
  });

  it("an unknown key is rejected the same way any strict contract schema rejects mass assignment", () => {
    // Loader only ever hands the schema the KNOWN_KEYS subset of process.env,
    // so this exercises the schema's own .strict() directly rather than via
    // loadEnv (which would just silently drop an unpicked key).
    const result = envSchema.safeParse({ ...VALID, UNKNOWN_KEY: "x" });
    expect(result.success).toBe(false);
  });
});
