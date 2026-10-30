import type { ClientBase } from "pg";

// A worker job runs inside a tenant transaction (`withTenantJob`): `app.current_workspace()` is set, transaction-locally. A handler under
// test that is handed the bare owner connection has no workspace, so any statement carrying the `workspace_id = app.current_workspace()`
// predicate reads nothing (STORY-061 r4). These helpers give such a test the context a job has, on the SAME connection.
//
// `withTenantContext` is deliberately not used: its after-commit hooks reach for a queue some of these specs do not have.

/** Sets the tenant for the CURRENT transaction (the caller has already issued BEGIN). */
export async function setTenantLocal(db: ClientBase, workspaceId: string): Promise<void> {
  await db.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
}

/** BEGIN, set the tenant, run `fn`, COMMIT (ROLLBACK and rethrow on error). */
export async function asTenantJob<T>(db: ClientBase, workspaceId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    await setTenantLocal(db, workspaceId);
    const result = await fn();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
