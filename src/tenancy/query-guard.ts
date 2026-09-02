import type { ClientBase, Pool, PoolClient } from "pg";
import { ACTOR_SELF_SCOPED_TABLES } from "../db/conventions.js";
import { currentActorStore, currentTenantStore } from "./tenant-context.js";
import { TenantContextMissingError } from "./errors.js";

// STORY-011 — security-and-tenancy.md §4's NFR-SEC-01. IMPORTANT: the table
// extraction below is a HEURISTIC regex over the SQL text, NOT a real SQL
// parser — it can be fooled by sufficiently exotic SQL (subqueries in
// unusual positions, dynamically-built identifiers, etc). This guard is NOT
// the security boundary; RLS (migration 0006, src/db/rls/generate.ts) is.
// This guard exists purely to convert "forgot the interceptor" into a fast,
// loud failure in CI/tests, rather than a silent cross-tenant read that RLS
// happens to also prevent. G-6 (disclosed in README.md): this wraps `pg`
// directly with a regex heuristic, not a real Drizzle `beforeQuery` hook —
// Drizzle is a dependency in this repo but is used nowhere for actual
// queries yet, a standing observation for a future story.

const TABLE_REF_PATTERN = /\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?(?:\."?([a-zA-Z_][a-zA-Z0-9_]*)"?)?/gi;

function extractTableNames(sqlText: string): string[] {
  const names: string[] = [];
  for (const match of sqlText.matchAll(TABLE_REF_PATTERN)) {
    // Support a schema-qualified reference (`public.answer_captures`) by
    // taking the second capture group when present, the first otherwise.
    names.push(match[2] ?? match[1]!);
  }
  return names;
}

/**
 * STORY-118 — how a wrapped client answers "what am I really?".
 *
 * Before this story nothing wrapped anything, so every client a service saw
 * WAS the client the guard was invoked with and identity was trivially
 * equal. Installing the guard at pool construction breaks that: a service
 * checks out the WRAPPER, opens its context on the WRAPPER, and the Proxy
 * then invokes the check with the target underneath. Comparing those two
 * directly would refuse every correctly-written service in the repository —
 * the guard would fire on exactly the code that got it right.
 *
 * So identity is compared after unwrapping BOTH sides. A wrapper and its
 * target are the same connection and must compare equal; two different
 * connections must not, wrapped or bare, which is the property fix pass
 * item 11(c) added and this must not weaken.
 */
const GUARD_TARGET: unique symbol = Symbol("query-guard.target");

function unwrapGuarded(client: ClientBase): ClientBase {
  const target = (client as unknown as Record<symbol, unknown>)[GUARD_TARGET];
  return (target as ClientBase | undefined) ?? client;
}

const ACTOR_SELF_SCOPED_TABLE_SET = new Set<string>(ACTOR_SELF_SCOPED_TABLES);

/**
 * Throws TenantContextMissingError if `sqlText` appears to touch any table
 * in `tenantTables` while `client` is not the SAME client instance the
 * active withTenantContext/withTenantJob store is carrying (fix pass item
 * 11(c) — previously this only checked "is ANY store active ambiently",
 * which incorrectly passed a query on client B while client A had an
 * unrelated context active on the same AsyncLocalStorage chain; two
 * concurrently-open contexts on two different clients must never authorize
 * each other's queries). BEGIN/COMMIT/ROLLBACK/set_config and any query
 * touching only global tables pass through untouched, because none of their
 * SQL text matches TABLE_REF_PATTERN against a tenant name.
 *
 * STORY-021 / ADR-0001 — a SECOND allow-list check, only reached when no
 * ordinary tenant context is active on this client: if an actor-only
 * context (withActorContext) IS active on this client, the query is allowed
 * ONLY when every referenced tenant table is in ACTOR_SELF_SCOPED_TABLES.
 * A query reaching for any other tenant table under an actor-only context —
 * e.g. a future accidental reuse of withActorContext against `projects` —
 * still throws loudly here, rather than relying on RLS's silent zero-rows
 * behavior as the only backstop.
 */
export function assertTenantContext(sqlText: string, tenantTables: ReadonlySet<string>, client: ClientBase): void {
  const referenced = extractTableNames(sqlText);
  const referencedTenantTables = referenced.filter((name) => tenantTables.has(name));
  if (referencedTenantTables.length === 0) {
    return;
  }

  const connection = unwrapGuarded(client);

  const tenantStore = currentTenantStore();
  if (tenantStore !== undefined && unwrapGuarded(tenantStore.client) === connection) {
    return;
  }

  const actorStore = currentActorStore();
  if (actorStore !== undefined && unwrapGuarded(actorStore.client) === connection) {
    const outsideAllowList = referencedTenantTables.filter((name) => !ACTOR_SELF_SCOPED_TABLE_SET.has(name));
    if (outsideAllowList.length === 0) {
      return;
    }
    throw new TenantContextMissingError(
      `query touches tenant table(s) [${outsideAllowList.join(", ")}] outside ACTOR_SELF_SCOPED_TABLES ` +
        `[${[...ACTOR_SELF_SCOPED_TABLE_SET].join(", ")}] while an actor-only context (withActorContext) is ` +
        "active on THIS client — actor-only context may only reach the ADR-0001 allow-list.",
    );
  }

  throw new TenantContextMissingError(
    `query touches tenant table(s) [${referencedTenantTables.join(", ")}] outside a ` +
      "context-carrying transaction on THIS client — wrap the call in withTenantContext/withTenantJob using " +
      "the same client the query runs on.",
  );
}

