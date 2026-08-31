import type { Job, Queue } from "bullmq";
import type { ClientBase } from "pg";
import type { Cache } from "../cache/cache.port.js";
import type { QueueTopologyEntry } from "../queue/topology.js";
import { dispatchCaptureCells, type DispatchCell, type DispatchOptions, type ProjectCadence } from "./dispatch-cells.js";
import { assertFairUseCapacity, commitDeepScanCharge, type RunTrigger } from "./fair-use.js";
import { probeExactHash, type L1Hit } from "./l1-exact-hash.js";
import { cellKey, probeSemanticReuse, type L2Hit } from "./l2-semantic-reuse.js";
import {
  fanOutCells,
  resolveEnabledEngines,
  selectPrompts,
  type PlannedCell,
  type PromptScope,
  type ResolvedEngine,
} from "./plan-cells.js";
import { recordRunCounts, recordSuppressedCells, type SuppressedCell } from "./record-suppressed.js";
import { projectAliasFingerprint } from "./l3-short-circuit.js";
import { cohortsFor, measureCohort, type SuppressionMeasurement } from "./suppression-cohorts.js";

// STORY-032 — run planning, end to end.
//
// Every other module in this directory is a part: a probe, a fan-out, a
// writer. This is the only place they meet, and the ACs that are ABOUT the
// meeting — which layer gets first refusal on a cell, what must be durable
// before a job exists — have nowhere else to live. Before this existed, the
// AC12 ordering test asserted a count that was zero either way, because
// there was no code in which the order was decided at all.
//
// THE ORDER IS THE INTERFACE, so it is enforced by types rather than
// described in a comment:
//
//   `planRun` cannot enqueue. It has no queue.
//   `dispatchPlannedRun` cannot plan. It takes a `PlannedRun`, which only
//   `planRun` can produce, and which only exists once the counters have
//   been written.
//
// A caller therefore cannot dispatch a run whose plan is not durable — not
// because it would be wrong to, but because it has nothing to pass.

export interface PlanRunContext {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly trigger: RunTrigger;
  readonly cadence: ProjectCadence;
  readonly planKey: string;
  /** `all` for a scheduled run, or the priority subset. */
  readonly scope: PromptScope;
  /** Narrows the engine set; can never widen it past the entitlement. */
  readonly engineKeys?: readonly string[];
  /** The billing cycle the fair-use counter belongs to. */
  readonly periodStart: string;
  readonly locale: string;
  readonly personaHint: string | null;
  readonly normalizerVersion: string;
  readonly captureMode: "api" | "licensed_serp" | "headless";
  /**
   * The project's alias set AS IT IS NOW.
   *
   * Optional because the planner will read it itself when the caller does
   * not supply one, which is the path that should normally be taken: a
   * caller passing a fingerprint it computed earlier is passing a claim
   * about a set that may have moved since, and a stamp that is even
   * slightly stale is what makes a short-circuit copy a parse the current
   * alias set would not produce. See record-suppressed.ts.
   */
  readonly aliasFingerprint?: Buffer;
  /** `cacheKeyNamespace()`, for the L1 key. */
  readonly env: string;
  /** False for a workspace whose plan carries `no_shared_cache`. */
  readonly sharedCacheEnabled: boolean;
  readonly nowMs: number;
}

export interface PlannedRun {
  readonly runId: string;
  readonly planned: number;
  readonly skipped: number;
  /** What will actually be captured — `planned - skipped`. */
  readonly live: number;
  readonly suppressedByLayer: { readonly l1: number; readonly l2: number };
  readonly cohorts: readonly SuppressionMeasurement[];
  readonly charge: { readonly charged: boolean; readonly reason: string };
  /** The cells to enqueue. Only `dispatchPlannedRun` should read this. */
  readonly cells: readonly DispatchCell[];
  readonly cadence: ProjectCadence;
}

/**
 * The dedup identity of one cell within one run.
 *
 * Pipe-separated for the reason `cellKey` documents: a colon-joined
 * interpolated string reads as a cache key in this codebase, and ISO-13's
 * scanner is right to say so.
 */
function cellIdempotencyKey(runId: string, cell: PlannedCell): string {
  return `${runId}|${cellKey(cell)}`;
}

