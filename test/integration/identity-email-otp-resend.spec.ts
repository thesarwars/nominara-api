import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { registerCookiePlugin } from "../../src/api/register-cookies.js";
import { REQUEST_TIMING_FLOOR_MS } from "../../src/modules/identity/email-otp.service.js";
import { ResendEmailSenderAdapter } from "../../src/modules/identity/adapters/resend-email-sender.adapter.js";
import { EMAIL_SENDER } from "../../src/modules/identity/ports/email-sender.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../support/test-valkey.js";

// Group C item 1 — STORY-016 scenario 3 must still hold with a REAL network send behind the port.
//
// The port's implementation here is the real ResendEmailSenderAdapter over a FAKE fetch (never the real Resend API).
// The fake is SLOW for a known address and instant for an unknown one: if the send were awaited inside the request,
// or inside the uniform-duration envelope, the known arm would be ~SEND_LATENCY_MS slower and the means would
// diverge. They must not, because EmailOtpService defers the send past the envelope (setImmediate).

const SAMPLE_COUNT = 8;
const SEND_LATENCY_MS = 600;
const MAX_MEAN_DIFFERENCE_MS = 40;

interface Delivery {
  readonly to: string;
  readonly text: string;
  readonly authorization: string;
  readonly settledAt: number;
}
let deliveries: Delivery[] = [];

const slowFakeResend: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { to: string[]; text: string };
  const to = body.to[0]!;
  if (to.startsWith("resend-known-")) {
    await new Promise((resolve) => setTimeout(resolve, SEND_LATENCY_MS));
  }
  deliveries.push({
    to,
    text: body.text,
    authorization: (init?.headers as Record<string, string>).Authorization!,
    settledAt: performance.now(),
  });
  return new Response(JSON.stringify({ id: "msg_fake" }), { status: 200, headers: { "content-type": "application/json" } });
};

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sourceAddressFor(n: number): string {
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error("timed out waiting for the delivery");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Group C · email OTP over the Resend adapter", () => {
  let container: StartedPostgreSqlContainer;
  let app: NestFastifyApplication;
  let db: Client;
  let resendAdapter: ResendEmailSenderAdapter;
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
    process.env.VALKEY_CACHE_URL = testCacheRedisUrl();
    // STORY-030 — DbModule's PG_POOL factory calls loadEnv(), which (since
    // Phase B) also requires the queue-signing env vars even though this
    // file never signs a job payload itself.
    process.env.QUEUE_REDIS_URL = testQueueRedisUrl();
    process.env.ENGINE_TOKEN_BUCKETS = '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}';
    process.env.QUEUE_JOB_SIGNING_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.QUEUE_JOB_SIGNING_KID = "test-queue-kid-1";

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    deliveries = [];
    resendAdapter = new ResendEmailSenderAdapter({
      apiKey: "re_test_PLACEHOLDER_KEY_0000",
      from: "Nominara <no-reply@nominara.test>",
      fetch: slowFakeResend,
      sleep: async () => {},
    });
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(resendAdapter)
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

  it("the OTP flow delivers its code through the Resend adapter, and that code signs the person in", async () => {
    const email = "resend-known-flow@example.com";
    await db.query("INSERT INTO users (email) VALUES ($1)", [email]);

    const res = await app.inject({ method: "POST", url: "/auth/otp/request", remoteAddress: sourceAddressFor(900), payload: { email } });
    expect(res.statusCode).toBe(201);

    await waitFor(() => deliveries.length === 1);
    const delivery = deliveries[0]!;
    expect(delivery.to).toBe(email);
    expect(delivery.authorization).toBe("Bearer re_test_PLACEHOLDER_KEY_0000");
    const code = /(\d{8})/.exec(delivery.text)?.[1];
    expect(code).toBeDefined();

    const verify = await app.inject({ method: "POST", url: "/auth/otp/verify", remoteAddress: sourceAddressFor(901), payload: { email, code } });
    expect(verify.statusCode).toBe(200);
  });

  it("a slow real send does not change request timing: known (600 ms send) vs unknown (instant send) stay indistinguishable, and the request returns before the send settles", async () => {
    const knownEmails = Array.from({ length: SAMPLE_COUNT }, (_, i) => `resend-known-${i}@example.com`);
    for (const knownEmail of knownEmails) {
      await db.query("INSERT INTO users (email) VALUES ($1)", [knownEmail]);
    }

    const knownMs: number[] = [];
    const unknownMs: number[] = [];
    const statusCodes: number[] = [];
    let sourceCounter = 0;
    let lastKnownReturnedAt = 0;

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const knownStart = performance.now();
      const knownRes = await app.inject({
        method: "POST",
        url: "/auth/otp/request",
        remoteAddress: sourceAddressFor(sourceCounter++),
        payload: { email: knownEmails[i] },
      });
      lastKnownReturnedAt = performance.now();
      knownMs.push(lastKnownReturnedAt - knownStart);
      statusCodes.push(knownRes.statusCode);

      const unknownStart = performance.now();
      const unknownRes = await app.inject({
        method: "POST",
        url: "/auth/otp/request",
        remoteAddress: sourceAddressFor(sourceCounter++),
        payload: { email: `resend-unknown-${i}@example.com` },
      });
      unknownMs.push(performance.now() - unknownStart);
      statusCodes.push(unknownRes.statusCode);
    }

    expect(statusCodes.every((code) => code === 201)).toBe(true);
    expect(mean(knownMs)).toBeGreaterThanOrEqual(REQUEST_TIMING_FLOOR_MS);
    expect(Math.abs(mean(knownMs) - mean(unknownMs))).toBeLessThan(MAX_MEAN_DIFFERENCE_MS);

    // Both arms really did send (so the comparison above is not vacuous), and the last slow send was still in flight
    // when its request had already returned.
    await waitFor(() => deliveries.length === SAMPLE_COUNT * 2);
    const lastKnownDelivery = deliveries.filter((d) => d.to.startsWith("resend-known-")).at(-1)!;
    expect(lastKnownDelivery.settledAt).toBeGreaterThan(lastKnownReturnedAt + SEND_LATENCY_MS / 2);
  });
});
