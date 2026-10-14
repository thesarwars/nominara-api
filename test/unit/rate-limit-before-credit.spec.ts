import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { AuthGuard } from "../../src/api/guards/auth.guard.js";
import { CreditGuard } from "../../src/api/guards/credit.guard.js";
import { RateLimitBuckets, type RateLimitDecision } from "../../src/api/rate-limit/buckets.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-025 T15 row 8, and the epic's quality criterion: "the guard order is
// asserted by test, INCLUDING that a rate limit precedes any reservation."
//
// api-specification.md §12: "a credit-spending call that is rate-limited never
// reaches `CreditGuard`, so no reservation is created."
//
// The REAL RateLimitGuard runs here — only its bucket store is replaced, so
// what is proven is that the guard refuses and that the refusal stops the
// chain. Spying on the guard itself would prove that NestJS short-circuits,
// which is NestJS's property, not this repository's.
//
// This file proves the reservation path is never ENTERED. The other half - nothing is debited - is proven against
// the real credit ledger in test/integration/rate-limit-ledger-and-config.spec.ts (no reserve/commit/release row).

const REFUSED: RateLimitDecision = {
  allowed: false,
  applied: true,
  exhausted: { scope: "user", limit: 60, hardCap: false },
  limit: 60,
  remaining: 0,
  resetAfterMs: 4_000,
};

describe("STORY-025 · a rate-limited request never reaches CreditGuard", () => {
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };
  let creditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    applyFakeApiEnv();

    // AuthGuard supplies the identity the buckets are keyed on. /health/live is
    // @Public(), so without this there is no workspace and RateLimitGuard
    // correctly declines to count an unidentifiable caller.
    vi.spyOn(AuthGuard.prototype, "canActivate").mockImplementation(function (this: unknown, context: unknown) {
      const request = (context as { switchToHttp: () => { getRequest: () => Record<string, unknown> } })
        .switchToHttp()
        .getRequest();
      request.auth = { ws: "0192f1a0-0000-7000-8000-00000000000a", sub: "user-1" };
      return Promise.resolve(true);
    });

    creditSpy = vi.spyOn(CreditGuard.prototype, "canActivate");

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(RateLimitBuckets)
      .useValue({ check: () => Promise.resolve(REFUSED) })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("refuses with 429 rate_limited and never invokes CreditGuard", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("rate_limited");
    expect(creditSpy, "a refused request must not reach the reservation path").not.toHaveBeenCalled();
  });

  it("carries the retry interval in the body, in milliseconds", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    // §2: "`details.retry_after_ms`; `Retry-After` set". NFR-API-05's unit.
    expect(response.json().error.details).toEqual({ retry_after_ms: 4_000 });
  });

  it("row 10 — sets Retry-After and the three X-RateLimit headers on the refusal", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.headers["retry-after"]).toBe("4");
    expect(response.headers["x-ratelimit-limit"]).toBe("60");
    expect(response.headers["x-ratelimit-remaining"]).toBe("0");
    expect(response.headers["x-ratelimit-reset"]).toBe("4");
  });
});

describe("STORY-025 · an allowed request still publishes its remaining capacity", () => {
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    applyFakeApiEnv();
    vi.spyOn(AuthGuard.prototype, "canActivate").mockImplementation(function (this: unknown, context: unknown) {
      const request = (context as { switchToHttp: () => { getRequest: () => Record<string, unknown> } })
        .switchToHttp()
        .getRequest();
      request.auth = { ws: "0192f1a0-0000-7000-8000-00000000000a", sub: "user-1" };
      return Promise.resolve(true);
    });

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(RateLimitBuckets)
      .useValue({
        check: (): Promise<RateLimitDecision> =>
          Promise.resolve({ allowed: true, applied: true, limit: 300, remaining: 299, resetAfterMs: 200 }),
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("publishes the headers on success too — a client that only learns its budget by being refused cannot pace itself", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-ratelimit-limit"]).toBe("300");
    expect(response.headers["x-ratelimit-remaining"]).toBe("299");
    expect(response.headers["retry-after"], "an allowed request carries no Retry-After").toBeUndefined();
  });
});
