import { Logger } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { incrementCounter } from "../lib/telemetry/metrics.js";
import { tenantAwarePool } from "../tenancy/query-guard.js";
import { TENANT_TABLES } from "./rls/tenant-tables.generated.js";

// STORY-022 — the DI token for the pooled Postgres connection (through
// pgBouncer's transaction-mode pool, per docker-compose.yml/.env.example's
// DATABASE_URL_POOLED) that TenantContextInterceptor and HealthService both
// check connections out of. A full DrizzleService (project-structure.md
// §2) is a later story's job; this is the minimal shared seam so neither
// consumer defines its own competing token.
export const PG_POOL = Symbol("PG_POOL");

/**
 * NEW-E-098b — the SECOND pool: logs in as `nominara_portal` (SELECT only, `portal_scope_*` policies). `null` when
 * DATABASE_URL_PORTAL is unset, so the portal fails closed (503) instead of quietly serving from the app pool.
 */
export const PORTAL_PG_POOL = Symbol("PORTAL_PG_POOL");

// STORY-118 — security-and-tenancy.md §4's NFR-SEC-01, in force.
//
// STORY-011 built the guard, the client-wrapping Proxy, the generated
// tenant-table set and the actor-only allow-list, and unit-tested all of
// it. Nothing called any of it. The pool was constructed bare on the line
// below, so the guard had no production caller at all and the repository's
// own disclosure ("we have a coarse guard") described an object rather than
// an effect.
//
// This is the one place it belongs. Both callers of createPgPool — the API
// (src/db/db.module.ts) and the worker (src/worker.ts) — get the same seam
// from the same line, so there is no path that checks out an unwrapped
// client and no worker exemption to write down.
//
// What this does NOT change is the isolation guarantee. RLS is the
// boundary; the guard is a regex heuristic over SQL text (see
// query-guard.ts's header, README gap G-6) and RLS is not fooled by the
// cases it misses. What the guard buys is that "forgot the context"
// surfaces as a loud failure in the first test that touches the path,
// instead of as zero rows that look like an empty list.
export function createPgPool(connectionString: string, options: PoolTuning = {}): Pool {
  const pool = new Pool({ connectionString, ...options });
  attachErrorListeners(pool);
  return tenantAwarePool(pool, TENANT_TABLES);
}

const logger = new Logger("pg-pool");

/**
 * Checkpoint-6 — ⚠ A CHECKED-OUT CLIENT HAS NO ERROR LISTENER UNLESS WE LEAVE ONE.
 *
 * pg-pool removes its own idle listener when it hands a client out. With the pooler's `query_wait_timeout` set, a
 * request whose BEGIN waits for a server connection has its connection closed by pgBouncer: the query rejects,
 * and the socket's `end` then emits `error` on the Client. With no listener that is an uncaught exception and the
 * process exits, taking every tenant's in-flight request with it. Every pool built here (main, settlement,
 * portal, worker, write) therefore leaves a listener on every client it creates, and one on the pool. The query's
 * own rejection is what the caller handles; this only keeps the event from being fatal. The error text is never
 * logged: it can carry the connection string.
 */
function attachErrorListeners(pool: Pool): void {
  pool.on("connect", (client: PoolClient) => {
    client.on("error", () => {
      incrementCounter("nominara_db_client_error_total", {});
      logger.error({ message: "a pooled database client emitted an error event; the connection is unusable and is discarded on release" });
    });
  });
  pool.on("error", () => {
    incrementCounter("nominara_db_pool_error_total", {});
    logger.error({ message: "an idle pooled database client failed; it is removed from the pool" });
  });
}

/**
 * A failure of the CONNECTION rather than of the statement: pgBouncer closing a waiting client
 * (`query_wait_timeout`), a socket that ended, a server shutdown. The connection is unusable and must be destroyed
 * (`release(error)`), and the request is a retryable 503, not a 500.
 */
export function isConnectionClassFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && (code.startsWith("08") || code.startsWith("57P0") || code === "ECONNRESET" || code === "EPIPE")) return true;
  return typeof message === "string" && /query_wait_timeout|Connection terminated|server closed the connection|Client has encountered a connection error/u.test(message);
}

/**
 * The knobs a SECOND pool needs, and nothing more.
 *
 * STORY-072's settlement pool is small and bounded on purpose, and the
 * second-engineer review caught it being built as a bare `new Pool(...)` —
 * which made the sentence above ("no path that checks out an unwrapped
 * client") false the moment it landed. Tuning goes through here so a caller
 * that needs different limits still gets the guard.
 */
export interface PoolTuning {
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
}
