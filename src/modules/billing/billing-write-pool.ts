import { Logger } from "@nestjs/common";
import type { ClientBase, Pool, PoolClient } from "pg";
import { DegradedError } from "../../api/errors/domain-errors.js";
import { createPgPool } from "../../db/pg-pool.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { withTenantContext, type TenantContext } from "../../tenancy/tenant-context.js";

// STORY-075a / STORY-076a / STORY-076b checkpoint-4 — the pool for a billing request's SHORT INDEPENDENT WRITES.
//
// ⚠ A HOLDER OF THE MAIN POOL MUST NEVER WAIT ON THE MAIN POOL. Checkout, the credit-pack purchase and add-ons
// commit a record in its own transaction BEFORE Stripe is asked, which needs a second connection while the
// request's own is still checked out. Taken from the same pool, that is hold-and-wait: with as many such
// requests in flight as the pool has connections, every one holds one and waits for another that only a holder
// can return, and the whole API stops answering (the default max is 10 and `pool.connect()` waits forever).
//
// So those writes run on THIS pool: small, with a real connection timeout, built through `createPgPool` so it
// carries the tenant guard too (the same arrangement as the credit interceptor's settlement pool). Its
// connections are held for one statement's time and are never held across a wait on anything else, so it
// cannot deadlock on itself; at worst a request is refused with a retryable 503.

export const BILLING_WRITE_POOL = Symbol("BILLING_WRITE_POOL");

/** Fewer than the main pool's default of 10: the writes are short, and a bound is what makes the wait finite. */
export const BILLING_WRITE_POOL_MAX = 4;
/** The longest a request waits for a write connection before it is refused with a retryable 503. */
export const BILLING_WRITE_CONNECT_TIMEOUT_MS = 2_000;

const logger = new Logger("billing-write-pool");

export function createBillingWritePool(connectionString: string): Pool {
  const pool = createPgPool(connectionString, { max: BILLING_WRITE_POOL_MAX, connectionTimeoutMillis: BILLING_WRITE_CONNECT_TIMEOUT_MS });
  pool.on("error", (error) => {
    logger.error(`billing write pool error: ${String(error)}`);
  });
  return pool;
}

/**
 * A connection for one short write, or a retryable 503. The pool's own error text can carry the connection
 * string, so nothing of it is passed on: the cause is only counted.
 */
export async function connectForWrite(pool: Pool): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch {
    incrementCounter("nominara_billing_write_pool_timeout_total", {});
    logger.error({ message: "no billing write connection within the bound; request refused as retryable" });
    throw new DegradedError({ message: "billing is busy: retry shortly" });
  }
}

/** Server-side bounds on every write-pool transaction: a short write that runs longer, or waits longer for a row lock, is refused. */
export const BILLING_WRITE_STATEMENT_TIMEOUT_MS = 5_000;
export const BILLING_WRITE_LOCK_TIMEOUT_MS = 3_000;

/**
 * ⚠ THE WRITE POOL'S WAIT FOR A SERVER CONNECTION IS NOT BOUNDED BY ITS CONNECT TIMEOUT. Behind pgBouncer the
 * login is checked against its auth_file, so `connect()` succeeds at once, and the BEGIN then queues in pgBouncer
 * for a server connection of the (database, user) pool the main pool, the settlement pool and the worker share.
 * `connectionTimeoutMillis` does not cover that wait; pgBouncer's `query_wait_timeout` (set in
 * docker/pgbouncer/pgbouncer.ini) does, by closing the waiting client's connection. This is the other half: the
 * resulting error, a statement timeout or a lock timeout is a retryable 503, never a 500 and never a hang.
 */
function isBoundedWaitFailure(error: unknown): boolean {
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "08P01" || code === "57014" || code === "55P03") return true;
  return typeof message === "string" && /query_wait_timeout|Connection terminated/u.test(message);
}

/**
 * A short transaction on a connection of the write pool, committing independently of the request's, bounded on
 * the server (transaction-local `statement_timeout` and `lock_timeout`) and in the pooler (see above). The
 * connection of a failed wait is destroyed rather than returned: pgBouncer may have closed it.
 */
export async function inBillingWriteTransaction<T>(pool: Pool, context: TenantContext, fn: (tx: ClientBase) => Promise<T>): Promise<T> {
  const client = await connectForWrite(pool);
  let failure: Error | undefined;
  // pgBouncer closing this connection (query_wait_timeout) emits 'error' on it; a checked-out client has no
  // listener of the pool's, and an unhandled 'error' event would take the process down. The query itself rejects
  // with the same error, which is what is handled below.
  const onClientError = (): void => undefined;
  client.on("error", onClientError);
  try {
    return await withTenantContext(client, context, async (tx) => {
      await tx.query("SELECT set_config('statement_timeout', $1, true)", [String(BILLING_WRITE_STATEMENT_TIMEOUT_MS)]);
      await tx.query("SELECT set_config('lock_timeout', $1, true)", [String(BILLING_WRITE_LOCK_TIMEOUT_MS)]);
      return await fn(tx);
    });
  } catch (error) {
    if (!isBoundedWaitFailure(error)) throw error;
    failure = error as Error;
    incrementCounter("nominara_billing_write_pool_timeout_total", {});
    logger.error({ message: "a billing write was refused as retryable: no server connection or no answer within the bound" });
    throw new DegradedError({ message: "billing is busy: retry shortly" });
  } finally {
    // release(error) destroys the connection; release() returns it.
    client.off("error", onClientError);
    client.release(failure);
  }
}
