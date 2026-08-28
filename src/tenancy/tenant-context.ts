import { AsyncLocalStorage } from "node:async_hooks";
import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { ACTOR_GUC, SCOPE_GUC, WORKSPACE_GUC } from "./constants.js";

// STORY-011 — security-and-tenancy.md §4 "Tenant context propagation and the
// pooling constraint". Framework-agnostic: this repo has no NestJS scaffold
// yet, so this is a plain function over `pg.ClientBase` that a future
// NestJS interceptor calls into with a few lines of glue (open a
// transaction, call withTenantContext, run the handler as `fn`).

export interface TenantContext {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly scopeProjectIds?: readonly string[];
}

/** What src/tenancy/query-guard.ts reads via AsyncLocalStorage to know a context-carrying transaction is active. */
export interface TenantContextStore {
  readonly client: ClientBase;
  readonly context: TenantContext;
  /**
   * Defers a side effect until the transaction has COMMITTED.
   *
   * For anything that leaves this process and cannot be taken back: a realtime
   * event, a queued job, a webhook. `member.changed` was published from inside
   * the transaction, and it closes the affected sockets and tells every client
   * the membership changed — so a transaction that then failed left sockets
   * closed and clients informed about a change that never happened, while the
   * authoritative API they refetch said otherwise.
   *
   * A service cannot fix that itself: it does not own the transaction,
   * TenantContextInterceptor does, and there is no way to see the commit from
   * inside the handler. Hence a seam here rather than a rule nobody can follow.
   *
   * Tasks run in registration order, and a task that throws is logged and
   * skipped rather than propagated — by then the transaction is durable, and
   * failing the request would report failure for a change that happened, which
   * is the same defect pointing the other way.
   */
  readonly afterCommit: (task: () => void) => void;
}

const storage = new AsyncLocalStorage<TenantContextStore>();
const logger = new Logger("tenant-context");

/** Returns the active tenant context store, or undefined outside any withTenantContext/withTenantJob call. */
export function currentTenantStore(): TenantContextStore | undefined {
  return storage.getStore();
}

/**
 * Opens ONE transaction carrying `context`, per security-and-tenancy.md §4:
 *
 *   BEGIN
 *   → SELECT set_config('app.current_workspace_id', $workspaceId, true)
 *   → SELECT set_config('app.current_actor_id',     $actorId,     true)
 *   → SELECT set_config('app.current_scope_projects', $scopeCsv,   true)   -- only if non-empty
 *   → fn(client), run inside AsyncLocalStorage.run so query-guard.ts and any
 *     nested withTenantContext call can see the active store
 *   → COMMIT on success
 *   → ROLLBACK on throw, then rethrow the ORIGINAL error (a rollback
 *     failure is attached as .cause, never allowed to mask the real error)
 *
 * `is_local => true` (set_config's third argument, i.e. SET LOCAL semantics)
 * is non-negotiable: it is what makes this safe under pgBouncer
 * transaction-mode pooling (verified by STORY-010's own
 * pgbouncer-transaction-mode.spec.ts) — a session-scoped SET would leak this
 * tenant's context to the next tenant that borrows the pooled connection.
 * Every value below is a bind parameter, never string-interpolated into the
 * SQL text.
 */
/**
 * Defers a side effect until the ambient transaction commits.
 *
 * THROWS when there is no ambient transaction, deliberately. The alternative —
 * running the effect immediately — is defensible (nothing to wait for) and
 * wrong here: it would hand a future call site the exact pre-commit semantics
 * this seam exists to remove, silently, and the failure would surface as a
 * client told about a mutation that was rolled back rather than as an error
 * anyone could trace. Every current caller already dereferences
 * `currentTenantStore()!` for its client, so a missing store is a bug at the
 * call site either way; this makes it say so.
 */
export function afterCommit(task: () => void): void {
  const store = storage.getStore();
  if (store === undefined) {
    throw new Error(
      "afterCommit() was called with no active tenant transaction. It exists to defer an effect past COMMIT; " +
        "outside a transaction there is no commit to defer to, and running the effect anyway is what this seam " +
        "exists to prevent.",
    );
  }
  store.afterCommit(task);
}

/**
 * Runs deferred side effects, and lets none of them break the others.
 *
 * The transaction is durable by the time this runs, so a throwing task must
 * not become a failed response: the caller would retry a mutation that already
 * happened. Each is isolated, and a failure is logged rather than swallowed —
 * a dropped realtime event is acceptable (the client refetches), silence about
 * dropping it is not.
 */
