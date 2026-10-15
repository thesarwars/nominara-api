import { createServer } from "node:net";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAlertEmailerForTests } from "./lib/alerts/alerts.js";
import { bootstrap } from "./main.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../test/support/test-valkey.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// STORY-022 — NFR-ARCH-06: "Cold start <= 8s." Exercises the real
// bootstrap() function (FastifyAdapter + full ApiModule graph), not a
// stand-in, listening on an OS-assigned free port.
describe("STORY-022 · main.ts cold start", () => {
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

  it("boots the full API composition root and starts listening in under 8s", async () => {
    process.env.PORT = String(await getFreePort());

    const start = performance.now();
    const app = await bootstrap();
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(8000);

    await app.close();
  }, 15_000);

  it("Group C: with ALERT_EMAIL_TO unset the API says at boot that alerts go nowhere", async () => {
    process.env.PORT = String(await getFreePort());
    delete process.env.ALERT_EMAIL_TO;
    setAlertEmailerForTests(undefined);
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const app = await bootstrap();
    try {
      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.filter((message) => message.includes("ALERT_EMAIL_TO is not set"))).toHaveLength(1);
    } finally {
      await app.close();
      warnSpy.mockRestore();
      setAlertEmailerForTests(undefined);
    }
  }, 15_000);
});
