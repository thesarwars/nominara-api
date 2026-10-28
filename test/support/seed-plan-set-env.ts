import { resolvePassword } from "../../src/db/dev-credentials.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "./test-valkey.js";

// STORY-004 — the environment the synthetic seed hands the REAL `pnpm plan:set`
// child process in an integration test: a complete config (the CLI loads it
// all) whose DATABASE_URL_POOLED is the test container's `nominara_app`.
// Throwaway values only; nothing here is a credential.
export function planSetChildEnv(host: string, port: number, database: string): NodeJS.ProcessEnv {
  const pooled = `postgres://nominara_app:${resolvePassword("nominara_app", {})}@${host}:${String(port)}/${database}`;
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "development",
    DATABASE_URL: pooled,
    DATABASE_URL_POOLED: pooled,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_RP_NAME: "Nominara",
    WEBAUTHN_ORIGIN: "http://localhost:3000",
    AUTH_TOKEN_ED25519_PRIVATE_KEY: "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1",
    AUTH_TOKEN_ED25519_PUBLIC_KEY: "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=",
    AUTH_TOKEN_ED25519_KID: "test-kid-1",
    CSRF_SECRET: "test-csrf-secret",
    WORKSPACE_DEK_WRAPPING_KEY: Buffer.alloc(32, 7).toString("base64"),
    OAUTH_REDIRECT_BASE_URL: "http://localhost:4000",
    OAUTH_STATE_SECRET: "test-oauth-state-secret",
    OTP_EMAIL_HASH_PEPPER: "test-otp-email-hash-pepper",
    OTP_EMAIL_FROM: "Nominara <no-reply@nominara.test>",
    VALKEY_CACHE_URL: testCacheRedisUrl(),
    QUEUE_REDIS_URL: testQueueRedisUrl(),
    ENGINE_TOKEN_BUCKETS:
      '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}',
    ENGINE_SPEND_CEILINGS_USD: '{"gemini":100}',
    QUEUE_JOB_SIGNING_KEY: Buffer.alloc(32, 1).toString("base64"),
    QUEUE_JOB_SIGNING_KID: "test-queue-kid-1",
  };
}
