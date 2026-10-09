import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContextInterceptor } from "../../src/api/interceptors/tenant-context.interceptor.js";
import { createPgPool } from "../../src/db/pg-pool.js";
import { type PgBouncerFixture, startPgBouncerFixture } from "../support/pgbouncer-fixture.js";

// Checkpoint-6 (blocker) — the shipped `query_wait_timeout = 5` is GLOBAL, so a request on the MAIN pool whose BEGIN
// queues in pgBouncer for more than 5 s has its connection closed by the pooler. pg-pool removes its own idle
// listener when a client is checked out, so the closing emits an `error` event on a Client nothing listens to, and
// Node exits. Reproduced with a script before this spec: "main-pool request outcome after 5200 ms: rejected:
// query_wait_timeout", then "Unhandled error event ... Connection terminated unexpectedly", exit 1.
//
// This drives the real TenantContextInterceptor over a pool built by `createPgPool` (the shape every API request
// takes) against the real pooler at a server pool of ONE. Vitest fails the run on an uncaught exception, so a
// regression cannot pass.

const TENANT = { workspaceId: "00000000-0000-7000-8000-000000000001", actorId: "00000000-0000-7000-8000-000000000001" };
const BOUND_MS = 15_000;

describe("checkpoint-6 · a main-pool request that outwaits pgBouncer's query_wait_timeout is a retryable 503, not a dead process", () => {
  let fixture: PgBouncerFixture;
  const uncaught: unknown[] = [];
  const record = (error: unknown): void => {
    uncaught.push(error);
  };

  beforeAll(async () => {
    process.on("uncaughtException", record);
    fixture = await startPgBouncerFixture({ defaultPoolSize: 1 });
  }, 180_000);
  afterAll(async () => {
    process.off("uncaughtException", record);
    await fixture.stop();
  });

  function mainPool() {
    const { host, port, user, password, database } = (fixture.connectThroughPooler("nominara_app") as unknown as { connectionParameters: Record<string, unknown> }).connectionParameters;
    return createPgPool(`postgres://${String(user)}:${encodeURIComponent(String(password))}@${String(host)}:${String(port)}/${String(database)}`);
  }
  const contextFor = (): ExecutionContext =>
    ({
      getHandler: () => () => undefined,
      getClass: () => class Handler {},
      switchToHttp: () => ({ getRequest: () => ({ tenant: TENANT }) }),
    }) as unknown as ExecutionContext;

  it("checkpoint-6 AC-main-pool-wait . the request is refused as `degraded` (503), no uncaught error is raised, and the pool serves the next request once the server connection is back", async () => {
    const holder = fixture.connectThroughPooler("nominara_app");
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1"); // the ONLY server connection of the pool
    const pool = mainPool();
    const interceptor = new TenantContextInterceptor(pool, new Reflector());
    try {
      const started = Date.now();
      const outcome = await Promise.race([
        interceptor
          .intercept(contextFor(), { handle: () => of("ok") })
          .then((observable) => lastValueFrom(observable))
          .then(
            () => "served" as const,
            (error: unknown) => error,
          ),
        new Promise<"still-queued">((resolve) => setTimeout(() => resolve("still-queued"), BOUND_MS)),
      ]);
      expect(outcome, `the request was neither served nor refused within ${String(BOUND_MS)} ms`).not.toBe("still-queued");
      expect(outcome).toMatchObject({ code: "degraded" });
      expect(Date.now() - started).toBeLessThan(BOUND_MS);

      // The socket's `end` event arrives after the query has already rejected: give it time to surface.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(uncaught, "an `error` event on a checked-out client was left unhandled").toEqual([]);

      await holder.query("COMMIT");
      const served = await lastValueFrom(await interceptor.intercept(contextFor(), { handle: () => of("ok") }));
      expect(served).toBe("ok");
    } finally {
      await holder.end().catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  }, 60_000);
});
