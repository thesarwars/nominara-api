import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPgPool } from "../../src/db/pg-pool.js";
import { TENANT_TABLES } from "../../src/db/rls/tenant-tables.generated.js";
import { TenantContextMissingError } from "../../src/tenancy/errors.js";
import { tenantAwarePool } from "../../src/tenancy/query-guard.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-118 — src/tenancy/query-guard.ts's seam, INSTALLED. STORY-011 built
// the guard and unit-tested the check; test/unit/query-guard.spec.ts already
// proves the function and the client-wrapping Proxy behave. What no test
// asserted, and what this file exists to assert, is that anything actually
// calls them: the pool was constructed bare, so NFR-SEC-01's effect was not
// in force at all.
//
// Everything here runs against a LAZY pg.Pool or a fake — the guard refuses
// synchronously, before any I/O, so none of these tests needs a database.
// The real-Postgres half of the story is
// test/integration/tenant-query-guard-installed.spec.ts.

// A connection string that is syntactically valid and points nowhere. The
// pg.Pool constructor opens nothing, and every assertion below is reached
// before a connection would be attempted.
const NOWHERE = "postgres://nobody:nobody@127.0.0.1:1/nothing";

interface FakePool {
  readonly pool: Pool;
  readonly poolQueries: string[];
}

function createFakePool(): FakePool {
  const poolQueries: string[] = [];

  // A DISTINCT underlying client per checkout, as a real pool gives out —
  // otherwise "two clients" would be two wrappers over one connection, and
  // the cross-client test below would be asserting nothing.
  const newClient = (): PoolClient =>
    ({
      query: async (_text: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }),
      release: () => undefined,
    }) as unknown as PoolClient;

  const pool = {
    query: async (text: string) => {
      poolQueries.push(text);
      return { rows: [], rowCount: 0 };
    },
    connect: async () => newClient(),
    end: async () => undefined,
  } as unknown as Pool;

  return { pool: tenantAwarePool(pool, TENANT_TABLES), poolQueries };
}

describe("STORY-118 · every client the pool hands out is wrapped", () => {
  it("a client from connect() refuses a tenant-table query with no context active", async () => {
    const { pool } = createFakePool();
    const client = await pool.connect();
    expect(() => client.query("SELECT * FROM projects WHERE id = $1", ["x"])).toThrow(TenantContextMissingError);
  });

  it("that same client accepts the query inside withTenantContext opened ON THE CLIENT THE POOL HANDED OUT", async () => {
    // The load-bearing case for the whole install. A service does
    // `const client = await pool.connect()` and then
    // `withTenantContext(client, ...)` — so the object the context store
    // remembers is the WRAPPER, while the guard is invoked with the wrapped
    // target underneath it. If the identity check compares those two
    // directly, every correctly-written service in this repository starts
    // throwing the moment the guard is installed.
    const { pool } = createFakePool();
    const client = await pool.connect();
    await withTenantContext(client, { workspaceId: "ws", actorId: "actor" }, async (tx) => {
      await expect(tx.query("SELECT * FROM projects WHERE id = $1", ["x"])).resolves.toEqual({ rows: [], rowCount: 0 });
    });
  });

  it("a context open on one checked-out client does not authorise a query on another", async () => {
    const { pool } = createFakePool();
    const a = await pool.connect();
    const b = await pool.connect();
    await withTenantContext(a, { workspaceId: "ws-a", actorId: "actor-a" }, async () => {
      expect(() => b.query("SELECT * FROM projects")).toThrow(TenantContextMissingError);
    });
  });

  it("a global-table query on a checked-out client passes through untouched", async () => {
    const { pool } = createFakePool();
    const client = await pool.connect();
    await expect(client.query("SELECT * FROM users WHERE id = $1", ["x"])).resolves.toEqual({ rows: [], rowCount: 0 });
  });

  it("release() still reaches the underlying client through the wrapper", async () => {
    const { pool } = createFakePool();
    const client = await pool.connect();
    expect(() => client.release()).not.toThrow();
  });
});

describe("STORY-118 · a pool-level tenant query cannot run", () => {
  it("refuses a tenant-table query issued on the pool itself, with no context of any kind", () => {
    // Under pgBouncer transaction-mode pooling, pool.query() takes an
    // implicit per-query connection that can never carry transaction-local
    // context. Such a query is context-free BY CONSTRUCTION — there is no
    // correct way to write it, so the guard refuses rather than leaving it
    // to review.
    const { pool } = createFakePool();
    expect(() => pool.query("SELECT 1 FROM projects WHERE id = $1", ["x"])).toThrow(TenantContextMissingError);
  });

  it("refuses it even while a tenant context is open on a checked-out client", async () => {
    // The refusal is structural, not contextual: an ambient context belongs
    // to a DIFFERENT connection than the implicit one pool.query() borrows.
    const { pool } = createFakePool();
    const client = await pool.connect();
    await withTenantContext(client, { workspaceId: "ws", actorId: "actor" }, async () => {
      expect(() => pool.query("SELECT 1 FROM projects")).toThrow(TenantContextMissingError);
    });
  });

  it("names the offending table and says what to do instead", () => {
    const { pool } = createFakePool();
    expect(() => pool.query("SELECT 1 FROM projects")).toThrow(/projects/);
    expect(() => pool.query("SELECT 1 FROM projects")).toThrow(/pool\.connect/);
  });

  it("lets a global-table query through on the pool", async () => {
    const { pool, poolQueries } = createFakePool();
    await expect(pool.query("UPDATE engines SET status = 'degraded' WHERE key = $1")).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
    expect(poolQueries).toEqual(["UPDATE engines SET status = 'degraded' WHERE key = $1"]);
  });

  it("reads the SQL out of the object form of query() as well as the string form", () => {
    const { pool } = createFakePool();
    expect(() => pool.query({ text: "SELECT 1 FROM projects", values: [] })).toThrow(TenantContextMissingError);
  });
});

describe("STORY-118 · the guard is installed where the pool is BUILT", () => {
  const pools: Pool[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end().catch(() => undefined)));
  });

  // AC 4 — "removing the guard from pool construction turns a test red".
  // This is that test. It asserts against createPgPool itself, the single
  // function both the API (src/db/db.module.ts) and the worker
  // (src/worker.ts) build their pool with, so deleting the install line
  // fails here rather than somewhere downstream of it.
  it("createPgPool returns a guarded pool — delete the install and this goes red", () => {
    const pool = createPgPool(NOWHERE);
    pools.push(pool);
    expect(() => pool.query("SELECT 1 FROM projects")).toThrow(TenantContextMissingError);
  });

  it("createPgPool's guarded pool still exposes the pg.Pool surface the app uses", () => {
    const pool = createPgPool(NOWHERE);
    pools.push(pool);
    expect(typeof pool.connect).toBe("function");
    expect(typeof pool.end).toBe("function");
    expect(typeof pool.on).toBe("function");
    // Counter getters must read through to the real pool, not the wrapper.
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
  });
});