/**
 * Plan a run: resolve, fan out, suppress, reserve, and record.
 *
 * Nothing here enqueues, and everything here happens in the caller's
 * transaction — which this function now REQUIRES rather than assumes.
 *
 * The requirement was previously a sentence in this comment. It was also
 * wrong in practice: no caller existed outside this directory, the tests
 * passed a bare autocommit client, and `recordRunCounts` had just been made
 * to throw. A run row deleted concurrently — a cancel racing a plan — left
 * the suppressed rows written and the capacity reserved for a plan that
 * threw. Reproduced by the second-engineer review.
 *
 * `SAVEPOINT` is the enforcement: Postgres refuses it outside a transaction
 * block ("SAVEPOINT can only be used in transaction blocks"), so a caller in
 * autocommit is told immediately rather than discovering it after a partial
 * write. It is also the remedy — every write below is undone on the way out.
 */
export async function planRun(tx: ClientBase, cache: Cache, context: PlanRunContext): Promise<PlannedRun> {
  const engines = await resolveEnabledEngines(tx, context.projectId, context.engineKeys);
  const prompts = await selectPrompts(tx, context.projectId, context.scope);
  const cells = fanOutCells(prompts, engines);

  // L1 FIRST, AND ONLY THEN L2. Not interchangeable:
  //
  //   L1 costs one cache round trip for the whole batch; L2 costs a vector
  //   query against the largest table in the platform. Asking the expensive
  //   layer about cells the cheap one already answered is pure waste.
  //
  //   More importantly, a cell suppressed twice would produce TWO
  //   answer_captures rows for one cell and count as two skips, inflating
  //   the suppression rate with duplicates. Passing only the survivors on is
  //   what makes each cell belong to exactly one layer.
  const l1Hits = await probeExactHash(
    cache,
    {
      env: context.env,
      locale: context.locale,
      personaHint: context.personaHint,
      nowMs: context.nowMs,
      sharedCacheEnabled: context.sharedCacheEnabled,
    },
    cells,
  );
  const afterL1 = cells.filter((cell) => !l1Hits.has(cellKey(cell)));

  const l2Hits = await probeSemanticReuse(
    tx,
    { workspaceId: context.workspaceId, projectId: context.projectId },
    afterL1.map((cell) => ({
      promptId: cell.promptId,
      engineKey: cell.engineKey,
      sampleIndex: cell.sampleIndex,
      ttlSeconds: cell.ttlSeconds,
    })),
  );
  const liveCells = afterL1.filter((cell) => !l2Hits.has(cellKey(cell)));

  // THE CEILING IS RESERVED FOR THE LIVE CELLS ONLY, and before anything is
  // written. A cell served from cache makes no vendor call and must not
  // consume capacity — charging for suppressed cells would make the cache
  // save money on the invoice and nothing on the quota.
  //
  // First, too: this throws, and a refusal must leave no suppressed rows and
  // no counters behind for a run that will not happen.
  //
  // AND ONLY THE DELTA, because replanning is the documented recovery from a
  // crash between the plan committing and the jobs being enqueued. Reserving
  // `liveCells.length` unconditionally charged the ceiling again on every
  // replan, for cells already reserved — capacity consumed by a run that
  // captures once. What this run has already reserved is derivable from the
  // row it already wrote: `planned - skipped` is what it took last time.
  //
  // A replan that finds MORE cache hits than before reserves nothing and
  // leaves the difference held. Releasing it is STORY-070's AC — "failure
  // releases the reservation idempotently by job identifier" — and building
  // a second release path here would be the same mistake that put the
  // reservation in this module to begin with. Clamped at zero and recorded
  // rather than silently negative.
  // THE WRITE LEG BEGINS HERE. See the note above: this both requires a
  // transaction and scopes everything that follows, so a failure anywhere
  // below leaves the reservation and the rows as they were.
  await tx.query("SAVEPOINT nominara_plan_run");
  try {
    return await writePlan(tx, context, cells, liveCells, l1Hits, l2Hits, afterL1, engines);
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT nominara_plan_run");
    throw error;
  } finally {
    await tx.query("RELEASE SAVEPOINT nominara_plan_run").catch(() => undefined);
  }
}

