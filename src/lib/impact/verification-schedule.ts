import type { ClientBase } from "pg";
import {
  DEFAULT_VERIFICATION_LONG_DAYS,
  DEFAULT_VERIFICATION_SHORT_HOURS,
  type TaskVerificationCancelReason,
} from "../../../contracts/tasks/task-verification.schema.js";
import { CAPTURABLE_WORKSPACE_STATUSES } from "../capture/scheduler.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-067 - the verification schedule: WHEN a completed task is re-measured, and when that is called off.
//
// Completing a task writes one `task_verifications` row per horizon. `due_at` is fixed at scheduling, so changing the horizons
// later moves no pending row. A row is cancelled, never deleted: "why did this task report no impact" has an answer.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface VerificationHorizons {
  readonly shortMs: number;
  readonly longMs: number;
}

/**
 * AC12 - the horizons, configurable and DEFAULTING to the documented +48 h / +14 d. An unset variable is the default; one that is set
 * and not a positive whole number, or a long horizon that is not after the short one, THROWS rather than quietly scheduling at a
 * neighbour (fail closed: a typo must not silently change when customers are told they will be re-measured).
 */
export function verificationHorizons(env: Readonly<Record<string, string | undefined>> = process.env): VerificationHorizons {
  const whole = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number`);
    return value;
  };
  const shortMs = whole("TASK_VERIFICATION_SHORT_HOURS", DEFAULT_VERIFICATION_SHORT_HOURS) * HOUR_MS;
  const longMs = whole("TASK_VERIFICATION_LONG_DAYS", DEFAULT_VERIFICATION_LONG_DAYS) * DAY_MS;
  if (longMs <= shortMs) throw new Error("TASK_VERIFICATION_LONG_DAYS must be later than TASK_VERIFICATION_SHORT_HOURS");
  return { shortMs, longMs };
}

/**
 * Schedules both horizons for a completed task, inside the completion's own transaction (the ambient tenant one), so a completion
 * and its schedule commit or roll back together. Idempotent on (milestone, horizon). The cluster is the task's AT SCHEDULING.
 */
export async function scheduleTaskVerifications(
  tx: ClientBase,
  input: { readonly taskId: string; readonly milestoneId: string; readonly completedAt: Date },
  horizons: VerificationHorizons = verificationHorizons(),
): Promise<{ readonly at_48h: string; readonly at_14d: string }> {
  const short = new Date(input.completedAt.getTime() + horizons.shortMs);
  const long = new Date(input.completedAt.getTime() + horizons.longMs);
  await tx.query(
    `INSERT INTO task_verifications (workspace_id, project_id, task_id, milestone_id, horizon, due_at, prompt_cluster_id)
     SELECT app.current_workspace(), t.project_id, t.id, $2, h.horizon, h.due_at, t.prompt_cluster_id
       FROM tasks t, (VALUES ('short', $3::timestamptz), ('long', $4::timestamptz)) AS h(horizon, due_at)
      WHERE t.id = $1 AND t.workspace_id = app.current_workspace()
     ON CONFLICT (milestone_id, horizon) DO NOTHING`,
    [input.taskId, input.milestoneId, short, long],
  );
  incrementCounter("nominara_tasks_verifications_scheduled_total", {});
  return { at_48h: short.toISOString(), at_14d: long.toISOString() };
}

/**
 * Cancels what is still pending or running, for one task (a reopen, a delete) or one project (a pause, a delete). Runs in the
 * caller's tenant transaction. Returns how many rows it cancelled.
 */
export async function cancelTaskVerifications(
  tx: ClientBase,
  target: { readonly taskId: string } | { readonly projectId: string },
  reason: TaskVerificationCancelReason,
): Promise<number> {
  const byTask = "taskId" in target;
  const result = await tx.query(
    `UPDATE task_verifications
        SET status = 'canceled', cancel_reason = $2, settled_at = now()
      WHERE workspace_id = app.current_workspace()
        AND status IN ('pending', 'running')
        AND ${byTask ? "task_id" : "project_id"} = $1`,
    [byTask ? target.taskId : target.projectId, reason],
  );
  const cancelled = result.rowCount ?? 0;
  if (cancelled > 0) incrementCounter("nominara_tasks_verifications_cancelled_total", { reason });
  return cancelled;
}

export interface DueVerificationRef {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly dueAt: Date;
}

/**
 * The sweep's owner-connection read: ids of verifications whose time has come. No tenant content.
 *
 * ONLY WORKSPACES THAT CAN CAPTURE (the scheduler's own allow-list). A due row in a past_due, canceled or suspended workspace is
 * neither measured nor cancelled - it waits for the workspace to recover - so it must not sit at the head of the oldest-first list
 * and fill the batch: that would stop every other tenant's verification, platform-wide and silently.
 */
export async function findDueVerifications(client: ClientBase, now: Date, limit = 200): Promise<DueVerificationRef[]> {
  const result = await client.query<{ id: string; workspace_id: string; project_id: string; due_at: Date }>(
    `SELECT v.id, v.workspace_id, v.project_id, v.due_at FROM task_verifications v
       JOIN workspaces w ON w.id = v.workspace_id
      WHERE v.status = 'pending' AND v.due_at <= $1 AND w.status = ANY($3::text[])
      ORDER BY v.due_at, v.id LIMIT $2`,
    [now, limit, [...CAPTURABLE_WORKSPACE_STATUSES]],
  );
  return result.rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, dueAt: r.due_at }));
}
