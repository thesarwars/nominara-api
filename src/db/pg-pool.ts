import { Pool } from "pg";
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
  return tenantAwarePool(new Pool({ connectionString, ...options }), TENANT_TABLES);
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
