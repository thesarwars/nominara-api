import type { ClientBase } from "pg";
import type { Cache } from "../cache/cache.port.js";
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

// STORY-034 — the READ leg of planning, lifted out of plan-run.ts so the
// estimate and the run itself cannot disagree about what a run would do.
//
// WHY THIS IS ONE FUNCTION AND NOT TWO. `POST /projects/{id}/runs/estimate`
// is free and returns "the exact credit price and the cache forecast"
// (§3) — the forecast being the live/cached split. That split is not a
// separate calculation from the plan's: it is the plan's, minus every write.
// A second implementation of "resolve, fan out, ask L1, then ask L2" would
// be a second answer to the same question, and the one the customer is shown
// before paying is exactly the one that must match.
//
// So the estimate calls this, `planRun` calls this, and the ordering below
// is stated once. Everything with a side effect stayed behind in plan-run.ts:
// there is no `SAVEPOINT` here, nothing is reserved, and no row is written.

export interface ProbeRunContext {
  readonly workspaceId: string;
  readonly projectId: string;
  /** `all` for a scheduled run, or the priority subset. */
  readonly scope: PromptScope;
  /** STORY-067: the prompt cluster a `cluster` scope covers. */
  readonly clusterId?: string;
  /** Narrows the engine set; can never widen it past the entitlement. */
  readonly engineKeys?: readonly string[];
  /** Test seam — production leaves it undefined. See PlanRunContext. */
  readonly captureReadyEngineKeys?: readonly string[];
  readonly locale: string;
  readonly personaHint: string | null;
  /** `cacheKeyNamespace()`, for the L1 key. */
  readonly env: string;
  /** False for a workspace whose plan carries `no_shared_cache`. */
  readonly sharedCacheEnabled: boolean;
  readonly nowMs: number;
}

export interface ProbedRun {
  readonly engines: readonly ResolvedEngine[];
  /** Every cell the run would contain, suppressed or not. */
  readonly cells: readonly PlannedCell[];
  /** The cells L1 did not answer — the input L2 was actually asked about. */
  readonly afterL1: readonly PlannedCell[];
  /** What would reach an engine: `cells` minus both cache layers. */
  readonly liveCells: readonly PlannedCell[];
  readonly l1Hits: Map<string, L1Hit>;
  readonly l2Hits: Map<string, L2Hit>;
}

/**
 * The cells a run would contain BEFORE either cache layer is asked — engines
 * resolved, prompts selected, fanned out. Reads two tables and touches no
 * cache, so it is cheap enough to answer "is there anything to capture" ahead
 * of a reservation (CreditGuard does) without a cache round trip.
 *
 * `probeRunCells` starts here, so the count a guard sees and the cells the
 * estimate and the planner then probe cannot come from two different readings.
 */
export async function resolveRunCells(
  tx: ClientBase,
  context: Pick<ProbeRunContext, "projectId" | "scope" | "clusterId" | "engineKeys" | "captureReadyEngineKeys">,
): Promise<{ readonly engines: readonly ResolvedEngine[]; readonly cells: readonly PlannedCell[] }> {
  const engines = await resolveEnabledEngines(tx, context.projectId, context.engineKeys, context.captureReadyEngineKeys);
  const prompts = await selectPrompts(tx, context.projectId, context.scope, context.clusterId ?? null);
  return { engines, cells: fanOutCells(prompts, engines) };
}

/**
 * Resolve, fan out, and ask each cache layer in turn. Writes nothing.
 *
 * Safe to call outside a transaction, which is the point: the estimate route
 * has no transaction to offer and must not open one to answer a question.
 */
export async function probeRunCells(tx: ClientBase, cache: Cache, context: ProbeRunContext): Promise<ProbedRun> {
  const { engines, cells } = await resolveRunCells(tx, context);

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

  return { engines, cells, afterL1, liveCells, l1Hits, l2Hits };
}
