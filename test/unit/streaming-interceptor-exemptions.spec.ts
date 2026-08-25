import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Pool } from "pg";
import { EMPTY, lastValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { IDEMPOTENT_KEY } from "../../src/api/decorators/idempotent.decorator.js";
import { STREAMING_KEY } from "../../src/api/decorators/streaming.decorator.js";
import { IdempotencyStore } from "../../src/api/idempotency/store.js";
import { IdempotencyInterceptor } from "../../src/api/interceptors/idempotency.interceptor.js";
import { ResponseEnvelopeInterceptor } from "../../src/api/interceptors/response-envelope.interceptor.js";
import { TenantContextInterceptor } from "../../src/api/interceptors/tenant-context.interceptor.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";

// STORY-026 T23 — one test per interceptor, as the execution plan requires.
//
// The first `describe` is the important one, and it is deliberately shaped as
// "the trap is real, and the exemption avoids it" rather than "the exemption
// works". A test that only exercised the marked path would pass just as well
// against an interceptor that never needed exempting, and would say nothing
// about why the decorator exists.
//
// No streaming endpoint ships in this epic — the first is STORY-079's — which
// is exactly why these are here: without them STORY-079 inherits a
// transaction-rollback bug with no owner and nothing pointing at it.

function contextFor(marks: Record<string, unknown>): ExecutionContext {
  function handler(): void {}
  for (const [key, value] of Object.entries(marks)) {
    Reflect.defineMetadata(key, value, handler);
  }
  class FakeController {}

  const request = {
    id: "req-1",
    headers: { "idempotency-key": "k1" },
    method: "GET",
    url: "/v1/tools/scan/stream",
    tenant: { workspaceId: "0192f1a0-0000-7000-8000-00000000000a", actorId: "user-1" },
    auth: { ws: "0192f1a0-0000-7000-8000-00000000000a", sub: "user-1" },
  };
  const reply = { header: vi.fn(), status: vi.fn(), removeHeader: vi.fn(), statusCode: 200 };

  return {
    getHandler: () => handler,
    getClass: () => FakeController,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ExecutionContext;
}

/** What a streaming handler actually produces: it writes to reply.raw and returns nothing. */
const streamingHandler: CallHandler = { handle: () => EMPTY };

describe("STORY-026 · TenantContextInterceptor — the exemption that prevents a silent rollback", () => {
  function interceptorWithFakePool(): { interceptor: TenantContextInterceptor; connects: () => number } {
    let connects = 0;
    const pool = {
      connect: () => {
        connects += 1;
        return Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => undefined });
      },
    } as unknown as Pool;
    return { interceptor: new TenantContextInterceptor(pool, new Reflector()), connects: () => connects };
  }

  it("THE TRAP IS REAL — without the marker, a handler that emits nothing rejects and the transaction rolls back", async () => {
    // `withTenantContext` awaits `lastValueFrom(next.handle())`. An observable
    // that completes without emitting makes that reject with EmptyError, and
    // the rejection propagates out of the transaction — so a request that
    // SUCCEEDED is rolled back.
    const { interceptor } = interceptorWithFakePool();
    const observable = await interceptor.intercept(contextFor({}), streamingHandler);
    await expect(lastValueFrom(observable)).rejects.toThrow();
  });

  it("with @Streaming(), the handler passes through and NO transaction is opened at all", async () => {
    const { interceptor, connects } = interceptorWithFakePool();
    const observable = await interceptor.intercept(contextFor({ [STREAMING_KEY]: true }), streamingHandler);

    await expect(lastValueFrom(observable, { defaultValue: "empty" })).resolves.toBe("empty");
    // Not merely "did not reject": holding a database transaction open for a
    // sixty-second stream would be wrong even if lastValueFrom tolerated it.
    expect(connects(), "a streaming route must not hold a transaction open").toBe(0);
  });

  it("still opens a transaction for an ordinary route", async () => {
    const { interceptor, connects } = interceptorWithFakePool();
    await interceptor.intercept(contextFor({}), { handle: () => of({ id: "x" }) });
    expect(connects()).toBe(1);
  });
});

describe("STORY-026 · ResponseEnvelopeInterceptor — no JSON appended to an event stream", () => {
  it("does not envelope a streaming response", async () => {
    const interceptor = new ResponseEnvelopeInterceptor(new Reflector());
    const observable = interceptor.intercept(contextFor({ [STREAMING_KEY]: true }), streamingHandler);
    await expect(lastValueFrom(observable, { defaultValue: "empty" })).resolves.toBe("empty");
  });

  it("still envelopes an ordinary response", async () => {
    const interceptor = new ResponseEnvelopeInterceptor(new Reflector());
    const body = (await lastValueFrom(
      interceptor.intercept(contextFor({}), { handle: () => of({ id: "x" }) }),
    )) as Record<string, unknown>;
    expect(body.data).toEqual({ id: "x" });
  });
});

describe("STORY-026 · IdempotencyInterceptor — nothing to record, so nothing recorded", () => {
  function interceptor(): IdempotencyInterceptor {
    return new IdempotencyInterceptor(new Reflector(), new IdempotencyStore(new InMemoryCacheAdapter()));
  }

  it("does not claim or record a route marked both @Idempotent() and @Streaming()", async () => {
    // The combination is a contradiction: a streaming handler returns nothing,
    // so the "replayable response" would be `undefined` and a replay would
    // answer a stream request with an empty JSON body. Streaming wins.
    const observable = await interceptor().intercept(
      contextFor({ [IDEMPOTENT_KEY]: true, [STREAMING_KEY]: true }),
      streamingHandler,
    );
    await expect(lastValueFrom(observable, { defaultValue: "empty" })).resolves.toBe("empty");
  });

  it("still enforces the key on an idempotent route that is not streaming", async () => {
    const context = contextFor({ [IDEMPOTENT_KEY]: true });
    const observable = await interceptor().intercept(context, { handle: () => of({ id: "x" }) });
    await expect(lastValueFrom(observable)).resolves.toEqual({ id: "x" });
  });
});
