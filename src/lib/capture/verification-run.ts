import type { ClientBase } from "pg";
import type { Cache } from "../cache/cache.port.js";
import type { TaskVerificationCancelReason } from "../../../contracts/tasks/task-verification.schema.js";
import { CAPTURABLE_WORKSPACE_STATUSES, type DueProject, type ScheduleContext, type ScheduledRun } from "./scheduler.js";
import { planRun } from "./plan-run.js";
import { resolveRunCells } from "./probe-run.js";

// STORY-067 - a VERIFICATION run: the re-measurement of one completed task, planned by `capture.plan` from a `task_verifications` row.
//
//   OWN TRIGGER, CHARGED NOTHING (AC2). The run row carries `trigger = 'verification'`; `planRun` charges only `manual` (fair-use.ts,
//   CHARGED_TRIGGERS), so no ledger line and no fair-use reservation beyond the live cells every run takes. Charging a customer to
//   measure our own advice would be indefensible.
//
//   SCOPED TO THE AFFECTED CLUSTER (AC3). `prompt_scope = 'cluster'` and the task's cluster id: only that cluster's active prompts
//   are planned. A task with no cluster captures NOTHING - never "fall back to the whole project", which is the expensive event this
//   scope exists to avoid.
//
//   IT DOES NOT TOUCH THE SCHEDULE. A verification is not a scheduled run: `next_run_at` and `last_run_at` stay as they were.
//
//   RE-DERIVED, NEVER TRUSTED. The job names a verification id and nothing else; the cluster, the engines and the project's state
//   are read here, inside the job's tenant context.

export type VerificationPlanOutcome =
  | { readonly kind: "planned"; readonly scheduled: ScheduledRun; readonly periodStart: string }
  | { readonly kind: "no_capture" }
  | { readonly kind: "canceled"; readonly reason: TaskVerificationCancelReason }
  | { readonly kind: "skipped" };

interface VerificationState {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly horizon: string;
  readonly prompt_cluster_id: string | null;
  readonly project_status: string | null;
  readonly project_deleted: boolean;
  readonly task_status: string | null;
  readonly task_deleted: boolean;
  readonly cadence: string | null;
  readonly priority_prompt_limit: number | null;
  readonly locale: string | null;
  readonly plan_key: string | null;
  readonly workspace_status: string | null;
}

/** Why a verification must not run any more, or null: the world has changed since it was scheduled (AC9, AC10). */
export function cancelReasonFor(state: Pick<VerificationState, "project_status" | "project_deleted" | "task_status" | "task_deleted">): TaskVerificationCancelReason | null {
  if (state.project_deleted || state.project_status === null) return "project_deleted";
  if (state.project_status !== "active") return "project_paused";
  if (state.task_deleted || state.task_status === null) return "task_deleted";
  if (state.task_status !== "done") return "task_reopened";
  return null;
}

export async function planVerificationRun(
  tx: ClientBase,
  cache: Cache,
  input: { readonly verificationId: string; readonly workspaceId: string; readonly runId: string; readonly now: Date },
  context: Omit<ScheduleContext, "periodStart"> & { readonly periodStart: string },
): Promise<VerificationPlanOutcome> {
  const found = await tx.query<VerificationState>(
    `SELECT v.id, v.workspace_id, v.project_id, v.task_id, v.horizon, v.prompt_cluster_id,
            p.status AS project_status, (p.deleted_at IS NOT NULL) AS project_deleted,
            t.status AS task_status, (t.deleted_at IS NOT NULL) AS task_deleted,
            p.cadence, p.priority_prompt_limit, p.locale, w.plan_key, w.status AS workspace_status
       FROM task_verifications v
       LEFT JOIN projects p ON p.id = v.project_id
       LEFT JOIN tasks t ON t.id = v.task_id
       LEFT JOIN workspaces w ON w.id = v.workspace_id
      WHERE v.id = $1 AND v.status = 'pending' AND v.due_at <= $2
        FOR UPDATE OF v`,
    [input.verificationId, input.now],
  );
  const state = found.rows[0];
  // Absent, another tenant's (RLS hides it), or already past 'pending': an earlier delivery did it. Not an error, not a retry.
  if (state === undefined || state.workspace_id !== input.workspaceId) return { kind: "skipped" };

  // A workspace that is not capturable (suspended, soft-capped) is not measured, and not cancelled: it is simply not time yet.
  if (state.workspace_status === null || !CAPTURABLE_WORKSPACE_STATUSES.includes(state.workspace_status)) return { kind: "skipped" };

  const reason = cancelReasonFor(state);
  if (reason !== null) {
    await tx.query(
      "UPDATE task_verifications SET status = 'canceled', cancel_reason = $2, settled_at = $3 WHERE id = $1",
      [state.id, reason, input.now],
    );
    return { kind: "canceled", reason };
  }

  const project: DueProject = {
    projectId: state.project_id,
    workspaceId: state.workspace_id,
    cadence: state.cadence as DueProject["cadence"],
    priorityPromptLimit: state.priority_prompt_limit ?? 0,
    nextRunAt: input.now,
    planKey: state.plan_key ?? "",
    locale: state.locale ?? "en",
  };

  // Nothing to capture: no cluster, no entitled capture-ready engine, or no active prompt in the cluster. A short horizon is then
  // settled at once; a long one is left `running` with no run, so the sweep still computes its impact from the rollups.
  const scope = { projectId: state.project_id, scope: "cluster" as const, ...(state.prompt_cluster_id === null ? {} : { clusterId: state.prompt_cluster_id }), ...(context.captureReadyEngineKeys === undefined ? {} : { captureReadyEngineKeys: context.captureReadyEngineKeys }) };
  const { engines, cells } = state.prompt_cluster_id === null ? { engines: [], cells: [] } : await resolveRunCells(tx, scope);
  if (cells.length === 0) {
    await tx.query(
      state.horizon === "short"
        ? "UPDATE task_verifications SET status = 'done', outcome = 'no_capture', settled_at = $2 WHERE id = $1"
        : "UPDATE task_verifications SET status = 'running' WHERE id = $1",
      [state.id, input.now],
    );
    return { kind: "no_capture" };
  }

  const engineKeys = engines.map((engine) => engine.engineKey);
  await tx.query(
    `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, prompt_scope, status)
     VALUES ($1, $2, $3, 'verification', $4::text[], 'cluster', 'queued')`,
    [input.runId, state.workspace_id, state.project_id, engineKeys],
  );
  const plan = await planRun(tx, cache, {
    workspaceId: state.workspace_id,
    projectId: state.project_id,
    runId: input.runId,
    trigger: "verification",
    cadence: project.cadence,
    planKey: project.planKey,
    scope: "cluster",
    clusterId: state.prompt_cluster_id!,
    engineKeys,
    periodStart: context.periodStart,
    locale: project.locale,
    personaHint: context.personaHint ?? null,
    normalizerVersion: context.normalizerVersion,
    captureMode: context.captureMode,
    env: context.env,
    sharedCacheEnabled: context.sharedCacheEnabled,
    nowMs: input.now.getTime(),
    ...(context.captureReadyEngineKeys === undefined ? {} : { captureReadyEngineKeys: context.captureReadyEngineKeys }),
  });
  await tx.query("UPDATE task_verifications SET status = 'running', run_id = $2 WHERE id = $1", [state.id, input.runId]);
  return {
    kind: "planned",
    periodStart: context.periodStart,
    scheduled: { projectId: state.project_id, runId: input.runId, trigger: "verification", engineKeys, plan },
  };
}
