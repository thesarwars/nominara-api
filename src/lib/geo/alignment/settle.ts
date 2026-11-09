import type { ClientBase } from "pg";
import { incrementCounter } from "../../telemetry/metrics.js";
import { ALIGNMENT_JOB } from "./constants.js";

// STORY-192 - the ways a session or a draft is SETTLED when no live job will do it. A step enforces the deadlines only while a job runs; these
// are the paths that do not depend on one, so a row is never `pending` for ever (a lost delayed job, a flushed Valkey, a retry ladder spent on an outage):
//
//   failStrandedSession / failStrandedDraft   the last retry of a job failed: the job's own row is failed with a short reason code
//   settleOverdue                             a read finds a row still pending long past its deadline and fails it, whatever became of its job
//
// Every statement carries the workspace predicate, runs in the caller's tenant transaction, and changes a row only while it is still PENDING:
// a session that finished meanwhile is never overwritten, and a draft is failed only if it is still the save the caller names.

/** Fails the session while it is still pending. Returns whether a row changed. */
export async function failStrandedSession(tx: ClientBase, sessionId: string, reason: string): Promise<boolean> {
  const result = await tx.query(
    `UPDATE geo_alignments SET analysis_state = 'failed', analysis_reason = $2, updated_at = now()
      WHERE id = $1 AND workspace_id = app.current_workspace() AND analysis_state = 'pending'`,
    [sessionId, reason],
  );
  if ((result.rowCount ?? 0) > 0) incrementCounter("nominara_geo_alignment_settled_total", { target: "session", reason });
  return (result.rowCount ?? 0) > 0;
}

/** Fails the draft that was saved with `dueText` (the due time as the column holds it), and no later one. */
export async function failStrandedDraft(tx: ClientBase, sessionId: string, dueText: string): Promise<boolean> {
  const result = await tx.query(
    `UPDATE geo_alignments SET draft_state = 'failed', draft_recompute_due_at = NULL, updated_at = now()
      WHERE id = $1 AND workspace_id = app.current_workspace() AND draft_state = 'pending' AND draft_recompute_due_at::text = $2`,
    [sessionId, dueText],
  );
  if ((result.rowCount ?? 0) > 0) incrementCounter("nominara_geo_alignment_settled_total", { target: "draft", reason: "job_failed" });
  return (result.rowCount ?? 0) > 0;
}

/**
 * Fails a session still pending, or a draft still pending, long past its deadline (plus a grace, so a live chain's own deadline check - which names
 * the same reasons - always gets there first). The database's clock decides. Returns what it failed.
 */
export async function settleOverdue(tx: ClientBase, sessionId: string): Promise<{ session: boolean; draft: boolean }> {
  const graceMs = ALIGNMENT_JOB.settleGraceMs;
  const session = await tx.query(
    `UPDATE geo_alignments
        SET analysis_state = 'failed', analysis_reason = CASE WHEN live_content_md IS NULL THEN 'page_timeout' ELSE 'embedding_timeout' END, updated_at = now()
      WHERE id = $1 AND workspace_id = app.current_workspace() AND analysis_state = 'pending'
        AND created_at < now() - make_interval(secs => ($2::double precision + $3::double precision) / 1000.0)`,
    [sessionId, ALIGNMENT_JOB.sessionDeadlineMs, graceMs],
  );
  const draft = await tx.query(
    `UPDATE geo_alignments SET draft_state = 'failed', draft_recompute_due_at = NULL, updated_at = now()
      WHERE id = $1 AND workspace_id = app.current_workspace() AND draft_state = 'pending'
        AND draft_recompute_due_at < now() - make_interval(secs => ($2::double precision + $3::double precision) / 1000.0)`,
    [sessionId, ALIGNMENT_JOB.draftDeadlineMs, graceMs],
  );
  const result = { session: (session.rowCount ?? 0) > 0, draft: (draft.rowCount ?? 0) > 0 };
  if (result.session) incrementCounter("nominara_geo_alignment_settled_total", { target: "session", reason: "overdue" });
  if (result.draft) incrementCounter("nominara_geo_alignment_settled_total", { target: "draft", reason: "overdue" });
  return result;
}
