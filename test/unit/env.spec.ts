import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "../../src/config/env.js";
import { KNOWN_KEYS } from "../../src/config/env.js";
import { envSchema } from "../../src/config/env.schema.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../support/test-valkey.js";

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
  // STORY-016 — email OTP. OTP_EMAIL_HASH_PEPPER keys the rate-limit
  // ledger's peppered email hash; a new secret, distinct from
  // CSRF_SECRET/OAUTH_STATE_SECRET. OTP_EMAIL_FROM is a non-secret display
  // string for the sender address shown on the delivered email.
  OTP_EMAIL_HASH_PEPPER: "test-otp-email-hash-pepper",
  OTP_EMAIL_FROM: "Nominara <no-reply@nominara.test>",
  // STORY-025 — the Valkey CACHE instance. Required, with no default: a
  // default connection string is how a service silently talks to the wrong
  // cache, and this schema exists to make that a failed boot instead.
  VALKEY_CACHE_URL: testCacheRedisUrl(),
  // STORY-030 — the queue instance's connection, and the rotating
  // HMAC-SHA256 key that signs every tenant-scoped job payload
  // (src/lib/queue/signing.ts). QUEUE_JOB_SIGNING_PREVIOUS_KEY/_KID are
  // optional — set only during a rotation's overlap window.
  QUEUE_REDIS_URL: testQueueRedisUrl(),
  QUEUE_JOB_SIGNING_KEY: Buffer.alloc(32, 1).toString("base64"),
  QUEUE_JOB_SIGNING_KID: "test-queue-kid-1",
  // STORY-031 D7 — per-engine token-bucket capacity/refill JSON, on the
  // SAME cache Valkey instance as VALKEY_CACHE_URL above (D6, consolidated
  // onto STORY-025's instance rather than a second one). ENGINE_SPEND_CEILINGS_USD
  // (D13) is deliberately absent here — it is optional config, covered separately.
  ENGINE_TOKEN_BUCKETS: JSON.stringify({
    google_aio: { capacity: 10, refillPerSecond: 1 },
    google_ai_mode: { capacity: 10, refillPerSecond: 1 },
    perplexity: { capacity: 10, refillPerSecond: 1 },
    chatgpt: { capacity: 10, refillPerSecond: 1 },
    gemini: { capacity: 10, refillPerSecond: 1 },
    claude: { capacity: 10, refillPerSecond: 1 },
  }),
};

