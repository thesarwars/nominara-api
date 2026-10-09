import type { ClientBase } from "pg";

// Checkpoint-5/6 — the ONE bounded wait for the workspace row lock, shared by EVERY writer of that row that
// takes it on a pooled connection: the billing paths (add, remove, checkout, the Stripe webhook handlers) and, from
// checkpoint-6, the others (PATCH /workspaces/:id, suspend, the entitlement bump, the plan-set worker, retention).
// A writer that does not bound its wait queues behind a billing holder that is inside a Stripe call.
//
// ⚠ AN UNBOUNDED `FOR UPDATE` IS A POOL DRAIN. The holder of this lock calls Stripe (up to five calls of 10 s
// each) while it holds it, and every request queued behind it keeps a main-pool connection checked out while it
// waits. Enough of them and every other tenant's request queues for a connection. A wait of at most
// `WORKSPACE_LOCK_WAIT_MS` turns that into a prompt, retryable refusal: the waiters give their connections back.
// The setting is transaction-local (`set_config(..., true)`), and reset once the lock is held so the rest of
// the transaction is not subject to it.

/** The longest a billing path waits for the workspace row lock. */
export const WORKSPACE_LOCK_WAIT_MS = 3_000;

/** Takes the workspace row lock within the bound. Throws whatever `onTimeout` returns when the wait is exceeded (SQLSTATE 55P03); any other failure propagates unchanged. */
export async function lockWorkspaceBounded(client: ClientBase, workspaceId: string, onTimeout: () => Error): Promise<void> {
  await client.query("SELECT set_config('lock_timeout', $1, true)", [String(WORKSPACE_LOCK_WAIT_MS)]);
  try {
    await client.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
  } catch (error) {
    if ((error as { code?: string }).code !== "55P03") throw error;
    throw onTimeout();
  }
  await client.query("SELECT set_config('lock_timeout', '0', true)");
}
