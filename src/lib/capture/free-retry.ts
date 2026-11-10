import type { ClientBase } from "pg";
import { ConflictError } from "../../api/errors/domain-errors.js";
import type { Cache } from "../cache/cache.port.js";
import { cacheKeyNamespace } from "../cache/key-namespace.js";
import { resolveEntitlements } from "../entitlements/resolution.js";
import { NORMALIZER_VERSION } from "../parser/normalize.js";
import { resolveBillingPeriod } from "../usage/billing-period.js";
import { MANUAL_CAPTURE_MODE, noCapturableScopeError, scopeIsCapturable, sharedCacheEnabled, type ManualRunProject } from "./manual-run.js";
import { planRun, type PlannedRun } from "./plan-run.js";

// STORY-195 AC4 — the FREE RETRY of an all-degraded first run.
//
//   WHICH RUN. The project's FIRST run, and only while it ended `failed` (resolveRunOutcome: zero cells delivered, i.e. every engine
//   degraded or blocked). A `partial` run delivered something and is charged in full as the deep-scan rule says; a `completed` one has
//   nothing to retry. A run that has since been followed by another run is not "the first run's outcome" any more, so it is refused too.
//
//   ONCE. `capture_runs.retry_of` carries a partial unique index (migration 0195), so a run is retried at most once and two concurrent
//   requests cannot both start one. The first run's row is locked FOR UPDATE for the check, and the index is the backstop.
//
//   FREE. The run carries `trigger = 'scheduled'` ("inside the subscription", fair-use.ts): `commitDeepScanCharge` and the refund sweeps
//   only ever act on `manual`, and nothing here reserves or debits a credit. It still takes fair-use capacity for its live cells, like any
//   run, so an exhausted ceiling refuses it with `quota_exceeded` and nothing is charged either way.
//
//   NOTHING HERE ENQUEUES. Like `planManualRun`, it runs inside the request's tenant transaction and the caller dispatches after commit.

interface RunRow {
  id: string;
  status: string;
}

export async function planFreeRetry(
  tx: ClientBase,
  cache: Cache,
  project: ManualRunProject,
  options: {
    readonly runId: string;
    readonly triggeredBy: string | null;
    readonly now: Date;
    /** ⚠ A TEST SEAM, never set in production: see `planManualRun`. */
    readonly captureReadyEngineKeys?: readonly string[];
  },
): Promise<{ readonly plan: PlannedRun; readonly retryOf: string }> {
  const first = (
    await tx.query<RunRow>(
      `SELECT id, status FROM capture_runs
        WHERE project_id = $1 AND workspace_id = app.current_workspace()
        ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
      [project.projectId],
    )
  ).rows[0];
  if (first === undefined) throw refusal("no_first_run", "this project has no first run to retry");

  const used = await tx.query("SELECT 1 FROM capture_runs WHERE retry_of = $1 AND workspace_id = app.current_workspace()", [first.id]);
  if ((used.rowCount ?? 0) > 0) throw refusal("retry_already_used", "the free retry of this project's first run has already been used");
  if (first.status === "queued" || first.status === "running") throw refusal("run_in_progress", "this project's first run has not finished");
  if (first.status !== "failed") throw refusal("not_all_degraded", "this project's first run did not end with every engine degraded");

  const later = await tx.query("SELECT 1 FROM capture_runs WHERE project_id = $1 AND workspace_id = app.current_workspace() AND id <> $2 LIMIT 1", [project.projectId, first.id]);
  if ((later.rowCount ?? 0) > 0) throw refusal("run_since_first_run", "this project has run since its first run");

  const resolved = await resolveEntitlements(tx, project.workspaceId);
  try {
    await tx.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, triggered_by, engine_keys, prompt_scope, status, retry_of)
       VALUES ($1, $2, $3, 'scheduled', $4, ARRAY[]::text[], 'all', 'queued', $5)`,
      [options.runId, project.workspaceId, project.projectId, options.triggeredBy, first.id],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw refusal("retry_already_used", "the free retry of this project's first run has already been used");
    throw error;
  }

  const plan = await planRun(tx, cache, {
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    runId: options.runId,
    trigger: "scheduled",
    cadence: project.cadence,
    planKey: project.planKey,
    scope: "all",
    periodStart: (await resolveBillingPeriod(tx, project.workspaceId, options.now)).start,
    locale: project.locale,
    personaHint: null,
    normalizerVersion: NORMALIZER_VERSION,
    captureMode: MANUAL_CAPTURE_MODE,
    env: cacheKeyNamespace(),
    sharedCacheEnabled: sharedCacheEnabled(resolved.entitlements),
    nowMs: options.now.getTime(),
    ...(options.captureReadyEngineKeys === undefined ? {} : { captureReadyEngineKeys: options.captureReadyEngineKeys }),
  });
  if (!scopeIsCapturable(plan.planned)) throw noCapturableScopeError();
  return { plan, retryOf: first.id };
}

function refusal(reason: "not_all_degraded" | "run_in_progress" | "retry_already_used" | "no_first_run" | "run_since_first_run", message: string): InstanceType<typeof ConflictError> {
  return new ConflictError({ message, details: { reason } });
}
