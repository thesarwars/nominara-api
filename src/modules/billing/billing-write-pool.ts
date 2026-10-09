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

/** A short transaction on a connection of the write pool, committing independently of the request's. */
export async function inBillingWriteTransaction<T>(pool: Pool, context: TenantContext, fn: (tx: ClientBase) => Promise<T>): Promise<T> {
  const client = await connectForWrite(pool);
  try {
    return await withTenantContext(client, context, fn);
  } finally {
    client.release();
  }
}
