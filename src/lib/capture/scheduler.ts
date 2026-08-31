import type { ClientBase } from "pg";

// STORY-033 — tracking-engine.md §5's scheduler: which projects are due, in
// what order, and how two replicas run the same tick without colliding.
//
// THREE PROPERTIES, AND EACH FAILS DIFFERENTLY.
//
//   Fairness. Ordered by next_run_at ASC, so the longest-waiting tenant is
//   served first. Ordering by id or created_at means the SAME tenants are
//   always served last under backlog, and their data is always the stalest —
//   a bias that compounds daily and is invisible in any single tick.
//
//   Safety under replicas. FOR UPDATE SKIP LOCKED, so a second scheduler
//   steps over rows the first holds instead of blocking on them. Without it
//   two replicas need a leader election, or they serialise and the tick takes
//   twice as long for no benefit.
//
//   Crash safety. next_run_at is advanced BEFORE the enqueue and inside the
//   SAME transaction. The reverse order leaves a window where a crash
//   re-selects the same project and schedules it twice; the job's idempotency
//   key would swallow most of the duplicate work, but the capture_runs row
//   itself would double, and a duplicated run row is a duplicated bill line
//   and a broken freshness figure.

/** §5's own LIMIT. A backlog drains steadily rather than in one spike that lands on the vendors all at once. */
export const SCHEDULER_BATCH_SIZE = 500;

/**
 * §5: "w.status IN ('trialing','active') — soft_capped and suspended are
 * skipped".
 *
 * Named as an ALLOW-list rather than a deny-list of the other five. A new
 * workspace status added by a later story defaults to NOT being captured,
 * which is the safe direction: capturing a workspace that should not be
 * captured spends money on someone who is not paying, and the alternative
 * mistake — missing one that should be — is visible as stale data.
 */
export const CAPTURABLE_WORKSPACE_STATUSES: readonly string[] = ["trialing", "active"];

export interface DueProject {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly cadence: string;
  readonly priorityPromptLimit: number;
  readonly nextRunAt: Date;
}

/**
 * Claims up to `limit` due projects for THIS tick, inside the caller's
 * transaction.
 *
 * The caller must hold a transaction open: the row locks live until it
 * commits, and that is what stops a second replica claiming the same project.
 * A caller that ran this outside one would take locks and drop them
 * immediately, and the skip-locked guarantee would silently evaporate.
 */
export async function claimDueProjects(
  tx: ClientBase,
  now: Date,
  limit: number = SCHEDULER_BATCH_SIZE,
): Promise<DueProject[]> {
  const result = await tx.query<{
    id: string;
    workspace_id: string;
    cadence: string;
    priority_prompt_limit: number;
    next_run_at: Date;
  }>(
    `
    SELECT p.id, p.workspace_id, p.cadence, p.priority_prompt_limit, p.next_run_at
      FROM projects p
      JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.status = 'active'
       AND p.deleted_at IS NULL
       AND p.next_run_at IS NOT NULL
       AND p.next_run_at <= $1
       AND w.status = ANY($2::text[])
       AND w.deleted_at IS NULL
     ORDER BY p.next_run_at ASC
     LIMIT $3
       FOR UPDATE OF p SKIP LOCKED
    `,
    [now, [...CAPTURABLE_WORKSPACE_STATUSES], limit],
  );

  return result.rows.map((row) => ({
    projectId: row.id,
    workspaceId: row.workspace_id,
    cadence: row.cadence,
    priorityPromptLimit: row.priority_prompt_limit,
    nextRunAt: row.next_run_at,
  }));
}

/**
 * Advances `next_run_at`, and returns whether it actually moved.
 *
 * CALLED BEFORE THE ENQUEUE, in the same transaction — see this file's
 * header. The `next_run_at = $2` guard makes it a compare-and-set: if another
 * transaction advanced this project since it was claimed, this updates
 * nothing and returns false, and the caller must not enqueue. Without the
 * guard a lock lost to a timeout, or a claim replayed after a rollback, would
 * schedule a second identical run.
 */
export async function advanceNextRun(
  tx: ClientBase,
  project: DueProject,
  nextRunAt: Date,
  ranAt: Date,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE projects
        SET next_run_at = $3, last_run_at = $4
      WHERE id = $1
        AND next_run_at = $2`,
    [project.projectId, project.nextRunAt, nextRunAt, ranAt],
  );
  return (result.rowCount ?? 0) === 1;
}
