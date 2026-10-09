import { describe, expect, it, vi } from "vitest";
import { BILLING_WRITE_POOL_MAX, BILLING_WRITE_CONNECT_TIMEOUT_MS, connectForWrite, createBillingWritePool, inBillingWriteTransaction } from "./billing-write-pool.js";

// STORY-075a / STORY-076a / STORY-076b checkpoint-4 — the small, bounded pool a billing request uses for its short independent writes, so
// the holder of a main-pool connection never waits on the main pool.

const counter = vi.hoisted(() => vi.fn((..._args: unknown[]) => undefined));
vi.mock("../../lib/telemetry/metrics.js", () => ({ incrementCounter: counter }));

describe("STORY-076b checkpoint-4 · billing write pool", () => {
  it("AC-pool-bounds . is a separate, small pool with a real connection timeout (it can never wait forever)", async () => {
    const pool = createBillingWritePool("postgres://u:p@localhost:1/db");
    try {
      const options = (pool as unknown as { options: { max: number; connectionTimeoutMillis: number } }).options;
      expect(options.max).toBe(BILLING_WRITE_POOL_MAX);
      expect(options.connectionTimeoutMillis).toBe(BILLING_WRITE_CONNECT_TIMEOUT_MS);
      expect(BILLING_WRITE_POOL_MAX).toBeLessThan(10); // the main pool's default max
      expect(BILLING_WRITE_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it("AC-pool-timeout . a connection that cannot be had in time is a retryable 503 `degraded` (never a hang or a 500), counted, with no connection text", async () => {
    const starved = { connect: () => Promise.reject(new Error("timeout exceeded when trying to connect to postgres://u:secret@host/db")) } as never;
    const err = await connectForWrite(starved).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "degraded" });
    expect(JSON.stringify(err)).not.toContain("secret");
    expect(counter).toHaveBeenCalledWith("nominara_billing_write_pool_timeout_total", {});
  });

  it("AC-pool-timeout . a connection that is available is returned as it is", async () => {
    const client = { release: () => undefined };
    expect(await connectForWrite({ connect: () => Promise.resolve(client) } as never)).toBe(client);
  });

  // Checkpoint-5 — the wait for a SERVER connection behind pgBouncer is not the pool's connect timeout.
  const WS = "00000000-0000-7000-8000-000000000001";
  /** A pooled client that records its statements and fails (or not) per script; `released` records release(arg). */
  function fakePool(fail?: (sql: string) => Error | undefined) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const released: unknown[] = [];
    const client = {
      query: (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        const error = fail?.(sql);
        return error === undefined ? Promise.resolve({ rows: [], rowCount: 1 }) : Promise.reject(error);
      },
      release: (arg?: unknown) => released.push(arg),
    };
    return { calls, released, pool: { connect: () => Promise.resolve(client) } as never };
  }

  it("AC-write-bounds . every write transaction sets a transaction-local statement_timeout and lock_timeout before its own statements", async () => {
    const { calls, pool } = fakePool();
    await inBillingWriteTransaction(pool, { workspaceId: WS, actorId: WS }, (tx) => tx.query("UPDATE x SET y = 1"));
    const statement = calls.findIndex(({ sql, params }) => /set_config\('statement_timeout', \$1, true\)/u.test(sql) && params[0] === "5000");
    const lock = calls.findIndex(({ sql, params }) => /set_config\('lock_timeout', \$1, true\)/u.test(sql) && params[0] === "3000");
    const own = calls.findIndex(({ sql }) => /UPDATE x/u.test(sql));
    expect(statement).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(Math.max(statement, lock)).toBeLessThan(own);
  });

  it.each([
    ["pgBouncer query_wait_timeout", Object.assign(new Error("query_wait_timeout"), { code: "08P01" })],
    ["a connection pgBouncer closed", new Error("Connection terminated unexpectedly")],
    ["statement_timeout", Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })],
    ["lock_timeout", Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" })],
  ])("AC-write-refused . %s is a retryable `degraded` that is counted, never a 500, and carries no connection text", async (_name, cause) => {
    const { pool, released } = fakePool((sql) => (/^BEGIN/u.test(sql) ? cause : undefined));
    const err = await inBillingWriteTransaction(pool, { workspaceId: WS, actorId: WS }, () => Promise.resolve()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "degraded" });
    expect(counter).toHaveBeenCalledWith("nominara_billing_write_pool_timeout_total", {});
    expect(released).toHaveLength(1);
  });

  it("AC-write-refused . a failure that is not a wait or a timeout is NOT disguised as one", async () => {
    const { pool } = fakePool((sql) => (/^BEGIN/u.test(sql) ? Object.assign(new Error("syntax error"), { code: "42601" }) : undefined));
    await expect(inBillingWriteTransaction(pool, { workspaceId: WS, actorId: WS }, () => Promise.resolve())).rejects.toMatchObject({ message: "syntax error" });
  });
});
