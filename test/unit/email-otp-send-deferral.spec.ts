import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailOtpService } from "../../src/modules/identity/email-otp.service.js";
import type { EmailMessage, EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import type { SessionService } from "../../src/modules/identity/session.service.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../support/test-valkey.js";

// STORY-016 fix 2 (code-reviewer finding) — requestCode's
// `this.emailSender.send(...)` call is fire-and-forget, but calling an
// async function still runs its body synchronously up to its first
// `await`, and a real adapter (LoggingEmailSenderAdapter) does real
// synchronous work there (env read, HMAC, a log call) on the known-address
// branch only — existence-correlated cost outside the measured response.
// This isolates the fix (deferred via setImmediate) against a fake pg pool,
// no real database — same fake-pool-directly precedent as
// identity-finish-registration-promotion.spec.ts.
describe("STORY-016 · EmailOtpService.requestCode defers the email-send call past its own settling", () => {
  const originalEnv = { ...process.env };

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
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("has invoked EmailSender.send() zero times immediately after requestCode() settles, and exactly once after the next macrotask tick", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SELECT pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (sql.includes("count(*)::int AS cnt")) {
        return { rows: [{ cnt: 0, oldest: null }] };
      }
      if (sql.startsWith("INSERT INTO email_otp_requests")) {
        return { rows: [] };
      }
      throw new Error(`unexpected client query: ${sql}`);
    });
    const client = { query: clientQuery, release: vi.fn() };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("SELECT id FROM users")) {
          return { rows: [{ id: "01926a1e-0000-7000-8000-000000000001" }] };
        }
        if (sql.startsWith("INSERT INTO email_otp_codes")) {
          return { rows: [] };
        }
        throw new Error(`unexpected pool query: ${sql}`);
      }),
    } as unknown as Pool;

    const sendCalls: EmailMessage[] = [];
    const emailSender: EmailSender = {
      async send(message: EmailMessage): Promise<void> {
        sendCalls.push(message);
      },
    };
    const sessions = {} as unknown as SessionService;

    const service = new EmailOtpService(pool, emailSender, sessions);
    await service.requestCode("known@example.com", null, "req-1");

    // The known-address branch resolved (outcome !== null), but the send
    // call itself must not have run yet — not even its synchronous prefix —
    // in the same turn requestCode() settled in.
    expect(sendCalls.length).toBe(0);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]!.to).toBe("known@example.com");
  });
});
