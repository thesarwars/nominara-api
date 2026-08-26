import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { registerCookiePlugin } from "../../src/api/register-cookies.js";
import { REQUEST_TIMING_FLOOR_MS } from "../../src/modules/identity/email-otp.service.js";
import { EMAIL_SENDER, type EmailMessage, type EmailSender } from "../../src/modules/identity/ports/email-sender.js";

// STORY-016 · Test Scenario 3 ONLY — kept in its own file so its statistical
// sampling loop (sample count, tolerance) can be tuned independently of the
// functional suite in identity-email-otp.spec.ts, without re-running every
// functional case each time the timing tolerance needs adjusting.
//
// Same port-boundary-fake precedent as identity-email-otp.spec.ts: only
// EMAIL_SENDER is faked, real Postgres via testcontainers throughout.
//
// This file is EXPECTED to fail red right now for the same reason as the
// functional suite — POST /auth/otp/request does not exist yet (route not
// found) — not because of a timing-measurement bug in the test itself.
class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

// code-reviewer finding (STORY-016 fix 1): 25 samples reusing the SAME two
// addresses hit email_otp_requests' 3/hour/address ledger (D5) after the
// 3rd sample each, so 22 of 25 "known" and "unknown" samples were both
// identical fast 429 rejections — trivially indistinguishable regardless
// of whether the anti-enumeration defense (verifyDecoy) exists at all.
// Every sample below now uses a distinct, never-reused address for BOTH
// arms, and a distinct remoteAddress (the "source" the per-source 30/min
// bucket keys on, per email-otp.service.ts's requestCode) so neither
// rate-limit bucket is ever touched during the run. 15 samples/arm (30
// requests total) is kept intentionally lower than the original 25 —
// enough for a coarse mean comparison at MAX_MEAN_DIFFERENCE_MS's
// tolerance without the loop's total wall time growing needlessly (each
// request pays the full REQUEST_TIMING_FLOOR_MS floor).
const SAMPLE_COUNT = 15;

// The uniform-timing floor primitive (src/lib/auth/uniform-timing.ts) is
// unit-tested already; this integration test's job is only to prove the
// two HTTP paths (known vs. unknown address) are NOT distinguishable by
// duration at the route level, at a coarse tolerance — same
// order-of-magnitude comparison style as test/unit/argon2id.spec.ts's
// verify-vs-verifyDecoy check, not a strict statistical hypothesis test
// (a strict one would be flaky under shared CI hardware).
const MAX_MEAN_DIFFERENCE_MS = 40;

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Distinct, valid, private-range IPv4 per call — the per-source 30/min bucket key. */
function sourceAddressFor(n: number): string {
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

describe("STORY-016 · scenario 3 — request-endpoint timing is indistinguishable for a known vs. unknown address", () => {
  let container: StartedPostgreSqlContainer;
  let app: NestFastifyApplication;
  let db: Client;
  let fakeSender: FakeEmailSender;
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
    process.env.VALKEY_CACHE_URL = "redis://localhost:6379";
    // STORY-030 — DbModule's PG_POOL factory calls loadEnv(), which (since
    // Phase B) also requires the queue-signing env vars even though this
    // file never signs a job payload itself.
    process.env.QUEUE_REDIS_URL = "redis://localhost:6380";
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

    fakeSender = new FakeEmailSender();
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(fakeSender)
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

  it("STORY-016 · scenario 3 — mean duration of N requests for a known address vs. an unknown address is not meaningfully distinguishable", async () => {
    // One never-reused known address per sample, all seeded up front so the
    // INSERTs themselves never land inside a measured request's duration.
    const knownEmails = Array.from({ length: SAMPLE_COUNT }, (_, i) => `timing-known-${i}@example.com`);
    for (const knownEmail of knownEmails) {
      await db.query("INSERT INTO users (email) VALUES ($1)", [knownEmail]);
    }

    const knownDurationsMs: number[] = [];
    const unknownDurationsMs: number[] = [];
    const statusCodes: number[] = [];
    let sourceCounter = 0;

    // Interleaved (not known-block-then-unknown-block) so a slow drift over
    // the sampling window (GC pause, connection-pool warmup) affects both
    // arms roughly equally rather than biasing whichever arm ran second.
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const knownStart = performance.now();
      const knownRes = await app.inject({
        method: "POST",
        url: "/auth/otp/request",
        remoteAddress: sourceAddressFor(sourceCounter++),
        payload: { email: knownEmails[i] },
      });
      knownDurationsMs.push(performance.now() - knownStart);
      statusCodes.push(knownRes.statusCode);

      const unknownStart = performance.now();
      const unknownRes = await app.inject({
        method: "POST",
        url: "/auth/otp/request",
        remoteAddress: sourceAddressFor(sourceCounter++),
        payload: { email: `timing-unknown-${i}@example.com` },
      });
      unknownDurationsMs.push(performance.now() - unknownStart);
      statusCodes.push(unknownRes.statusCode);
    }

    // The comparison below is meaningless if any sample was rate-limited
    // rather than reaching withUniformDuration — assert every sample
    // actually got past the rate limiter (this is what code-reviewer's
    // finding was: the old version silently never reached this).
    expect(statusCodes.every((code) => code === 201)).toBe(true);

    const meanKnown = mean(knownDurationsMs);
    const meanUnknown = mean(unknownDurationsMs);

    // Gap 4 (qa-reviewer, DoD "proven by measurement, not by inspection") —
    // indistinguishability alone doesn't prove the floor is wired in: two
    // arms that both skip withUniformDuration entirely would also pass the
    // difference check above. Assert the floor is actually a lower bound on
    // wall time.
    expect(meanKnown).toBeGreaterThanOrEqual(REQUEST_TIMING_FLOOR_MS);

    expect(Math.abs(meanKnown - meanUnknown)).toBeLessThan(MAX_MEAN_DIFFERENCE_MS);
  });
});
