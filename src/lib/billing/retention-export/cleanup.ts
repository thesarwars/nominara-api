import { Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { SYSTEM_ACTOR_ID } from "../../../tenancy/constants.js";
import { withTenantContext } from "../../../tenancy/tenant-context.js";
import { StorageTenancyError } from "../../storage/storage-keys.js";
import type { TenantObjectStore } from "../../storage/tenant-object-store.js";
import { incrementCounter } from "../../telemetry/metrics.js";

// STORY-185 / owner decision 100(j) - the stored zip of a full-data export is deleted when its link expires, so a copy of purged data does not outlive
// the deferral. Run by the nightly `report.cleanup` job beside the report-artifact cleanup, in the same shape (reports/artifact-cleanup.ts):
//   discovery   owner connection: export ids and workspace ids only (cross-tenant; the table is FORCE RLS)
//   per workspace, in that workspace's own tenant context as the runtime role:
//     phase 1   ONE short transaction: re-read what is still due (RLS plus `workspace_id = app.current_workspace()`), bind the object store
//     phase 2   NO transaction, no connection: delete each object (deleting an absent object succeeds, so a rerun and a vanished object are fine)
//     phase 3   ONE short transaction: stamp `object_purged_at` on exactly the exports whose object is gone
// "Due" = ready, `expires_at` past (the DATABASE clock), not yet stamped. `object_key` is kept. A storage error leaves the row unstamped: it is retried at
// the next run and counted as a failure (the job then fails and walks its ladder). A crash between phases 2 and 3 leaves it due: the next run deletes again
// (harmless) and stamps. A key outside the workspace's prefix is REFUSED (a tenancy event, never a deletion): it is counted and logged, left as evidence,
// and is not a failure (it cannot succeed on a retry).

const logger = new Logger("billing.retention_export.cleanup");

export const DEFAULT_RETENTION_CLEANUP_BATCH_SIZE = 1000;

export interface RetentionCleanupResult {
  /** Exports whose object was deleted and which are now stamped. */
  readonly purged: number;
  readonly workspaces: number;
  /** Objects that could not be deleted (retried next run), plus workspaces whose stamping failed. */
  readonly failed: number;
  /** Keys outside their workspace's prefix: nothing deleted, row left. */
  readonly refused: number;
}

const DUE = "status = 'ready' AND object_key IS NOT NULL AND object_purged_at IS NULL AND expires_at < now()";

export async function runRetentionExportCleanup(owner: ClientBase, pool: Pool, store: TenantObjectStore, deps: { readonly batchSize?: number }): Promise<RetentionCleanupResult> {
  const due = await owner.query<{ id: string; workspace_id: string }>(`SELECT id, workspace_id FROM retention_exports WHERE ${DUE} ORDER BY expires_at, id LIMIT $1`, [
    deps.batchSize ?? DEFAULT_RETENTION_CLEANUP_BATCH_SIZE,
  ]);
  const byWorkspace = new Map<string, string[]>();
  for (const row of due.rows) (byWorkspace.get(row.workspace_id) ?? byWorkspace.set(row.workspace_id, []).get(row.workspace_id)!).push(row.id);

  let purged = 0;
  let failed = 0;
  let refused = 0;
  for (const [workspaceId, ids] of byWorkspace) {
    try {
      const outcome = await cleanWorkspace(pool, store, workspaceId, ids);
      purged += outcome.purged;
      failed += outcome.failed;
      refused += outcome.refused;
    } catch (error) {
      failed += 1;
      incrementCounter("nominara_billing_retention_export_cleanup_total", { outcome: "workspace_failed" });
      logger.error({ span: "billing.retention_export.cleanup", workspace_id: workspaceId, outcome: "failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { purged, workspaces: byWorkspace.size, failed, refused };
}

async function inWorkspace<T>(pool: Pool, workspaceId: string, fn: (tx: ClientBase) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);
  } finally {
    client.release();
  }
}

async function cleanWorkspace(pool: Pool, store: TenantObjectStore, workspaceId: string, ids: readonly string[]): Promise<{ purged: number; failed: number; refused: number }> {
  const { rows, bound } = await inWorkspace(pool, workspaceId, async (tx) => {
    const bound = store.bind();
    const found = await tx.query<{ id: string; object_key: string }>(`SELECT id, object_key FROM retention_exports WHERE workspace_id = app.current_workspace() AND id = ANY($1::uuid[]) AND ${DUE}`, [ids]);
    return { rows: found.rows, bound };
  });
  if (rows.length === 0) return { purged: 0, failed: 0, refused: 0 };

  // NO transaction and no connection here.
  const gone: string[] = [];
  let failed = 0;
  let refused = 0;
  for (const row of rows) {
    try {
      await bound.deleteStored("reports", row.object_key);
      gone.push(row.id);
      incrementCounter("nominara_billing_retention_export_cleanup_total", { outcome: "purged" });
    } catch (error) {
      if (error instanceof StorageTenancyError) {
        refused += 1;
        incrementCounter("nominara_billing_retention_export_cleanup_total", { outcome: "refused" });
        // The workspace ID only: never the key, which is the very thing that is wrong.
        logger.error({ span: "billing.retention_export.cleanup", workspace_id: workspaceId, outcome: "refused", error: "StorageTenancyError" });
      } else {
        failed += 1;
        incrementCounter("nominara_billing_retention_export_cleanup_total", { outcome: "delete_failed" });
        logger.error({ span: "billing.retention_export.cleanup", workspace_id: workspaceId, outcome: "delete_failed", error: error instanceof Error ? error.name : "unknown" });
      }
    }
  }
  if (gone.length > 0) {
    await inWorkspace(pool, workspaceId, (tx) =>
      tx.query(`UPDATE retention_exports SET object_purged_at = now(), updated_at = now() WHERE workspace_id = app.current_workspace() AND id = ANY($1::uuid[]) AND object_purged_at IS NULL`, [gone]),
    );
  }
  logger.log({ span: "billing.retention_export.cleanup", workspace_id: workspaceId, purged: gone.length, failed, refused });
  return { purged: gone.length, failed, refused };
}
