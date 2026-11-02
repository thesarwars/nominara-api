import type { ClientBase } from "pg";
import { refundAuxAuditCharge } from "../credits/aux-audit-refund.js";
import { incrementCounter } from "../telemetry/metrics.js";

// AUXLIVE-3 (review round 1, owner decisions 34 and 40) - the one place a manual audit that will never deliver is failed AND its charge returned.
//
// Four callers, one rule: `crawl.audit` when the project is gone, `crawl.audit`'s `recover` hook when the job can no longer be retried, the producer when the
// job never reached the queue (`dispatch_failed`), and the 60-minute reaper (stale-audit-reaper.ts) for a job that never finished at all.
//
// THE REFUND FOLLOWS THE ROW. The update only moves an audit that is still `queued` or `running`, and the charge is returned only when it DID move one
// (rowCount === 1). An audit that already finished - completed or partial, work delivered and paid for - is left exactly as it is, however late a
// redelivery or the reaper arrives. Without that, a completed, charged audit whose project is deleted before a redelivery would be refunded in full for
// work the customer received, and the ledger would disagree with the audit row.
//
// Idempotent: the update matches nothing the second time, and the refund itself carries the debit's own key per bucket (aux-audit-refund.ts).

export type ManualAuditFailure = "project_deleted" | "job_failed" | "stale" | "dispatch_failed";

export interface FailManualAuditInput {
  readonly workspaceId: string;
  readonly auditId: string;
  readonly reason: ManualAuditFailure;
  readonly at: Date;
  /**
   * When set, only an audit created more than this many minutes ago is failed (the reaper's bound, re-checked under the row lock the UPDATE takes). The cutoff is
   * computed IN SQL, on the database clock that stamped `created_at`, never from an application clock that may drift from it.
   */
  readonly olderThanMinutes?: number;
}

/**
 * Must be called inside the audit's tenant transaction. Returns whether THIS call moved the audit to `failed`.
 *
 * The UPDATE carries `workspace_id = app.current_workspace()` itself: row-level security is the guarantee when the connection is the application role, but the
 * reaper's sweep runs on the owner connection, which RLS does not bind. The predicate confines the write to the tenant the transaction was set up for on any
 * connection - an audit id from another workspace matches nothing, and nothing is refunded.
 */
export async function failManualAudit(tx: ClientBase, input: FailManualAuditInput): Promise<boolean> {
  const moved = await tx.query(
    `UPDATE aux_audits
        SET status = 'failed', error_summary = jsonb_build_object('reason', $2::text), finished_at = $3
      WHERE id = $1 AND workspace_id = app.current_workspace() AND trigger = 'manual' AND status IN ('queued', 'running')
        AND ($4::int IS NULL OR created_at < now() - make_interval(mins => $4::int))`,
    [input.auditId, input.reason, input.at, input.olderThanMinutes ?? null],
  );
  if ((moved.rowCount ?? 0) !== 1) return false;
  await refundAuxAuditCharge(tx, { workspaceId: input.workspaceId, auditId: input.auditId, reason: input.reason });
  incrementCounter("nominara_aux_audits_total", { status: "failed", trigger: "manual" });
  return true;
}
