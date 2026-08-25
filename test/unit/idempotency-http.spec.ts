import { Controller, HttpCode, Post } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { Idempotent } from "../../src/api/decorators/idempotent.decorator.js";
import { SkipTenantContext } from "../../src/api/decorators/skip-tenant-context.decorator.js";
import { AuthGuard } from "../../src/api/guards/auth.guard.js";
import { RbacGuard } from "../../src/api/guards/rbac.guard.js";
import { WorkspaceGuard } from "../../src/api/guards/workspace.guard.js";
import { RateLimitBuckets } from "../../src/api/rate-limit/buckets.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-025 T18 (self-review) — the interceptor records `reply.statusCode` so
// a replay can reproduce the original status. Every assertion about that was
// written against a FAKE reply whose statusCode the test set itself, which is
// exactly the shape of defect this repository has already shipped once: a
// FastifyReply fake without `removeHeader` (STORY-024 T12).
//
// Under Nest with Fastify, `@HttpCode(201)` is applied when the response is
// SENT — after the interceptor chain completes — so the value visible to an
// interceptor's after-logic is not obviously the route's declared status. This
// file drives a real route over real HTTP to find out, rather than assuming
// either way.

let handlerCalls = 0;

@Controller("test-only")
class BillableController {
  @Post("charge")
  @Idempotent()
  @SkipTenantContext()
  @HttpCode(201)
  charge(): { id: string } {
    handlerCalls += 1;
    return { id: `charge-${String(handlerCalls)}` };
  }
}

describe("STORY-025 · an idempotent route over real HTTP", () => {
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    handlerCalls = 0;
    applyFakeApiEnv();

    vi.spyOn(AuthGuard.prototype, "canActivate").mockImplementation(function (this: unknown, context: unknown) {
      const request = (context as { switchToHttp: () => { getRequest: () => Record<string, unknown> } })
        .switchToHttp()
        .getRequest();
      request.auth = { ws: "0192f1a0-0000-7000-8000-00000000000a", sub: "user-1" };
      return Promise.resolve(true);
    });
    // The route is private, so WorkspaceGuard and RbacGuard run for real and
    // refuse a synthetic identity — WorkspaceGuard with `entitlement_stale`,
    // which the filter maps to 401. Neither is what this file is testing.
    vi.spyOn(WorkspaceGuard.prototype, "canActivate").mockImplementation(() => Promise.resolve(true));
    vi.spyOn(RbacGuard.prototype, "canActivate").mockImplementation(() => true);

    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule],
      controllers: [BillableController],
    })
      .overrideProvider(RateLimitBuckets)
      .useValue({ check: () => Promise.resolve({ allowed: true, applied: true, limit: 100, remaining: 99, resetAfterMs: 0 }) })
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

  const send = (key?: string, body: unknown = { amount: 1 }) =>
    app.inject({
      method: "POST",
      url: "/v1/test-only/charge",
      payload: body as Record<string, unknown>,
      headers: key === undefined ? {} : { "idempotency-key": key },
    });

  it("refuses a request with no Idempotency-Key, and the handler never runs", async () => {
    const response = await send();
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_failed");
    expect(handlerCalls).toBe(0);
  });

  it("runs once and replays the recorded envelope byte for byte", async () => {
    const first = await send("k1");
    const second = await send("k1");

    expect(handlerCalls).toBe(1);
    expect(second.body, "AC2: byte-identical, not merely equivalent").toBe(first.body);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
  });

  it("replays the ORIGINAL status code, not the framework default", async () => {
    // The assertion this file exists for. If the recorded status were whatever
    // `reply.statusCode` held mid-chain, this would come back 200 while the
    // original was 201 — and every unit test would still be green, because
    // they set that field themselves.
    const first = await send("k2");
    const second = await send("k2");

    expect(first.statusCode).toBe(201);
    expect(second.statusCode, "a replay must reproduce the original status").toBe(201);
  });

  it("returns 409 idempotency_conflict for the same key with a different body", async () => {
    await send("k3", { amount: 1 });
    const conflict = await send("k3", { amount: 999 });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");
    expect(handlerCalls).toBe(1);
  });

  it("wraps the replayed body in nothing extra — it is returned exactly as recorded", async () => {
    const first = await send("k4");
    const second = await send("k4");
    const firstBody = first.json();
    const secondBody = second.json();

    expect(secondBody).toEqual(firstBody);
    // The envelope's meta belongs to the ORIGINAL request. It is a recording,
    // and re-enveloping would stamp a fresh request_id and computed_at into it.
    expect(secondBody.meta.request_id).toBe(firstBody.meta.request_id);
    expect(secondBody.meta.computed_at).toBe(firstBody.meta.computed_at);
  });
});
