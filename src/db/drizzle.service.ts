import { Inject, Injectable } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ClientBase, Pool } from "pg";
import { withTenantContext, type TenantContext } from "../tenancy/tenant-context.js";
import { PG_POOL } from "./pg-pool.js";
import * as schema from "./schema/index.js";

// STORY-122 — project-structure.md §2's `src/db/drizzle.service.ts`:
// "client, transaction helper, AsyncLocalStorage tx, query guard".
//
// Three of those four are inherited rather than rebuilt here, and that is
// the design rather than an omission:
//
//   - The AsyncLocalStorage transaction is withTenantContext's
//     (src/tenancy/tenant-context.ts). A second one would be a second answer
//     to "which context is active", and the two would disagree.
//   - The query guard is the one STORY-118 installed at pool construction.
//     Drizzle issues every statement through the same `pg` client that guard
//     wraps, so it sits BENEATH the query builder and a Drizzle query is
//     checked exactly as a raw one is. NFR-ARCH-03 names a `beforeQuery`
//     hook as the mechanism; the property it asserts is already in force,
//     and a second hook would only be a second place for it to be wrong.
//   - The client is the one the pool handed out, checked out and released
//     here.
//
// What this file adds is the fourth: the transaction helper that puts those
// three together, so that a service cannot get a Drizzle handle without
// also getting a tenant context.

// One behaviour worth knowing before you write a catch: Drizzle wraps
// whatever the driver throws in a DrizzleQueryError and hangs the original
// off `.cause`. The guard's refusal therefore still reaches the caller, and
// ProblemFilter maps it to the same 500 it maps a raw one to (nothing
// branches on TenantContextMissingError by type) — but
// `error instanceof TenantContextMissingError` is FALSE at the call site.
// Check `.cause`.
export type NominaraDatabase = NodePgDatabase<typeof schema>;

/**
 * A Drizzle handle over a client that is ALREADY inside a context-carrying
 * transaction.
 *
 * Exported for the worker paths, which open their context with
 * withTenantJob rather than withTenantContext and so cannot use
 * withTenantDb below. It takes a `ClientBase` and never a `Pool`, which is
 * what makes the escape impossible to write: a pool-level Drizzle query
 * would run on an implicit per-query connection that cannot carry
 * transaction-local context, and there is no overload here that accepts one.
 */
export function drizzleOn(client: ClientBase): NominaraDatabase {
  return drizzle(client as never, { schema });
}

/**
 * Checks a client out, opens `context` on it, and hands the body a Drizzle
 * handle bound to that transaction. The raw client is passed alongside it,
 * because some statements — a partition-maintenance DDL, an analytics query
 * with a window frame Drizzle cannot express — are still raw SQL, and they
 * belong in the SAME transaction rather than a second one.
 */
export async function withTenantDb<T>(
  pool: Pool,
  context: TenantContext,
  fn: (db: NominaraDatabase, tx: ClientBase) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await withTenantContext(client, context, async (tx) => fn(drizzleOn(tx), tx));
  } finally {
    client.release();
  }
}

/**
 * The injectable form, for modules that would otherwise inject PG_POOL only
 * to pass it straight back into withTenantDb. Identical semantics; it holds
 * the pool so a service does not have to.
 */
@Injectable()
export class DrizzleService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  run<T>(context: TenantContext, fn: (db: NominaraDatabase, tx: ClientBase) => Promise<T>): Promise<T> {
    return withTenantDb(this.pool, context, fn);
  }
}
