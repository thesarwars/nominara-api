import { Client } from "pg";
import type { AssertionContext, SuperuserCredentials } from "./assertion-context.js";
import type { ConnectionTarget } from "./runtime-roles.js";
import type { Breaker } from "./breakers.js";

// STORY-012 T6 — CREATE DATABASE ... TEMPLATE <seeded-db> per breaker, so a
// breaker's mutation can NEVER contaminate the shared fixture every
// non-breaker spec file reads: each breaker gets its own disposable, full
// binary copy of the seeded database, mutated, exercised, and dropped.

export interface MaintenanceConnection {
  readonly host: string;
  readonly port: number;
  /** The database name to connect to for CREATE/DROP DATABASE — must NOT be the template itself, and must not be the disposable db being created. */
  readonly maintenanceDatabase: string;
  readonly superuser: SuperuserCredentials;
}

function admin(conn: MaintenanceConnection, database = conn.maintenanceDatabase): Client {
  return new Client({ host: conn.host, port: conn.port, database, user: conn.superuser.user, password: conn.superuser.password });
}

export interface BrokenDatabaseHandle {
  readonly ctx: AssertionContext;
  dispose(): Promise<void>;
}

/**
 * Creates a disposable database templated off `templateDatabase`, applies
 * `breaker.apply`, and returns an AssertionContext pointed at it (so the
 * SAME assertion function used for the green path runs unmodified against
 * the broken copy). `dispose()` reverts (for the rare cluster-wide breaker)
 * and drops the disposable database.
 */
export async function createBrokenDatabase(
  conn: MaintenanceConnection,
  templateDatabase: string,
  breaker: Breaker,
  fixture: AssertionContext["fixture"],
): Promise<BrokenDatabaseHandle> {
  const dbName = `nominara_iso_breaker_${breaker.id.toLowerCase().replace(/[^a-z0-9]/g, "")}_${Date.now()}`;

  const maintenanceClient = admin(conn);
  await maintenanceClient.connect();
  try {
    await maintenanceClient.query(`CREATE DATABASE ${dbName} TEMPLATE ${templateDatabase}`);
  } finally {
    await maintenanceClient.end();
  }

  const brokenClient = admin(conn, dbName);
  await brokenClient.connect();
  await breaker.apply(brokenClient);

  const target: ConnectionTarget = { host: conn.host, port: conn.port, database: dbName };
  const ctx: AssertionContext = { target, superuser: conn.superuser, fixture };

  return {
    ctx,
    async dispose() {
      await breaker.revert(brokenClient);
      await brokenClient.end();
      const cleanup = admin(conn);
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
