import { Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { refreshProjectTaskCounts } from "./refresh-project-task-counts.js";

// STORY-064 AC5 — a dismissed (or snoozed) task returns when its `resurface_at` passes. "Dismissed tasks leave the open count
// but stay audited and reappear after the period" (schemas/tasks-and-goals.md): a task cannot be made to disappear.
//
// WHY A SWEEP, NOT A READ-TIME RULE. A read cannot write the `reopened` event, so a task that "reappears" only in the list would
// have no entry on its timeline for the change and the open count (denormalised on `projects`) would still be wrong.
//
// WHY NOT A ROLLUP STEP. The rollup visits a project on the days it rolls up; a quiet project would never see its tasks return.
// This is a daily, workspace-agnostic tick (`task.resurface`).
//
// TWO CONNECTIONS, as `domain.reverify` and for the same reason. Discovery looks across every tenant, so it reads on the OWNER
// connection (ids only, never a title or a reason). The write does not: it goes through `withTenantContext` on a pooled connection
// as `nominara_app`, so RLS is live and a resurface in workspace A can only ever touch A. The workspace comes from the row just
// read, never from a caller.
//
// IDEMPOTENT under at-least-once delivery: the UPDATE re-checks `status = 'dismissed' AND resurface_at <= now` under the row lock,
// so a task a person reopened in between, or one an earlier run already returned, is simply not touched and writes no event.
// ONE WORKSPACE PER TRANSACTION: a workspace whose apply fails rolls back whole (no task reopened without its event, no count
// refreshed without its task) and is retried by the next run; it does not stop the others (status `partial`).

const logger = new Logger("task.resurface");

/** Bounds one run. Oldest date first, so the remainder is picked up by the next run, never starved. */
export const DEFAULT_RESURFACE_BATCH_SIZE = 1000;

export interface ResurfaceDeps {
  readonly now: () => Date;
  readonly batchSize?: number;
}

export interface ResurfaceResult {
  readonly status: "complete" | "partial";
  readonly reopened: number;
  readonly workspaces: number;
  readonly failed: number;
}

interface Due {
  readonly id: string;
  readonly workspace_id: string;
}

/** Dismissed tasks of live projects whose date has passed, oldest first. IDs only — nothing customer-authored is read across tenants. */
async function dueTasks(owner: ClientBase, now: Date, limit: number): Promise<Due[]> {
  const result = await owner.query<Due>(
    `SELECT t.id, t.workspace_id
       FROM tasks t
       JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
      WHERE t.status = 'dismissed'
        AND t.resurface_at IS NOT NULL
        AND t.resurface_at <= $1
        AND t.deleted_at IS NULL
      ORDER BY t.resurface_at ASC, t.id
      LIMIT $2`,
    [now, limit],
  );
  return result.rows;
}

export async function runTaskResurface(owner: ClientBase, pool: Pool, deps: ResurfaceDeps): Promise<ResurfaceResult> {
  const now = deps.now();
  const due = await dueTasks(owner, now, deps.batchSize ?? DEFAULT_RESURFACE_BATCH_SIZE);

  const byWorkspace = new Map<string, string[]>();
  for (const row of due) {
    const ids = byWorkspace.get(row.workspace_id);
    if (ids === undefined) byWorkspace.set(row.workspace_id, [row.id]);
    else ids.push(row.id);
  }

  let reopened = 0;
  let failed = 0;
  for (const [workspaceId, ids] of byWorkspace) {
    try {
      reopened += await resurfaceInWorkspace(pool, workspaceId, ids, now);
    } catch (error) {
      failed += 1;
      incrementCounter("nominara_tasks_resurface_failures_total");
      // IDs and the error class only — never a title or a dismissal reason.
      logger.error({ event: "task.resurface.apply_failed", workspace_id: workspaceId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { status: failed === 0 ? "complete" : "partial", reopened, workspaces: byWorkspace.size, failed };
}

/** Reopens `ids` in the workspace's own tenant context. Returns how many were still due and were reopened. */
async function resurfaceInWorkspace(pool: Pool, workspaceId: string, ids: readonly string[], now: Date): Promise<number> {
  const client = await pool.connect();
  try {
    return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      // RLS scopes this; no workspace predicate. SKIP LOCKED: a task a person is editing right now is left for the next run.
      const reopened = await tx.query<{ id: string; project_id: string }>(
        `UPDATE tasks
            SET status = 'todo', dismissed_reason = NULL, resurface_at = NULL
          WHERE id IN (
                  SELECT id FROM tasks
                   WHERE id = ANY($1::uuid[]) AND status = 'dismissed' AND resurface_at <= $2 AND deleted_at IS NULL
                     AND EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id AND p.deleted_at IS NULL)
                   ORDER BY id
                   FOR UPDATE SKIP LOCKED)
        RETURNING id, project_id`,
        [ids, now],
      );
      if (reopened.rows.length === 0) return 0;
      await tx.query(
        `INSERT INTO task_events (workspace_id, task_id, actor_id, actor_type, event, from_value, to_value, payload, occurred_at)
         SELECT app.current_workspace(), t, NULL, 'system', 'reopened', 'dismissed', 'todo', '{"resurfaced": true}'::jsonb, clock_timestamp()
           FROM unnest($1::uuid[]) AS t`,
        [reopened.rows.map((r) => r.id)],
      );
      for (const projectId of new Set(reopened.rows.map((r) => r.project_id)).values()) {
        await refreshProjectTaskCounts(tx, projectId);
      }
      return reopened.rows.length;
    });
  } finally {
    client.release();
  }
}
