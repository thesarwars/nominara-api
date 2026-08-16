import "reflect-metadata";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Pool, PoolClient } from "pg";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { TenantContextMissingError } from "../../tenancy/errors.js";
import type { TenantContext } from "../../tenancy/tenant-context.js";
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