function runAfterCommitTasks(tasks: readonly (() => void)[]): void {
  for (const task of tasks) {
    try {
      task();
    } catch (error) {
      logger.error({
        message: "after-commit task failed; the transaction is committed and this effect was dropped",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

export async function withTenantContext<T>(
  client: ClientBase,
  context: TenantContext,
  fn: (tx: ClientBase) => Promise<T>,
): Promise<T> {
  // Fix pass (second pass) — BEGIN and the set_config calls used to run
  // OUTSIDE this try block. If any of them threw (e.g. a bad bind value, a
  // connection blip), no ROLLBACK was ever issued and the caller got back a
  // connection sitting in an open, aborted transaction — especially bad
  // under pgBouncer transaction-mode pooling, where that pins a server
  // connection in a broken state instead of releasing it. Moved inside the
  // try/catch so a failure during context-setting still triggers the same
  // rollback-and-rethrow path as a failure inside `fn`.
  try {
    await client.query("BEGIN");

    await client.query("SELECT set_config($1, $2, true)", [WORKSPACE_GUC, context.workspaceId]);
    await client.query("SELECT set_config($1, $2, true)", [ACTOR_GUC, context.actorId]);
    if (context.scopeProjectIds && context.scopeProjectIds.length > 0) {
      await client.query("SELECT set_config($1, $2, true)", [SCOPE_GUC, context.scopeProjectIds.join(",")]);
    }

    const afterCommitTasks: Array<() => void> = [];
    const store: TenantContextStore = {
      client,
      context,
      afterCommit: (task) => {
        afterCommitTasks.push(task);
      },
    };
    const result = await storage.run(store, () => fn(client));
    await client.query("COMMIT");
    // AFTER the commit, and only after. A task registered by a body that then
    // threw, or by one whose COMMIT failed, never reaches this line at all —
    // control has already left through the catch below.
    runAfterCommitTasks(afterCommitTasks);
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Never let a rollback failure mask the real error — attach it as
      // .cause (unless the thrown value already carries one) and continue
      // rethrowing the ORIGINAL error below.
      if (error instanceof Error && error.cause === undefined) {
        error.cause = rollbackError;
      }
    }
    throw error;
  }
}

// STORY-021 / ADR-0001 — "Actor-self-scoped RLS policy class for cross-
// workspace self-reads". A deliberately SEPARATE type and AsyncLocalStorage
// instance from TenantContext/TenantContextStore/storage above — NOT
// TenantContext with an optional workspaceId — so no call site can
// structurally smuggle a workspace id through this path. Used only for the
// two reads ADR-0001 covers (GET /workspaces, the 409 conflict's "naming the
// existing workspace" detail): every other tenant-scoped query must keep
// using withTenantContext.

export interface ActorOnlyContext {
  readonly actorId: string;
}

/** What src/tenancy/query-guard.ts reads via AsyncLocalStorage to know an actor-only-context transaction is active. */
export interface ActorContextStore {
  readonly client: ClientBase;
  readonly context: ActorOnlyContext;
}

const actorStorage = new AsyncLocalStorage<ActorContextStore>();

/** Returns the active actor-only context store, or undefined outside any withActorContext call. */
export function currentActorStore(): ActorContextStore | undefined {
  return actorStorage.getStore();
}

/**
 * Opens ONE transaction in the actor-only context ADR-0001 defines:
 *
 *   BEGIN
 *   → SET LOCAL TRANSACTION READ ONLY                                  -- defense-in-depth beyond RLS's own WITH CHECK
 *   → SELECT set_config('app.current_workspace_id', '', true)          -- EXPLICITLY cleared, never left merely unset
 *   → SELECT set_config('app.current_actor_id',     $actorId, true)
 *   → fn(client), run inside AsyncLocalStorage.run so query-guard.ts sees the active actor-only store
 *   → COMMIT on success
 *   → ROLLBACK on throw, then rethrow the ORIGINAL error (same posture as withTenantContext)
 *
 * The workspace GUC is cleared to an empty string, not merely left unset —
 * `app.current_workspace()` reads it via `NULLIF(current_setting(...), '')`,
 * so an explicit clear and an unset GUC are indistinguishable to every
 * policy, but an explicit clear cannot be confused with "the caller forgot
 * to set it" (STORY-021-E-11 / ADR-0001). `is_local => true` on every
 * set_config call, same pgBouncer transaction-mode-pooling reasoning as
 * withTenantContext above.
 */
export async function withActorContext<T>(
  client: ClientBase,
  context: ActorOnlyContext,
  fn: (tx: ClientBase) => Promise<T>,
): Promise<T> {
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TRANSACTION READ ONLY");

    await client.query("SELECT set_config($1, $2, true)", [WORKSPACE_GUC, ""]);
    await client.query("SELECT set_config($1, $2, true)", [ACTOR_GUC, context.actorId]);

    const store: ActorContextStore = { client, context };
    const result = await actorStorage.run(store, () => fn(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      if (error instanceof Error && error.cause === undefined) {
        error.cause = rollbackError;
      }
    }
    throw error;
  }
}
