import type { ClientBase } from "pg";
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

  const tenantStore = currentTenantStore();
  if (tenantStore !== undefined && tenantStore.client === client) {
    return;
  }

  const actorStore = currentActorStore();
  if (actorStore !== undefined && actorStore.client === client) {
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