describe("STORY-022 · env validation — refuses to start on missing/malformed config", () => {
  it("loads successfully with every required value present, applying documented defaults", () => {
    const env = loadEnv(VALID);
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.DATABASE_URL_POOLED).toBe(VALID.DATABASE_URL_POOLED);
    expect(env.NODE_ENV).toBe("development");
    // 4000, not 3000 — 3000 is the frontend's port, and the two run side by
    // side in development. WEBAUTHN_ORIGIN above still names 3000 because it
    // is a BROWSER origin, not this service's address.
    expect(env.PORT).toBe(4000);
    expect(env.GATEWAY_PORT).toBe(3001);
    expect(env.WORKER_GROUP).toBeUndefined();
    expect(env.WORKSPACE_KMS_KEY_ARN).toBe("local:dev");
  });

  it("STORY-021-E-10 · a WORKSPACE_DEK_WRAPPING_KEY that does not decode to 32 bytes throws, naming that exact key", () => {
    expect(() => loadEnv({ ...VALID, WORKSPACE_DEK_WRAPPING_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /WORKSPACE_DEK_WRAPPING_KEY/,
    );
  });

  it("STORY-170 · the grace window needs no new secret — a pre-STORY-170 environment still loads", () => {
    // The successor is encrypted under a key derived from the predecessor
    // token (refresh-token.ts), so an existing deployment's configuration
    // is unchanged by this feature.
    expect(() => loadEnv(VALID)).not.toThrow();
  });

  it("STORY-170 · REFRESH_TOKEN_GRACE_WINDOW_MS is optional and defaults to 2000", () => {
    const env = loadEnv(VALID);
    expect(env.REFRESH_TOKEN_GRACE_WINDOW_MS).toBe(2000);
  });

  it("STORY-170 · REFRESH_TOKEN_GRACE_WINDOW_MS above the hard maximum (5000) throws, naming that exact key", () => {
    expect(() => loadEnv({ ...VALID, REFRESH_TOKEN_GRACE_WINDOW_MS: "5001" })).toThrow(/REFRESH_TOKEN_GRACE_WINDOW_MS/);
  });

  it("STORY-170 · REFRESH_TOKEN_GRACE_WINDOW_MS accepts 0 — the documented way to disable the grace window without a redeploy", () => {
    const env = loadEnv({ ...VALID, REFRESH_TOKEN_GRACE_WINDOW_MS: "0" });
    expect(env.REFRESH_TOKEN_GRACE_WINDOW_MS).toBe(0);
  });

  // "0" is the switch that DISABLES grace, and z.coerce.number() turns ""
  // (and any whitespace) into 0. `REFRESH_TOKEN_GRACE_WINDOW_MS=` in a deploy
  // template must therefore mean "not set", or it silently turns the feature
  // off with no error and no log line.
  it.each([["an empty string", ""], ["a single space", " "], ["tabs and newlines", "\t \n"]])(
    "STORY-170 · REFRESH_TOKEN_GRACE_WINDOW_MS as %s is UNSET (the 2000 default), never 0 — it must not silently disable grace",
    (_label, value) => {
      const env = loadEnv({ ...VALID, REFRESH_TOKEN_GRACE_WINDOW_MS: value });
      expect(env.REFRESH_TOKEN_GRACE_WINDOW_MS).toBe(2000);
    },
  );

  it("STORY-170 · REFRESH_TOKEN_GRACE_WINDOW_MS accepts exactly the hard maximum (5000) and rejects 5001 — the cap is rejected at boot, not clamped", () => {
    expect(loadEnv({ ...VALID, REFRESH_TOKEN_GRACE_WINDOW_MS: "5000" }).REFRESH_TOKEN_GRACE_WINDOW_MS).toBe(5000);
    expect(() => loadEnv({ ...VALID, REFRESH_TOKEN_GRACE_WINDOW_MS: "5001" })).toThrow(/REFRESH_TOKEN_GRACE_WINDOW_MS/);
    expect(() => loadEnv({ ...VALID, REFRESH_TOKEN_GRACE_WINDOW_MS: "60000" })).toThrow(/REFRESH_TOKEN_GRACE_WINDOW_MS/);
  });

  it.each([["negative", "-1"], ["fractional", "2000.5"], ["not a number", "two seconds"]])(
    "STORY-170 · REFRESH_TOKEN_GRACE_WINDOW_MS that is %s throws, naming that exact key",
    (_label, value) => {
      expect(() => loadEnv({ ...VALID, REFRESH_TOKEN_GRACE_WINDOW_MS: value })).toThrow(/REFRESH_TOKEN_GRACE_WINDOW_MS/);
    },
  );

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

  // STORY-141 AC 8 — DATABASE_URL carries the reconciler's session advisory lock
  // and must be the DIRECT connection, never pgBouncer (transaction pooling
  // strands a session lock on a backend nobody owns).
  describe("STORY-141 AC 8 · DATABASE_URL must not be the pooler", () => {
    it.each([
      ["the documented pooler port 6432", "postgres://nominara:nominara@localhost:6432/nominara"],
      ["the compose pooler service host", "postgres://nominara:nominara@pgbouncer:5432/nominara"],
      ["the pooler host in any case", "postgres://nominara:nominara@PgBouncer:5432/nominara"],
    ])("refuses to boot when DATABASE_URL is %s, naming DATABASE_URL", (_label, url) => {
      expect(() => loadEnv({ ...VALID, DATABASE_URL: url })).toThrow(EnvValidationError);
      expect(() => loadEnv({ ...VALID, DATABASE_URL: url })).toThrow(/DATABASE_URL: .*pooler/i);
    });

    it("accepts a direct DATABASE_URL (5432, and the 55432 host mapping) alongside a pooled DATABASE_URL_POOLED", () => {
      expect(() => loadEnv(VALID)).not.toThrow();
      expect(() =>
        loadEnv({ ...VALID, DATABASE_URL: "postgres://nominara:nominara@localhost:55432/nominara" }),
      ).not.toThrow();
    });

    it("does not constrain DATABASE_URL_POOLED, which IS the pooler by design", () => {
      expect(() =>
        loadEnv({ ...VALID, DATABASE_URL_POOLED: "postgres://nominara_app:x@pgbouncer:5432/nominara" }),
      ).not.toThrow();
    });

    it("still accepts a direct URL that merely contains the digits 6432 elsewhere (port is compared, not substring)", () => {
      expect(() =>
        loadEnv({ ...VALID, DATABASE_URL: "postgres://nominara:p6432@localhost:5432/db6432" }),
      ).not.toThrow();
    });
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

  it("STORY-016 · boots successfully with OTP_EMAIL_HASH_PEPPER and OTP_EMAIL_FROM present", () => {
    const env = loadEnv(VALID);
    expect(env.OTP_EMAIL_HASH_PEPPER).toBe(VALID.OTP_EMAIL_HASH_PEPPER);
    expect(env.OTP_EMAIL_FROM).toBe(VALID.OTP_EMAIL_FROM);
  });

  it("STORY-016 · a MISSING OTP_EMAIL_HASH_PEPPER throws, naming that exact key", () => {
    const { OTP_EMAIL_HASH_PEPPER: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(/OTP_EMAIL_HASH_PEPPER/);
  });

  it("STORY-016 · a MISSING OTP_EMAIL_FROM throws, naming that exact key", () => {
    const { OTP_EMAIL_FROM: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(/OTP_EMAIL_FROM/);
  });

  it("STORY-030 · boots successfully with the queue connection and current signing key, no previous key/kid present", () => {
    const env = loadEnv(VALID);
    expect(env.QUEUE_REDIS_URL).toBe(VALID.QUEUE_REDIS_URL);
    expect(env.QUEUE_JOB_SIGNING_KEY).toBe(VALID.QUEUE_JOB_SIGNING_KEY);
    expect(env.QUEUE_JOB_SIGNING_KID).toBe(VALID.QUEUE_JOB_SIGNING_KID);
    expect(env.QUEUE_JOB_SIGNING_PREVIOUS_KEY).toBeUndefined();
    expect(env.QUEUE_JOB_SIGNING_PREVIOUS_KID).toBeUndefined();
  });

  it("STORY-030 · boots successfully with a previous key/kid present — a rotation's overlap window", () => {
    const previousKey = Buffer.alloc(32, 2).toString("base64");
    const env = loadEnv({
      ...VALID,
      QUEUE_JOB_SIGNING_PREVIOUS_KEY: previousKey,
      QUEUE_JOB_SIGNING_PREVIOUS_KID: "test-queue-kid-0",
    });
    expect(env.QUEUE_JOB_SIGNING_PREVIOUS_KEY).toBe(previousKey);
    expect(env.QUEUE_JOB_SIGNING_PREVIOUS_KID).toBe("test-queue-kid-0");
  });

  it("STORY-030 · a MISSING QUEUE_REDIS_URL throws, naming that exact key", () => {
    const { QUEUE_REDIS_URL: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(/QUEUE_REDIS_URL/);
  });

  it("STORY-030 · a MISSING QUEUE_JOB_SIGNING_KEY throws, naming that exact key", () => {
    const { QUEUE_JOB_SIGNING_KEY: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(/QUEUE_JOB_SIGNING_KEY/);
  });

  it("STORY-030 · a QUEUE_JOB_SIGNING_KEY that does not decode to 32 bytes throws, naming that exact key", () => {
    expect(() =>
      loadEnv({ ...VALID, QUEUE_JOB_SIGNING_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/QUEUE_JOB_SIGNING_KEY/);
  });

  it("STORY-030 · a MISSING QUEUE_JOB_SIGNING_KID throws, naming that exact key", () => {
    const { QUEUE_JOB_SIGNING_KID: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(/QUEUE_JOB_SIGNING_KID/);
  });

  it("STORY-030 · a QUEUE_JOB_SIGNING_PREVIOUS_KEY that does not decode to 32 bytes throws, naming that exact key", () => {
    expect(() =>
      loadEnv({ ...VALID, QUEUE_JOB_SIGNING_PREVIOUS_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/QUEUE_JOB_SIGNING_PREVIOUS_KEY/);
  });

  it("STORY-031 · boots successfully with ENGINE_TOKEN_BUCKETS present, no spend ceilings", () => {
    const env = loadEnv(VALID);
    expect(env.ENGINE_TOKEN_BUCKETS).toBe(VALID.ENGINE_TOKEN_BUCKETS);
    expect(env.ENGINE_SPEND_CEILINGS_USD).toBeUndefined();
  });

  // STORY-025 declares VALKEY_CACHE_URL; no test in this file exercised its
  // required-ness until STORY-031 (which reuses this same cache instance
  // for token buckets/breaker state, D6) needed to touch this area anyway.
  it("STORY-025 · a MISSING VALKEY_CACHE_URL throws, naming that exact key", () => {
    const { VALKEY_CACHE_URL: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(/VALKEY_CACHE_URL/);
  });

  it("STORY-031 · a MISSING ENGINE_TOKEN_BUCKETS throws, naming that exact key", () => {
    const { ENGINE_TOKEN_BUCKETS: _drop, ...rest } = VALID;
    expect(() => loadEnv(rest)).toThrow(/ENGINE_TOKEN_BUCKETS/);
  });

  it("STORY-031 · an ENGINE_TOKEN_BUCKETS that isn't JSON throws, naming that exact key", () => {
    expect(() => loadEnv({ ...VALID, ENGINE_TOKEN_BUCKETS: "not-json" })).toThrow(/ENGINE_TOKEN_BUCKETS/);
  });

  it("STORY-031 · an ENGINE_TOKEN_BUCKETS with an unknown engine key throws", () => {
    const malformed = JSON.stringify({ not_a_real_engine: { capacity: 10, refillPerSecond: 1 } });
    expect(() => loadEnv({ ...VALID, ENGINE_TOKEN_BUCKETS: malformed })).toThrow(/ENGINE_TOKEN_BUCKETS/);
  });

  it("STORY-031 · an ENGINE_TOKEN_BUCKETS entry with a non-positive capacity throws", () => {
    const malformed = JSON.stringify({ chatgpt: { capacity: 0, refillPerSecond: 1 } });
    expect(() => loadEnv({ ...VALID, ENGINE_TOKEN_BUCKETS: malformed })).toThrow(/ENGINE_TOKEN_BUCKETS/);
  });

  it("STORY-031 · boots successfully with ENGINE_SPEND_CEILINGS_USD present", () => {
    const ceilings = JSON.stringify({ chatgpt: 500, claude: 250 });
    const env = loadEnv({ ...VALID, ENGINE_SPEND_CEILINGS_USD: ceilings });
    expect(env.ENGINE_SPEND_CEILINGS_USD).toBe(ceilings);
  });

  it("STORY-031 · an ENGINE_SPEND_CEILINGS_USD with a non-positive ceiling throws", () => {
    const malformed = JSON.stringify({ chatgpt: 0 });
    expect(() => loadEnv({ ...VALID, ENGINE_SPEND_CEILINGS_USD: malformed })).toThrow(/ENGINE_SPEND_CEILINGS_USD/);
  });

  it("an unknown key is rejected the same way any strict contract schema rejects mass assignment", () => {
    // Loader only ever hands the schema the KNOWN_KEYS subset of process.env,
    // so this exercises the schema's own .strict() directly rather than via
    // loadEnv (which would just silently drop an unpicked key).
    const result = envSchema.safeParse({ ...VALID, UNKNOWN_KEY: "x" });
    expect(result.success).toBe(false);
  });
});

// STORY-127 — the loader's allow-list and the schema must agree.
describe("STORY-127 · KNOWN_KEYS covers the schema", () => {
  it("every key envSchema declares is picked from process.env", () => {
    // A variable added to the schema but not to KNOWN_KEYS is dropped
    // before parsing: the process boots, the setting silently does nothing,
    // and there is no error to trace. This assertion is the only thing that
    // notices.
    const schemaKeys = Object.keys(envSchema._def.shape ?? envSchema.shape).sort();
    const missing = schemaKeys.filter((key) => !(KNOWN_KEYS as readonly string[]).includes(key));
    expect(missing, "in envSchema but missing from KNOWN_KEYS").toEqual([]);
  });

  it("every key KNOWN_KEYS picks is one the schema declares", () => {
    // The other direction: a stale entry left behind after a rename. The
    // schema is `.strict()`, so this would fail every boot — but naming it
    // here says WHICH key rather than "unrecognized_keys".
    const schemaKeys = new Set(Object.keys(envSchema._def.shape ?? envSchema.shape));
    const stale = (KNOWN_KEYS as readonly string[]).filter((key) => !schemaKeys.has(key));
    expect(stale, "in KNOWN_KEYS but not declared by envSchema").toEqual([]);
  });
});

describe("NEW-D-2 · Stripe configuration is optional — the API boots without a payment provider", () => {
  it("loads with none of the three Stripe variables set, and leaves them undefined", () => {
    const env = loadEnv(VALID);
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(env.STRIPE_PUBLISHABLE_KEY).toBeUndefined();
  });

  it("reads all three when present", () => {
    const env = loadEnv({ ...VALID, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PUBLISHABLE_KEY: "pk_test_x" });
    expect([env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET, env.STRIPE_PUBLISHABLE_KEY]).toEqual(["sk_test_x", "whsec_x", "pk_test_x"]);
  });

  it("a blank value is refused rather than read as 'configured' — a blank secret would verify nothing", () => {
    expect(() => loadEnv({ ...VALID, STRIPE_WEBHOOK_SECRET: "  " })).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });
});

