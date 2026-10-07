import type { Job, Queue } from "bullmq";
import type { ClientBase } from "pg";
import type { Cache } from "../cache/cache.port.js";
import type { QueueTopologyEntry } from "../queue/topology.js";
import type { ProjectCadence } from "./dispatch-cells.js";
import { resolveDueEngines, scopeForKind, CYCLE_DAYS, type RunKind } from "./engine-cadence.js";
import type { RunTrigger } from "./fair-use.js";
import type { PriorityVariant } from "../queue/queue-factory.js";
import { dispatchPlannedRun, planRun, type PlannedRun } from "./plan-run.js";

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
  readonly cadence: ProjectCadence;
  readonly priorityPromptLimit: number;
  readonly nextRunAt: Date;
  /** The workspace's plan — `cadence_by_plan` is keyed by it. */
  readonly planKey: string;
  /** The project's locale, which the L1 key is partitioned by. */
  readonly locale: string;
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
    cadence: ProjectCadence;
    priority_prompt_limit: number;
    next_run_at: Date;
    locale: string;
    plan_key: string;
  }>(
    `
    SELECT p.id, p.workspace_id, p.cadence, p.priority_prompt_limit, p.next_run_at,
           p.locale, w.plan_key
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
    planKey: row.plan_key,
    locale: row.locale,
  }));
}

/**
 * NEW-A-10 — claims ONE project by id, if it is due, inside the caller's
 * transaction. The per-project form of `claimDueProjects`: the same
 * conditions (an allow-listed workspace status, an active undeleted project,
 * `next_run_at` set and past), so a `capture.plan` job and the sweep can never
 * disagree about what "due" means.
 *
 * Returns null when the project is not due, is paused or deleted, belongs to a
 * workspace that is not capturable — or is simply invisible to the job's
 * tenant context, which RLS makes indistinguishable from absent on purpose.
 *
 * `FOR UPDATE` (no SKIP LOCKED): a duplicate delivery of the same job must
 * WAIT for the first, then re-check `next_run_at` against the advanced value
 * and find nothing due. Skipping the locked row instead would let the second
 * delivery report "not due" while the first was still mid-plan, which is
 * correct but would hide a genuine race behind a benign-looking outcome.
 */
export async function claimDueProject(tx: ClientBase, projectId: string, now: Date): Promise<DueProject | null> {
  const result = await tx.query<{
    id: string;
    workspace_id: string;
    cadence: ProjectCadence;
    priority_prompt_limit: number;
    next_run_at: Date;
    locale: string;
    plan_key: string;
  }>(
    `
    SELECT p.id, p.workspace_id, p.cadence, p.priority_prompt_limit, p.next_run_at,
           p.locale, w.plan_key
      FROM projects p
      JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.id = $1
       AND p.status = 'active'
       AND p.deleted_at IS NULL
       AND p.next_run_at IS NOT NULL
       AND p.next_run_at <= $2
       AND w.status = ANY($3::text[])
       AND w.deleted_at IS NULL
       FOR UPDATE OF p
    `,
    [projectId, now, [...CAPTURABLE_WORKSPACE_STATUSES]],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    projectId: row.id,
    workspaceId: row.workspace_id,
    cadence: row.cadence,
    priorityPromptLimit: row.priority_prompt_limit,
    nextRunAt: row.next_run_at,
    planKey: row.plan_key,
    locale: row.locale,
  };
}

/**
 * Advances `next_run_at`, and returns whether it actually moved.
 *
 * CALLED BEFORE THE ENQUEUE, in the same transaction — see this file's
 * header. The `next_run_at <= ranAt` guard makes it a compare-and-set: if
 * another transaction advanced this project since it was claimed, its
 * `next_run_at` is in the future, this updates nothing and returns false, and
 * the caller must not enqueue. Without the guard a lock lost to a timeout, or
 * a claim replayed after a rollback, would schedule a second identical run.
 *
 * THE GUARD IS "STILL DUE", NOT `next_run_at = <the claimed Date>`. A claim
 * reads `next_run_at` back as a JS Date, which holds milliseconds; a value
 * written by SQL (`now()`, an ops backfill) has microseconds and never equals
 * it. Equality would then lose EVERY advance for that project after the run
 * row was written, and the project would never be planned again. `ranAt` is the
 * same instant the claim tested `next_run_at <= now` against, so the predicate
 * is exactly the claim's own, re-asserted under the row lock.
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
        AND next_run_at IS NOT NULL
        AND next_run_at <= $2`,
    [project.projectId, ranAt, nextRunAt, ranAt],
  );
  return (result.rowCount ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// The tick — AC5, AC6 and AC9's seam.
//
// Every part above and in engine-cadence.ts is a piece: claim, resolve
// due-ness, advance, plan, dispatch. This is the only place they meet, and
// three ACs are about the MEETING rather than about any one piece:
//
//   AC5 — the run records exactly the engines it covered. True only if the
//   set resolveDueEngines returned is the same set planRun was given and the
//   same set the run row stores. One value flows through all three; there is
//   no second engine set anywhere in this file.
//
//   AC6 — cells spread with per-cell jitter. dispatch-cells.ts already draws
//   the jitter; what was missing was anything passing the project's cadence
//   to it. `plan.cadence` carries it, so the scheduler cannot dispatch
//   without one.
//
//   AC9 — a verification run goes through the same path. Enforced by there
//   being one function and a trigger parameter, rather than a second
//   scheduling path that would drift.
//
// ORDERING IS AC3, AND IT IS NOT NEGOTIABLE: `advanceNextRun` runs BEFORE
// the enqueue and inside the same transaction, and the enqueue happens only
// after that transaction commits. Dispatch is not transactional — a job
// handed to Redis cannot be rolled back — so enqueueing first would leave a
// crash window in which the jobs exist and the run row does not.
// ---------------------------------------------------------------------------

/**
 * §5 states cadence as runs per 30-day cycle, so that is what the interval is
 * derived from rather than from calendar weeks: `weekly` is 4 runs per cycle,
 * which is 7.5 days, not 7. Deriving it from a calendar week would give 4.3
 * runs in a 30-day cycle and quietly overrun every plan's stated figure.
 *
 * `manual` returns null: it is not scheduled at all, and a project on it
 * should never have been claimed.
 */
export function nextRunAfter(cadence: ProjectCadence, from: Date): Date | null {
  const cycleMs = CYCLE_DAYS * 24 * 60 * 60 * 1000;
  const runsPerCycle: Record<Exclude<ProjectCadence, "manual">, number> = {
    hourly: 720,
    daily: 30,
    twice_weekly: 8,
    weekly: 4,
  };
  if (cadence === "manual") return null;
  return new Date(from.getTime() + cycleMs / runsPerCycle[cadence]);
}

/** What the caller must supply that the project row cannot. */
export interface ScheduleContext {
  /** The billing cycle the fair-use counter belongs to. */
  readonly periodStart: string;
  readonly normalizerVersion: string;
  readonly captureMode: "api" | "licensed_serp" | "headless";
  /** `cacheKeyNamespace()`. */
  readonly env: string;
  /** False for a workspace whose plan carries `no_shared_cache`. */
  readonly sharedCacheEnabled: boolean;
  readonly personaHint?: string | null;
  /**
   * ⚠ A TEST SEAM, AND PRODUCTION NEVER SETS IT. STORY-152.
   *
   * Forwarded verbatim to `PlanRunContext.captureReadyEngineKeys`, which
   * documents it — the short version is that it defaults to the registry's
   * capture-ready list, that list is EMPTY, and so a scheduled tick plans no
   * cells until STORY-001 binds a real adapter.
   *
   * Carried here because `planScheduledRun` builds the plan context itself,
   * so a spec exercising due-ness, AC5's covered set or AC6's jitter has no
   * other way to reach it. `engine-catalog-entitlement.spec.ts` is what
   * asserts the production default, so this cannot hide it.
   */
  readonly captureReadyEngineKeys?: readonly string[];
}

export interface ScheduledRun {
  readonly projectId: string;
  readonly runId: string;
  readonly trigger: RunTrigger;
  /** Exactly what the run row records — AC5. */
  readonly engineKeys: readonly string[];
  readonly plan: PlannedRun;
}

/**
 * Plans one project's run inside the caller's transaction, and advances
 * `next_run_at` before returning.
 *
 * Returns null, having advanced nothing, when there is nothing to run:
 * either no engine is due, or another transaction advanced this project
 * since it was claimed. Both are ordinary outcomes on a busy tick, not
 * errors.
 *
 * DOES NOT DISPATCH. It has no queue, for the same reason `planRun` has
 * none: the jobs must not exist until the transaction that wrote the run row
 * has committed, and a function holding both a transaction and a queue is
 * one refactor away from enqueueing inside it.
 */
export async function planScheduledRun(
  tx: ClientBase,
  cache: Cache,
  project: DueProject,
  context: ScheduleContext,
  options: {
    readonly runId: string;
    readonly trigger: RunTrigger;
    readonly kind: RunKind;
    readonly now: Date;
  },
): Promise<ScheduledRun | null> {
  const dueEngines = await resolveDueEngines(
    tx,
    {
      projectId: project.projectId,
      kind: options.kind,
      now: options.now,
    },
    // Forwarded so the due set and the planned cells agree on what is
    // capturable. If they disagreed, this would write a run row that planRun
    // then filled with nothing — see engine-cadence.ts's fifth condition.
    // `undefined` means "use the production default", which is what every
    // real caller does, because nothing sets this field.
    context.captureReadyEngineKeys,
  );

  // No engine due. The project is still advanced, deliberately: leaving
  // next_run_at in the past would re-claim it on every tick for the rest of
  // the interval, and a project whose engines are all mid-interval would
  // occupy a batch slot each time and starve the projects behind it.
  const nextRunAt = nextRunAfter(project.cadence, options.now);
  if (dueEngines.length === 0) {
    if (nextRunAt !== null) await advanceNextRun(tx, project, nextRunAt, options.now);
    return null;
  }

  const engineKeys = dueEngines.map((engine) => engine.engineKey);

  // The run row. `planRun` UPDATES it with the counts; it does not create it,
  // because the run's identity and trigger belong to whoever initiated it,
  // not to planning.
  //
  // engine_keys is NOT AUTHORITATIVE HERE — `recordRunCounts` overwrites it
  // moments later with the entitlement-filtered set, which is what AC5
  // actually rests on. This writes the due set anyway because the column is
  // NOT NULL and a placeholder would be a claim about coverage; passing the
  // same array keeps the two writes from ever disagreeing. Verified by
  // mutation: making this INSERT write the enabled set changes nothing, and
  // making planRun resolve the enabled set fails AC5's test.
  await tx.query(
    `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, prompt_scope, status)
     VALUES ($1, $2, $3, $4, $5::text[], $6, 'queued')`,
    [
      options.runId,
      project.workspaceId,
      project.projectId,
      options.trigger,
      engineKeys,
      scopeForKind(options.kind),
    ],
  );

  const plan = await planRun(tx, cache, {
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    runId: options.runId,
    trigger: options.trigger,
    cadence: project.cadence,
    planKey: project.planKey,
    scope: scopeForKind(options.kind),
    // The due set NARROWS the engines planRun would otherwise resolve. It can
    // never widen them past the entitlement — resolveEnabledEngines applies
    // that filter again on its own side.
    engineKeys,
    periodStart: context.periodStart,
    locale: project.locale,
    personaHint: context.personaHint ?? null,
    normalizerVersion: context.normalizerVersion,
    captureMode: context.captureMode,
    env: context.env,
    sharedCacheEnabled: context.sharedCacheEnabled,
    nowMs: options.now.getTime(),
    // Spread rather than assigned, because `exactOptionalPropertyTypes` makes
    // an explicit `undefined` a different thing from an absent key — and the
    // default only applies when the key is absent.
    ...(context.captureReadyEngineKeys === undefined
      ? {}
      : { captureReadyEngineKeys: context.captureReadyEngineKeys }),
  });

  // AC3 — BEFORE the enqueue, in this transaction. The compare-and-set can
  // still lose: if it does, this run must not be dispatched, and returning
  // null rather than the plan is what stops the caller.
  if (nextRunAt !== null && !(await advanceNextRun(tx, project, nextRunAt, options.now))) {
    return null;
  }

  return { projectId: project.projectId, runId: options.runId, trigger: options.trigger, engineKeys, plan };
}

/**
 * The capture queue carries a dual priority, and the trigger decides it.
 *
 * `manual` is the only trigger with a person waiting on the answer, so it is
 * the only interactive one. A verification run is platform-initiated
 * re-measurement and a drift sample is background sampling; giving either the
 * interactive lane would let automated work overtake the runs customers are
 * actually watching.
 */
export function priorityVariantFor(trigger: RunTrigger): PriorityVariant {
  return trigger === "manual" ? "interactive" : "scheduled";
}

/**
 * Dispatches a planned run's cells. Call ONLY after the planning transaction
 * has committed.
 *
 * Exists rather than having callers reach for `dispatchPlannedRun` so that
 * the ordering rule above has somewhere to live at the call site the
 * scheduler actually uses — and so the priority variant is chosen from the
 * trigger every time, rather than at each call site.
 */
export async function dispatchScheduledRun(
  queue: Queue,
  entry: QueueTopologyEntry,
  scheduled: ScheduledRun,
): Promise<Job[]> {
  return dispatchPlannedRun(queue, entry, scheduled.plan, {
    priorityVariant: priorityVariantFor(scheduled.trigger),
  });
}
