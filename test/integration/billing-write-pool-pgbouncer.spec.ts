import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingWritePool, inBillingWriteTransaction } from "../../src/modules/billing/billing-write-pool.js";
import { type PgBouncerFixture, startPgBouncerFixture } from "../support/pgbouncer-fixture.js";

// Checkpoint-5 (hold-and-wait moves to pgBouncer). The billing write pool logs in as `nominara_app` THROUGH
// pgBouncer, so it shares one server pool with the main pool, the settlement pool and the worker. Its
// `connect()` completes against pgBouncer at once (the login is checked against auth_file), and its BEGIN then
// waits in pgBouncer's queue for a server connection, which `connectionTimeoutMillis` does not cover. At
// pgBouncer's default `query_wait_timeout` (120 s) a drained server pool is the deadlock the write pool was
// built to remove, for two minutes. The SHIPPED pgbouncer.ini must bound it; this runs the real pooler at a
// pool of ONE, with the main pool's stand-in holding the only server connection.
//
// SIZING RULE (also in pgbouncer.ini): the sum of every client pool's max for one (database, user) pair, across
// all API replicas and the worker, is NOT bounded by default_pool_size, and cannot be while the write pool and
// the main pool share `nominara_app`. So the guarantee is the bound, not the size: a client that cannot get a
// server connection within `query_wait_timeout` is refused (a retryable 503 here), never queued for minutes.

/** The bound a waiting write must meet; the shipped query_wait_timeout is far below it, pgBouncer's default is 120 s. */
const BOUND_MS = 15_000;

describe("checkpoint-5 · the billing write pool's wait for a pgBouncer server connection is bounded", () => {
  let fixture: PgBouncerFixture;

  beforeAll(async () => {
    fixture = await startPgBouncerFixture({ defaultPoolSize: 1 });
  }, 180_000);
  afterAll(async () => {
    await fixture.stop();
  });

  function writePool() {
    const { host, port, user, password, database } = fixture.connectThroughPooler("nominara_app").connectionParameters;
    return createBillingWritePool(`postgres://${String(user)}:${encodeURIComponent(String(password))}@${String(host)}:${String(port)}/${String(database)}`);
  }

  it("the shipped pgbouncer.ini sets a query_wait_timeout, and the running pooler reports it", async () => {
    expect(fixture.effectiveIniContent).toMatch(/^query_wait_timeout = \d+$/m);
    const admin = fixture.connectAdmin();
    await admin.connect();
    try {
      const row = (await admin.query("SHOW CONFIG")).rows.find((r: { key: string }) => r.key === "query_wait_timeout") as { value: string } | undefined;
      expect(Number(row?.value)).toBeGreaterThan(0);
      expect(Number(row?.value) * 1000).toBeLessThan(BOUND_MS);
    } finally {
      await admin.end();
    }
  });

  it("a write whose BEGIN queues behind a drained server pool is refused as a retryable `degraded` within the bound, and the pool serves the next write once the server connection is back", async () => {
    const holder = fixture.connectThroughPooler("nominara_app");
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1"); // the ONLY server connection of the pool
    const pool = writePool();
    try {
      const started = Date.now();
      const outcome = await Promise.race([
        inBillingWriteTransaction(pool, { workspaceId: "00000000-0000-7000-8000-000000000001", actorId: "00000000-0000-7000-8000-000000000001" }, (tx) => tx.query("SELECT 1")).then(
          () => "served" as const,
          (error: unknown) => error,
        ),
        new Promise<"still-queued">((resolve) => setTimeout(() => resolve("still-queued"), BOUND_MS)),
      ]);
      expect(outcome, `the write was neither served nor refused within ${String(BOUND_MS)} ms`).not.toBe("still-queued");
      expect(outcome).toMatchObject({ code: "degraded" });
      expect(Date.now() - started).toBeLessThan(BOUND_MS);

      await holder.query("COMMIT");
      const served = await inBillingWriteTransaction(pool, { workspaceId: "00000000-0000-7000-8000-000000000001", actorId: "00000000-0000-7000-8000-000000000001" }, (tx) => tx.query("SELECT 1 AS one"));
      expect(served.rows).toEqual([{ one: 1 }]);
    } finally {
      await holder.end().catch(() => undefined);
      await pool.end();
    }
  }, 60_000);
});
