import { Client } from "pg";

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return url;
}

export async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

/**
 * ⚠ BOUNDS HOW LONG A DEAD PROCESS CAN HOLD THE LOCK, and without it this
 * handler's lock is strictly more dangerous than no lock at all.
 *
 * Used by every job that holds a session-scoped advisory lock for the length
 * of a run — `credit.reconcile` and `maintenance.partition` today.
 *
 * The case is a replica that is PARTITIONED rather than killed. Killed is
 * already safe — the backend dies and Postgres drops its session locks, which
 * is the argument `locks.ts` makes. Partitioned is not: the client is gone,
 * the backend is alive and idle holding the lock, and because
 * `pg_try_advisory_lock` is fleet-wide, every other replica's tick now yields.
 * No orphaned reservation in any workspace is returned to anyone until that
 * backend notices — and nothing in this repository sets any timeout, so it
 * notices at the OS TCP keepalive default, which is TWO HOURS on Linux.
 *
 * Worse, it is silent: a yielded tick completes successfully, so the
 * dead-letter queue stays empty and every alarm reads green while the one
 * path that hands credits back to customers who were never charged is dead.
 *
 * These are SERVER-side settings for this session, so the backend probes its
 * own peer and terminates itself in roughly 90 seconds instead of two hours —
 * and Postgres releases the session locks of a terminated backend.
 *
 * ⚠ DELIBERATELY NOT AN `idle_session_timeout`. That would also fire during a
 * perfectly healthy long scan: this connection is legitimately idle for most
 * of a run, because the releases happen on the `work` pool. It would then
 * terminate the holder MID-RUN, dropping the lock while the remaining
 * releases carried on unprotected — turning a bounded wait into the exact
 * concurrency this lock exists to prevent. Keepalives distinguish "idle" from
 * "gone"; a timeout cannot.
 *
 * ⚠ PASSED AS STARTUP OPTIONS RATHER THAN `SET`, and not to dodge anything.
 * `eslint-rules/no-session-scoped-config.js` bans a bare `SET` because
 * session-scoped config leaks across pooled connections under pgBouncer
 * transaction pooling (NFR-SEC-02) — a real hazard, and the rule is right.
 * It cannot apply here: this is `DATABASE_URL`, the DIRECT connection, opened
 * by `connect()` per job and never returned to a pool. Startup options are
 * also simply the better mechanism — the GUCs are in force from the moment
 * the backend starts, rather than after three round-trips during which the
 * window this closes is still open.
 */
export function withKeepalives(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", "-c tcp_keepalives_idle=60 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3");
  return url.toString();
}
