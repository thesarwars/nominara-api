import { Pool } from "pg";

// STORY-022 — the DI token for the pooled Postgres connection (through
// pgBouncer's transaction-mode pool, per docker-compose.yml/.env.example's
// DATABASE_URL_POOLED) that TenantContextInterceptor and HealthService both
// check connections out of. A full DrizzleService (project-structure.md
// §2) is a later story's job; this is the minimal shared seam so neither
// consumer defines its own competing token.
export const PG_POOL = Symbol("PG_POOL");

export function createPgPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}