async function writePlan(
  tx: ClientBase,
  context: PlanRunContext,
  cells: readonly PlannedCell[],
  liveCells: readonly PlannedCell[],
  l1Hits: Map<string, L1Hit>,
  l2Hits: Map<string, L2Hit>,
  afterL1: readonly PlannedCell[],
  engines: readonly ResolvedEngine[],
): Promise<PlannedRun> {
  // Read at write time from the database, unless the caller pinned one.
  const aliasFingerprint = context.aliasFingerprint ?? (await projectAliasFingerprint(tx, context.projectId));

  const priorRun = await tx.query<{ planned_cells: number; skipped_cells: number }>(
    "SELECT planned_cells, skipped_cells FROM capture_runs WHERE id = $1",
    [context.runId],
  );
  const alreadyReserved = Math.max(
    0,
    (priorRun.rows[0]?.planned_cells ?? 0) - (priorRun.rows[0]?.skipped_cells ?? 0),
  );
  await assertFairUseCapacity(
    tx,
    context.workspaceId,
    context.periodStart,
    Math.max(0, liveCells.length - alreadyReserved),
  );

  const suppressed: SuppressedCell[] = [
    ...cells.flatMap((cell): SuppressedCell[] => {
      const hit = l1Hits.get(cellKey(cell));
      return hit === undefined
        ? []
        : [
            {
              layer: "l1",
              promptId: cell.promptId,
              engineKey: cell.engineKey,
              sampleIndex: cell.sampleIndex,
              contentHash: hit.contentHash,
              payload: hit.payload,
              excerpt: hit.excerpt,
              adapterVersion: cell.adapterVersion,
            },
          ];
    }),
    ...afterL1.flatMap((cell): SuppressedCell[] => {
      const hit = l2Hits.get(cellKey(cell));
      return hit === undefined
        ? []
        : [
            {
              layer: "l2",
              promptId: cell.promptId,
              engineKey: cell.engineKey,
              sampleIndex: cell.sampleIndex,
              sourceResultId: hit.sourceResultId,
              sourceContentHash: hit.sourceContentHash,
              adapterVersion: cell.adapterVersion,
            },
          ];
    }),
  ];

  await recordSuppressedCells(
    tx,
    {
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      runId: context.runId,
      normalizerVersion: context.normalizerVersion,
      captureMode: context.captureMode,
      aliasFingerprint,
    },
    suppressed,
  );

  // AC12 — durable before any job can exist. See the note at the top: what
  // makes this an ordering rather than a hope is that the return value of
  // this function is the only thing `dispatchPlannedRun` accepts.
  await recordRunCounts(tx, context.runId, {
    planned: cells.length,
    skipped: suppressed.length,
    // The engines that survived entitlement filtering, not the ones asked
    // for. See RunCounts.engineKeys.
    engineKeys: engines.map((engine) => engine.engineKey),
  });

  const cohortInput = { cadence: context.cadence, planKey: context.planKey };
  return {
    runId: context.runId,
    planned: cells.length,
    skipped: suppressed.length,
    live: liveCells.length,
    suppressedByLayer: { l1: l1Hits.size, l2: l2Hits.size },
    // MEASURED PER COHORT, not blended: a run belongs to every cohort it
    // qualifies for and is measured against each one's own target.
    cohorts: cohortsFor(cohortInput).map((cohort) => measureCohort(cohort, cells.length, suppressed.length)),
    charge: commitDeepScanCharge({
      workspaceId: context.workspaceId,
      runId: context.runId,
      trigger: context.trigger,
      cellsPlanned: cells.length,
      cellsCharged: liveCells.length,
      cellsCached: suppressed.length,
    }),
    cells: liveCells.map((cell) => ({
      promptId: cell.promptId,
      engineKey: cell.engineKey,
      sampleIndex: cell.sampleIndex,
      idempotencyKey: cellIdempotencyKey(context.runId, cell),
      payload: {
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        runId: context.runId,
        promptId: cell.promptId,
        promptText: cell.promptText,
        engineKey: cell.engineKey,
        sampleIndex: cell.sampleIndex,
        adapterVersion: cell.adapterVersion,
        ttlSeconds: cell.ttlSeconds,
        locale: context.locale,
        personaHint: context.personaHint,
      },
    })),
    cadence: context.cadence,
  };
}

/**
 * Enqueue what a plan left to capture — one batch, with per-cell jitter.
 *
 * Takes a `PlannedRun` rather than cells so that it cannot be reached
 * without having planned first. Dispatch is not transactional, so this
 * belongs AFTER the caller's commit: a crash between the two loses jobs, and
 * a replan re-creates them under the same deduplication keys, whereas a
 * rollback after enqueueing would leave jobs for a run that does not exist.
 */
export async function dispatchPlannedRun(
  queue: Queue,
  entry: QueueTopologyEntry,
  plan: PlannedRun,
  options?: Omit<DispatchOptions, "cadence">,
): Promise<Job[]> {
  return dispatchCaptureCells(queue, entry, plan.cells, { ...options, cadence: plan.cadence });
}
