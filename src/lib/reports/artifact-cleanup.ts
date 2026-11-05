import { Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import type { BoundObjectStore, TenantObjectStore } from "../storage/tenant-object-store.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { StorageTenancyError } from "../storage/storage-keys.js";
import { isStoredObjectKey } from "./artifact-key.js";

// STORY-180 r5 (owner decision 60 (b)) - the nightly cleanup of stored report files. Run by the `report.cleanup` queue.
//
// WHAT IS DELETED
//   1. the object of every artifact whose link has expired (`expires_at` is in the past: the 7-day life of an on-screen export and of
//      an emailed link are the same column), and
//   2. the object of every artifact whose upload never completed: a `pending:` or `failed:` row older than STALE_UPLOAD_MS.
// The row stays (its figures and footer are the record that a report was built); its `object_key` becomes `purged:<id>`.
//
// STALE_UPLOAD_MS = 24 hours. A live upload ends within a minute or so (S3 requests time out at 20 s, three attempts) and a failed one
// is marked `failed:` at once, so a row still `pending:` a day later was left by a crash or an outage. A day is also longer than a
// cadence job's whole retry ladder, so a delivery that is still retrying never has its artifact taken from under it. (A sweep with a
// shorter cutoff would race the retry; a longer one only holds a few orphan bytes for longer.)
//
// THE ORDER IS THE POINT (ADR-0003, and idempotency under a crash): OBJECT FIRST, then the row. Never storage I/O inside a transaction.
//   discovery   owner connection: ids and workspace ids only (cross-tenant, like task.resurface)
//   per workspace, in that workspace's own tenant context as the runtime role:
//     phase 1   ONE short transaction: re-read the due rows (RLS plus `workspace_id = app.current_workspace()`), bind the object store
//     phase 2   NO transaction, no connection: delete each object (a delete of an absent object succeeds)
//     phase 3   ONE short transaction: mark the rows whose object is gone `purged:<id>`
//
// A TENANCY REFUSAL (StorageTenancyError: the row's key is outside the workspace prefix) is quarantined, not retried: `refused:<id>`.
// A crash between phases 2 and 3 leaves a row that is still due: the next run deletes again (harmless) and marks it. An object that
// cannot be deleted leaves its row unmarked, so it is retried the next night, counted and logged.
//
// VERSIONED BUCKETS: a delete on a versioned bucket adds a delete marker; the bytes of earlier versions remain until the bucket's
// noncurrent-version expiry rule removes them (infra, STORY-003). The workspace-erasure path deletes every version (deletePrefix).

const logger = new Logger("reports.cleanup");

export const STALE_UPLOAD_MS = 24 * 3_600_000;
/** Bounds one run; oldest first, so the remainder is picked up by the next run, never starved. */
export const DEFAULT_CLEANUP_BATCH_SIZE = 1000;

export interface CleanupDeps {
  readonly batchSize?: number;
}

export interface CleanupResult {
  readonly status: "complete" | "partial";
  /** Rows whose object was deleted and which are now marked purged. */
  readonly purged: number;
  readonly workspaces: number;
  /** Objects that could not be deleted, plus workspaces whose marking failed. */
  readonly failed: number;
  /** Rows quarantined as `refused:` (a stored key outside the workspace prefix). Not failures: they are permanent and are not retried. */
  readonly refused: number;
}

interface Due {
  readonly id: string;
  readonly workspace_id: string;
}

interface DueRow {
  readonly id: string;
  readonly format: string;
  readonly object_key: string;
}

// The one definition of "due", shared by discovery, the in-workspace re-read and the mark. $1 = the stale cutoff in seconds. "Now" is the
// DATABASE clock (`now()`), the same clock that stamped `expires_at` and `created_at`, so a worker host's skewed clock cannot purge a live
// link early or hold an expired one. A `refused:` row is quarantined and never due again.
const DUE = `object_key !~ '^(purged|refused):' AND (expires_at < now() OR (object_key ~ '^(pending|failed):' AND created_at < now() - make_interval(secs => $1)))`;
const STALE_SECONDS = STALE_UPLOAD_MS / 1000;

export async function runReportArtifactCleanup(owner: ClientBase, pool: Pool, store: TenantObjectStore, deps: CleanupDeps): Promise<CleanupResult> {
  const due = await owner.query<Due>(
    `SELECT id, workspace_id FROM report_artifacts WHERE ${DUE} ORDER BY created_at, id LIMIT $2`,
    [STALE_SECONDS, deps.batchSize ?? DEFAULT_CLEANUP_BATCH_SIZE],
  );

  const byWorkspace = new Map<string, string[]>();
  for (const row of due.rows) {
    const ids = byWorkspace.get(row.workspace_id);
    if (ids === undefined) byWorkspace.set(row.workspace_id, [row.id]);
    else ids.push(row.id);
  }

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
      incrementCounter("nominara_reports_cleanup_objects_total", { outcome: "workspace_failed" });
      // The workspace ID and the error class only.
      logger.error({ span: "reports.cleanup.workspace", workspace_id: workspaceId, outcome: "failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { status: failed === 0 ? "complete" : "partial", purged, workspaces: byWorkspace.size, failed, refused };
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
  // Phase 1 - what is still due in THIS workspace, and the store bound to it. No I/O beyond the read.
  const { rows, bound } = await inWorkspace(pool, workspaceId, async (tx) => {
    const bound = store.bind();
    const found = await tx.query<DueRow>(
      `SELECT id, format, object_key FROM report_artifacts WHERE workspace_id = app.current_workspace() AND id = ANY($2::uuid[]) AND ${DUE}`,
      [STALE_SECONDS, ids],
    );
    return { rows: found.rows, bound };
  });
  if (rows.length === 0) return { purged: 0, failed: 0, refused: 0 };

  // Phase 2 - NO transaction, no connection: the objects.
  const gone: string[] = [];
  const refusedIds: string[] = [];
  let failed = 0;
  for (const row of rows) {
    const outcome = await deleteObject(bound, row, workspaceId);
    if (outcome === "deleted") gone.push(row.id);
    else if (outcome === "refused") refusedIds.push(row.id);
    else failed += 1;
  }
  if (gone.length === 0 && refusedIds.length === 0) return { purged: 0, failed, refused: 0 };

  // Phase 3 - mark exactly the rows whose object is gone. Re-checking DUE keeps a row that became live in between.
  // A tenancy refusal is permanent (the key will never lie inside the prefix), so the row is QUARANTINED in the same short transaction: it
  // would otherwise fail the job every night and, being oldest first, eventually fill the batch and starve every legitimate row behind it.
  await inWorkspace(pool, workspaceId, async (tx) => {
    if (gone.length > 0) await tx.query(`UPDATE report_artifacts SET object_key = 'purged:' || id::text WHERE workspace_id = app.current_workspace() AND id = ANY($2::uuid[]) AND ${DUE}`, [STALE_SECONDS, gone]);
    if (refusedIds.length > 0) await tx.query(`UPDATE report_artifacts SET object_key = 'refused:' || id::text WHERE workspace_id = app.current_workspace() AND id = ANY($2::uuid[]) AND ${DUE}`, [STALE_SECONDS, refusedIds]);
  });
  for (let i = 0; i < gone.length; i += 1) incrementCounter("nominara_reports_cleanup_objects_total", { outcome: "purged" });
  for (let i = 0; i < refusedIds.length; i += 1) incrementCounter("nominara_reports_cleanup_objects_total", { outcome: "refused" });
  // The workspace ID and counts: no key, no artifact id.
  logger.log({ span: "reports.cleanup.workspace", workspace_id: workspaceId, purged: gone.length, failed, refused: refusedIds.length });
  return { purged: gone.length, failed, refused: refusedIds.length };
}

/** A stored key is deleted by the key the row holds (refused if it lies outside the workspace prefix); a marker by the deterministic `{id}.{format}`. */
async function deleteObject(bound: BoundObjectStore, row: DueRow, workspaceId: string): Promise<"deleted" | "refused" | "failed"> {
  try {
    if (isStoredObjectKey(row.object_key)) await bound.deleteStored("reports", row.object_key);
    else await bound.delete("reports", `${row.id}.${row.format}`);
    return "deleted";
  } catch (error) {
    if (error instanceof StorageTenancyError) {
      // A security event, not an outage: the row's key lies outside this workspace's prefix. Nothing was deleted. The row is quarantined by the
      // caller; this is logged at error level (alertable) with the workspace ID only - never the key, which is the very thing that is wrong.
      logger.error({ span: "reports.cleanup.delete", workspace_id: workspaceId, outcome: "refused", error: "StorageTenancyError" });
      return "refused";
    }
    incrementCounter("nominara_reports_cleanup_objects_total", { outcome: "delete_failed" });
    // Never the key or the artifact id: the workspace ID and the error class.
    logger.error({ span: "reports.cleanup.delete", workspace_id: workspaceId, outcome: "delete_failed", error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}