/**
 * Wraps `client` in a Proxy intercepting `.query()`. See assertTenantContext
 * for the check itself; this is just the client-wrapping seam that a future
 * NestJS module would install once, at connection-pool construction time.
 */
export function tenantAware<C extends ClientBase>(client: C, tenantTables: ReadonlySet<string>): C {
  return new Proxy(client, {
    get(target, prop, receiver) {
      // STORY-118 — how unwrapGuarded above sees through this Proxy. A
      // symbol, not a string property, so it cannot collide with anything
      // `pg` exposes now or later.
      if (prop === GUARD_TARGET) {
        return target;
      }
      if (prop === "query") {
        return (...args: unknown[]) => {
          const first = args[0];
          const sqlText = typeof first === "string" ? first : ((first as { text?: string })?.text ?? "");
          assertTenantContext(sqlText, tenantTables, target);
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as C;
}

/**
 * STORY-118 — the pool-level refusal.
 *
 * `pool.query()` takes an implicit per-query connection and gives it back
 * immediately. Under pgBouncer transaction-mode pooling (STORY-010) that
 * connection can never carry transaction-local context, so a pool-level
 * query against a tenant table is context-free BY CONSTRUCTION — there is
 * no way to write it correctly, which is why this refuses outright instead
 * of consulting the active stores the way assertTenantContext does. An
 * ambient context, if one exists, belongs to a DIFFERENT connection than
 * the one this query borrows, and would authorise nothing.
 *
 * Note what this is NOT: a claim that RLS would have let the query through.
 * As `nominara_app` (NOBYPASSRLS, FORCE ROW LEVEL SECURITY on every tenant
 * table) it returns zero rows, and zero rows read as an empty list. This
 * converts that silence into a sentence.
 */
export function assertPoolLevelQuery(sqlText: string, tenantTables: ReadonlySet<string>): void {
  const referenced = extractTableNames(sqlText).filter((name) => tenantTables.has(name));
  if (referenced.length === 0) {
    return;
  }
  throw new TenantContextMissingError(
    `query touches tenant table(s) [${referenced.join(", ")}] on the POOL rather than on a checked-out ` +
      "client. Under transaction-mode pooling an implicit per-query connection cannot carry " +
      "transaction-local context, so this query is context-free by construction — check a client out with " +
      "pool.connect() and wrap the call in withTenantContext/withTenantJob on that client.",
  );
}

/**
 * Installs the guard where the pool is BUILT, so every client the pool hands
 * out is wrapped and the pool's own query path is closed.
 *
 * Installing this at the request interceptor instead would cover one
 * checkout path out of many: most services in this repository call
 * `pool.connect()` themselves, and those are exactly the paths a future
 * mistake will take. `src/db/pg-pool.ts`'s createPgPool is the single
 * function both the API (src/db/db.module.ts) and the worker
 * (src/worker.ts) build their pool with, so one call there covers the
 * request path, the queue path, and anything either grows later —
 * NFR-SEC-01's "worker and job paths are covered by the same seam", with no
 * exemption needed because there is no second seam to exempt.
 *
 * Drizzle, when it becomes the query path, sits ABOVE this: it issues its
 * SQL through the same `pg` client this wraps, so it inherits the check
 * rather than needing a second one.
 */
export function tenantAwarePool<P extends Pool>(pool: P, tenantTables: ReadonlySet<string>): P {
  return new Proxy(pool, {
    // No `receiver` parameter, deliberately — see the Reflect.get below.
    get(target, prop) {
      if (prop === "connect") {
        return (callback?: (err: Error | undefined, client: PoolClient, done: () => void) => void) => {
          // `pg` supports both a promise and a callback form. Nothing in
          // this repository uses the callback form today, and a client
          // handed out through an unwrapped path is the one hole this
          // function exists to close — so both are covered.
          if (typeof callback === "function") {
            return (target.connect as (cb: typeof callback) => void)((err, client, done) => {
              callback(err, err ? client : tenantAware(client, tenantTables), done);
            });
          }
          return target.connect().then((client) => tenantAware(client, tenantTables));
        };
      }

      if (prop === "query") {
        return (...args: unknown[]) => {
          const first = args[0];
          const sqlText = typeof first === "string" ? first : ((first as { text?: string })?.text ?? "");
          assertPoolLevelQuery(sqlText, tenantTables);
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }

      // `target` as the receiver, deliberately — pg.Pool's totalCount /
      // idleCount / waitingCount are getters over private fields, and they
      // must read the real pool's state rather than re-entering this trap
      // for every field they touch.
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as P;
}
