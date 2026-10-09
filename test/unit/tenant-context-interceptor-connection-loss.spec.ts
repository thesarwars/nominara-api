import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Pool } from "pg";
import { lastValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { TenantContextInterceptor } from "../../src/api/interceptors/tenant-context.interceptor.js";

// Checkpoint-6 (blocker). A connection-class failure on a request's client (pgBouncer closing it after
// query_wait_timeout) is a retryable 503 `degraded`, and the connection is destroyed rather than returned.

const TENANT = { workspaceId: "00000000-0000-7000-8000-000000000001", actorId: "00000000-0000-7000-8000-000000000001" };
const context = {
  getHandler: () => () => undefined,
  getClass: () => class Handler {},
  switchToHttp: () => ({ getRequest: () => ({ tenant: TENANT }) }),
} as unknown as ExecutionContext;

function poolFailingWith(error: Error) {
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.trim().toUpperCase() === "BEGIN") throw error;
      return { rows: [], rowCount: 0 };
    }),
    release,
  };
  return { pool: { connect: async () => client } as unknown as Pool, release };
}

async function run(pool: Pool): Promise<unknown> {
  const observable = await new TenantContextInterceptor(pool, new Reflector()).intercept(context, { handle: () => of("ok") });
  return lastValueFrom(observable).then(
    () => "served",
    (error: unknown) => error,
  );
}

describe("checkpoint-6 · TenantContextInterceptor maps a lost connection to a retryable 503", () => {
  it("D-1 AC-interceptor-503 . `query_wait_timeout` is refused as `degraded` and the client is released with the error", async () => {
    const failure = Object.assign(new Error("query_wait_timeout"), { code: "08P01" });
    const { pool, release } = poolFailingWith(failure);
    expect(await run(pool)).toMatchObject({ code: "degraded" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBe(failure);
  });

  it("D-1 AC-interceptor-503 . `Connection terminated unexpectedly` is refused as `degraded` and the client is destroyed", async () => {
    const { pool, release } = poolFailingWith(new Error("Connection terminated unexpectedly"));
    expect(await run(pool)).toMatchObject({ code: "degraded" });
    expect(release.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("D-1 AC-interceptor-503 . any other failure propagates unchanged and the client is returned, not destroyed", async () => {
    const failure = Object.assign(new Error("duplicate key"), { code: "23505" });
    const { pool, release } = poolFailingWith(failure);
    expect(await run(pool)).toBe(failure);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBeUndefined();
  });
});
