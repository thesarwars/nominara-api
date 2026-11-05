import "reflect-metadata";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Pool, PoolClient } from "pg";
import { defer, firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { TenantContextMissingError } from "../../tenancy/errors.js";
import type { TenantContext } from "../../tenancy/tenant-context.js";
import { afterTransaction } from "../after-transaction.js";
import { Public } from "../decorators/public.decorator.js";
import { AuthedRequest, TenantContextInterceptor } from "./tenant-context.interceptor.js";

class PrivateController {
  handler(): void {}
}

class PublicController {
  @Public()
  handler(): void {}
}

function makeContext(ctor: new () => object, req: AuthedRequest): ExecutionContext {
  const proto = ctor.prototype as { handler: () => void };
  return {
    getHandler: () => proto.handler,
    getClass: () => ctor,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

const TENANT: TenantContext = { workspaceId: "workspace-1", actorId: "actor-1" };

// STORY-022-E-3 — TenantContextInterceptor is a real adapter over
// src/tenancy/tenant-context.ts's withTenantContext, exercised here without
// a real Postgres connection (the fail-closed path never reaches the pool
// at all; the happy path uses a fake PoolClient satisfying only the query
// surface withTenantContext calls).
describe("STORY-022-E-3 · TenantContextInterceptor fails closed", () => {
  it("throws TenantContextMissingError when req.tenant is unset on a non-public route, without touching the pool", async () => {
    const connect = vi.fn();
    const pool = { connect } as unknown as Pool;
    const interceptor = new TenantContextInterceptor(pool, new Reflector());
    const context = makeContext(PrivateController, {});
    const next: CallHandler = { handle: () => of("unreachable") };

    await expect(interceptor.intercept(context, next)).rejects.toThrow(TenantContextMissingError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("bypasses tenant-context enforcement on a route marked @Public(), without touching the pool", async () => {
    const connect = vi.fn();
    const pool = { connect } as unknown as Pool;
    const interceptor = new TenantContextInterceptor(pool, new Reflector());
    const context = makeContext(PublicController, {});
    const next: CallHandler = { handle: () => of("ok") };

    const result$ = await interceptor.intercept(context, next);
    await expect(firstValueFrom(result$)).resolves.toBe("ok");
    expect(connect).not.toHaveBeenCalled();
  });

  it("opens a tenant-scoped transaction and releases the client when req.tenant IS set", async () => {
    const queries: unknown[][] = [];
    const release = vi.fn();
    const fakeClient = {
      query: vi.fn((...args: unknown[]) => {
        queries.push(args);
        return Promise.resolve({ rows: [] });
      }),
      release,
    } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(fakeClient) } as unknown as Pool;
    const interceptor = new TenantContextInterceptor(pool, new Reflector());
    const context = makeContext(PrivateController, { tenant: TENANT });
    const next: CallHandler = { handle: () => of("payload") };

    const result$ = await interceptor.intercept(context, next);
    await expect(firstValueFrom(result$)).resolves.toBe("payload");

    expect(queries[0]?.[0]).toBe("BEGIN");
    expect(queries.at(-1)?.[0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});

// STORY-180 round 5 (owner decision 60 (c), ADR-0003) - work a handler registers with afterTransaction() runs AFTER the commit AND
// after the request's pooled connection has been released, and its failure fails the response.
describe("STORY-180 r5 · afterTransaction work", () => {
  function harness(opts: { queryFails?: (sql: string) => boolean } = {}) {
    const order: string[] = [];
    const client = {
      query: vi.fn((sql: string) => {
        order.push(sql.startsWith("SELECT set_config") ? "set_config" : sql);
        if (opts.queryFails?.(sql)) return Promise.reject(new Error("boom"));
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(() => void order.push("release")),
    } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    return { order, interceptor: new TenantContextInterceptor(pool, new Reflector()), context: makeContext(PrivateController, { tenant: TENANT }) };
  }

  it("runs after COMMIT and after the connection is released, before the response is produced", async () => {
    const h = harness();
    const next: CallHandler = {
      handle: () =>
        defer(async () => {
          afterTransaction(async () => void h.order.push("after-transaction"));
          return "payload";
        }),
    };
    const result$ = await h.interceptor.intercept(h.context, next);
    await expect(firstValueFrom(result$)).resolves.toBe("payload");
    expect(h.order.indexOf("COMMIT")).toBeLessThan(h.order.indexOf("release"));
    expect(h.order.indexOf("release")).toBeLessThan(h.order.indexOf("after-transaction"));
  });

  it("is discarded when the transaction rolls back", async () => {
    const h = harness();
    const ran = vi.fn();
    const next: CallHandler = { handle: () => defer(async () => { afterTransaction(async () => void ran()); throw new Error("handler failed"); }) };
    const result$ = await h.interceptor.intercept(h.context, next);
    await expect(firstValueFrom(result$)).rejects.toThrow("handler failed");
    expect(ran).not.toHaveBeenCalled();
    expect(h.order).toContain("ROLLBACK");
  });

  it("a failure in it is the response's failure (the transaction is already committed)", async () => {
    const h = harness();
    const next: CallHandler = { handle: () => defer(async () => { afterTransaction(async () => { throw new Error("upload failed"); }); return "payload"; }) };
    const result$ = await h.interceptor.intercept(h.context, next);
    await expect(firstValueFrom(result$)).rejects.toThrow("upload failed");
    expect(h.order).toContain("COMMIT");
    expect(h.order).not.toContain("ROLLBACK");
  });

  it("outside a request transaction it registers nothing and says so", () => {
    expect(afterTransaction(async () => undefined)).toBe(false);
  });
});
