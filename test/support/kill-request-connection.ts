import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Client, Pool, PoolClient } from "pg";
import { PG_POOL } from "../../src/db/pg-pool.js";
import type { FakeStripeGateway } from "./fake-stripe-gateway.js";

// NEW-D-2 audit — fault injection for "the request died after Stripe created the
// session": the instant the fake gateway has created one, the API's own
// connection (the only backend idle IN a transaction while the request waits on
// Stripe) is terminated, so the request's uncommitted transaction is lost, just
// as it is when a pod is killed mid-deploy or the connection drops.
//
// ⚠ A terminated backend makes `pg` emit `error` on the checked-out client, and
// nothing in the request path listens for it (TenantContextInterceptor does not),
// which Node reports as an uncaught exception and vitest as a failed run. The
// listener added here only keeps the INJECTED fault from failing the run; the
// request still fails exactly as it would (its next query throws).

export async function whileRequestConnectionIsKilledAfterStripeCreatesASession<T>(
  app: NestFastifyApplication,
  db: Client,
  gateway: FakeStripeGateway,
  fn: () => Promise<T>,
): Promise<T> {
  const pool = app.get<Pool>(PG_POOL, { strict: false });
  const swallow = (client: PoolClient): void => {
    client.on("error", () => undefined);
  };
  pool.on("acquire", swallow);
  gateway.onSessionCreated = async () => {
    await db.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()");
  };
  try {
    return await fn();
  } finally {
    gateway.onSessionCreated = undefined;
    pool.off("acquire", swallow);
  }
}
