import { Body, Controller, Get, Post } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { Public } from "../../src/api/decorators/public.decorator.js";
import { PG_POOL } from "../../src/db/pg-pool.js";
import { testCacheRedisUrl, testQueueRedisUrl } from "../support/test-valkey.js";

// STORY-024 AC9 / scenario 8 — "Any response carries the request identifier,
// and it matches the trace." The identifier IS the 32-hex OpenTelemetry trace
// id (owner decision 2026-10-13 #1), and a caller cannot choose it (#2).
const TRACE_ID = /^[0-9a-f]{32}$/;
const INBOUND_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const INBOUND_TRACEPARENT = `00-${INBOUND_TRACE_ID}-00f067aa0ba902b7-01`;

interface Seen {
  traceId: string | undefined;
  inboundAttribute: unknown;
}
const seen: Seen[] = [];

function recordActiveSpan(): void {
  const span = trace.getActiveSpan();
  const attributes = (span as unknown as { attributes?: Record<string, unknown> } | undefined)?.attributes ?? {};
  seen.push({
    traceId: span?.spanContext().traceId,
    inboundAttribute: Object.values(attributes).find((value) => value === "caller-chosen-id"),
  });
}

@Controller("test-trace")
class TraceController {
  @Get("ok")
  @Public()
  ok(): { ok: true } {
    recordActiveSpan();
    return { ok: true };
  }

  @Post("echo")
  @Public()
  echo(@Body() body: unknown): unknown {
    recordActiveSpan();
    return body;
  }

  @Get("throws")
  @Public()
  throws(): never {
    recordActiveSpan();
    throw new Error("internal detail");
  }

  @Get("guarded")
  guarded(): { ok: true } {
    return { ok: true };
  }
}

describe("STORY-024 · request_id is the OpenTelemetry trace id", () => {
  let app: NestFastifyApplication;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    seen.length = 0;
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
    process.env.ENGINE_TOKEN_BUCKETS =
      '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}';
    process.env.QUEUE_JOB_SIGNING_KEY = Buffer.alloc(32, 1).toString("base64");
    process.env.QUEUE_JOB_SIGNING_KID = "test-queue-kid-1";
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule], controllers: [TraceController] })
      .overrideProvider(PG_POOL)
      .useValue({ query: async () => ({ rows: [] }), end: async () => {} })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it("[STORY-024 scenario 8] meta.request_id is 32 lowercase hex and equals the active span's trace id", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/test-trace/ok" });

    expect(response.statusCode).toBe(200);
    const requestId = response.json().meta.request_id as string;
    expect(requestId).toMatch(TRACE_ID);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.traceId, "the handler must run inside a server span").toBe(requestId);
    expect(response.headers["x-request-id"]).toBe(requestId);
  });

  it("[STORY-024 scenario 8] the span is still active in a handler that reads a request body", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/test-trace/echo", payload: { a: 1 } });

    expect(response.statusCode).toBe(201);
    expect(seen[0]?.traceId).toBe(response.json().meta.request_id);
  });

  it("[STORY-024 scenario 8] an error response's request_id is the same trace id", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/test-trace/throws" });

    expect(response.statusCode).toBe(500);
    const requestId = response.json().error.request_id as string;
    expect(requestId).toMatch(TRACE_ID);
    expect(requestId).toBe(seen[0]?.traceId);
    expect(response.headers["x-request-id"]).toBe(requestId);
  });

  it("[STORY-024 scenario 8] a request refused by a guard (before any interceptor) still carries a 32-hex id", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/test-trace/guarded" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.request_id).toMatch(TRACE_ID);
  });

  it("[STORY-024 scenario 8] an unmatched route (framework 404) carries a 32-hex id", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/does-not-exist" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.request_id).toMatch(TRACE_ID);
  });

  it("[STORY-024 scenario 8] every request starts a fresh trace", async () => {
    const a = await app.inject({ method: "GET", url: "/v1/test-trace/ok" });
    const b = await app.inject({ method: "GET", url: "/v1/test-trace/ok" });

    expect(a.json().meta.request_id).not.toBe(b.json().meta.request_id);
  });

  it("[STORY-024 owner 2026-10-13 #2] an inbound traceparent does not choose the trace id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/test-trace/ok",
      headers: { traceparent: INBOUND_TRACEPARENT },
    });

    expect(response.json().meta.request_id).toMatch(TRACE_ID);
    expect(response.json().meta.request_id).not.toBe(INBOUND_TRACE_ID);
    expect(seen[0]?.traceId).not.toBe(INBOUND_TRACE_ID);
  });

  it("[STORY-024 owner 2026-10-13 #2] an inbound X-Request-Id is not echoed as the identity, on success or on error", async () => {
    const ok = await app.inject({ method: "GET", url: "/v1/test-trace/ok", headers: { "x-request-id": "caller-chosen-id" } });
    const failed = await app.inject({ method: "GET", url: "/v1/test-trace/throws", headers: { "x-request-id": "caller-chosen-id" } });

    expect(ok.json().meta.request_id).toMatch(TRACE_ID);
    expect(ok.headers["x-request-id"]).toBe(ok.json().meta.request_id);
    expect(failed.json().error.request_id).toMatch(TRACE_ID);
    expect(failed.headers["x-request-id"]).toBe(failed.json().error.request_id);
  });

  it("[STORY-024 owner 2026-10-13 #2] an inbound X-Request-Id is recorded on the span as an attribute only", async () => {
    await app.inject({ method: "GET", url: "/v1/test-trace/ok", headers: { "x-request-id": "caller-chosen-id" } });

    expect(seen[0]?.inboundAttribute).toBe("caller-chosen-id");
  });

  it("[STORY-024 observability] the request log lines carry the trace id and no body", async () => {
    const ok = await app.inject({ method: "GET", url: "/v1/test-trace/ok" });
    const failed = await app.inject({ method: "GET", url: "/v1/test-trace/throws" });

    const enveloped = (logSpy.mock.calls as unknown[][])
      .map((call) => call[0] as Record<string, unknown>)
      .find((entry) => entry.message === "response enveloped");
    expect(enveloped?.request_id).toBe(ok.json().meta.request_id);

    const refused = (errorSpy.mock.calls as unknown[][])
      .map((call) => call[0] as Record<string, unknown>)
      .find((entry) => entry.message === "request refused");
    expect(refused?.request_id).toBe(failed.json().error.request_id);
  });
});
