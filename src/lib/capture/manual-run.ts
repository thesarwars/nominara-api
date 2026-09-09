import type { ClientBase } from "pg";
import type { ResolvedEntitlementsResponse } from "../../../contracts/entitlements/resolved-entitlements.schema.js";
import type { Cache } from "../cache/cache.port.js";
import { cacheKeyNamespace } from "../cache/key-namespace.js";
import { resolveEntitlements } from "../entitlements/resolution.js";
import { resolveBillingPeriod } from "../usage/billing-period.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { deepScanPriceOrThrow } from "./deep-scan-price.js";
import type { ProjectCadence } from "./dispatch-cells.js";
import { planRun, type PlannedRun } from "./plan-run.js";
import { probeRunCells } from "./probe-run.js";

// STORY-034 — the manual deep scan.
//
// It is `planScheduledRun` with three differences, and each one is a
// requirement rather than a convenience:
//
//   THE SCOPE IS FIXED. §3: "Runs the full tracked set on every enabled
//   engine... The body takes no scope or engine selection." So `scope: "all"`
//   and no `engineKeys` narrowing — `resolveEnabledEngines` applies the
//   entitlement filter and nothing narrows it further. The scheduled path
//   passes the cadence-due subset; this one deliberately does not, because a
//   flat price only holds if the scope is fixed.
//
//   NOTHING IS ADVANCED. `next_run_at` belongs to the cadence. A customer
//   triggering a scan by hand has not moved their schedule, and quietly
//   pushing the next scheduled run out by an interval would mean paying for
//   a manual scan silently cost them a scheduled one.
//
//   IT IS PRICED. §5's table charges `manual`; every other trigger is inside
//   the subscription envelope. The charge itself is still `commitDeepScanCharge`,
//   which records its own inaction until EPIC-10 builds the wallet.

/** `v1` everywhere in this codebase; there is no second normaliser yet. */
export const NORMALIZER_VERSION = "v1";

/**
 * The mode a manual scan captures in.
 *
 * `api` is the only mode with a shipped adapter path — STORY-027's fixture
 * registry — and `licensed_serp` and `headless` are STORY-029's and a
 * browser pool's respectively. Named here rather than defaulted deep inside
 * the planner so the assumption is visible at the one place that makes it.
 */
export const MANUAL_CAPTURE_MODE = "api" as const;

export interface ManualRunProject {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly locale: string;
  readonly cadence: ProjectCadence;
  readonly planKey: string;
}

/** What both the estimate and the trigger need before they can do anything. */
export async function loadManualRunProject(tx: ClientBase, projectId: string): Promise<ManualRunProject> {
  const result = await tx.query<{
    id: string;
    workspace_id: string;
    locale: string;
    cadence: ProjectCadence;
    plan_key: string;
  }>(
    `SELECT p.id, p.workspace_id, p.locale, p.cadence, w.plan_key
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.id = $1
        AND p.deleted_at IS NULL`,
    [projectId],
  );

  const row = result.rows[0];
  if (row === undefined) throw new NotFoundError({ message: "no such project" });
  return {
    projectId: row.id,
    workspaceId: row.workspace_id,
    locale: row.locale,
    cadence: row.cadence,
    planKey: row.plan_key,
  };
}

export interface ManualRunForecast {
  readonly plannedCells: number;
  readonly liveCells: number;
  readonly cachedCells: number;
  readonly cachedByLayer: { readonly l1: number; readonly l2: number };
}

export interface ManualRunEstimate {
  readonly credits: number;
  readonly forecast: ManualRunForecast;
  readonly promptCount: number;
  readonly engineKeys: readonly string[];
}

/**
 * AC1 — the free estimate.
 *
 * Reads. Reserves nothing, writes nothing, and opens no transaction: every
 * side effect stayed in `planRun`, which is what makes `probeRunCells`
 * shareable in the first place.
 *
 * The forecast can be WRONG BY THE TIME THE RUN HAPPENS, and that is not a
 * defect to engineer away: an L1 entry can expire, or another tenant's run
 * can populate one, between the modal opening and the button being pressed.
 * The PRICE cannot move for that reason — it is flat — which is exactly why
 * `X-Nominara-Confirmed-Credits` guards the price and nothing guards the
 * forecast.
 */
export async function estimateManualRun(
  tx: ClientBase,
  cache: Cache,
  project: ManualRunProject,
  now: Date = new Date(),
): Promise<ManualRunEstimate> {
  // ONE resolution, two questions asked of it. `deep_scan.credits` and
  // `no_shared_cache` both come from the merged entitlement set, and reading
  // it twice on a route that answers in a modal is a round trip for nothing.
  const resolved = await resolveEntitlements(tx, project.workspaceId);
  const credits = await deepScanPriceOrThrow(tx, resolved.entitlements);
  const probe = await probeRunCells(tx, cache, {
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    scope: "all",
    locale: project.locale,
    personaHint: null,
    env: cacheKeyNamespace(),
    sharedCacheEnabled: sharedCacheEnabled(resolved.entitlements),
    nowMs: now.getTime(),
  });

  return {
    credits,
    forecast: {
      plannedCells: probe.cells.length,
      liveCells: probe.liveCells.length,
      cachedCells: probe.cells.length - probe.liveCells.length,
      cachedByLayer: { l1: probe.l1Hits.size, l2: probe.l2Hits.size },
    },
    // Cells divided by engines, rather than a second `selectPrompts` call —
    // the fan-out is one cell per prompt per engine, so a second query would
    // be a second chance to disagree with the number just probed.
    promptCount: probe.engines.length === 0 ? 0 : probe.cells.length / probe.engines.length,
    engineKeys: probe.engines.map((engine) => engine.engineKey),
  };
}

/** `no_shared_cache` inverted — the plan key is a negative, the planner's flag is a positive. */
function sharedCacheEnabled(entitlements: ResolvedEntitlementsResponse["entitlements"]): boolean {
  return entitlements["no_shared_cache"]?.value !== true;
}

/**
 * AC2's write leg — the run row, then the plan, inside the caller's transaction.
 *
 * The run row is INSERTed here rather than by `planRun`, for the reason
 * `planScheduledRun` states: "the run's identity and trigger belong to
 * whoever initiated it, not to planning."
 *
 * `engine_keys` is written from the entitlement-resolved set and then
 * overwritten by `recordRunCounts` with the same set. The column is NOT NULL
 * and a placeholder would be a claim about coverage.
 */
export async function planManualRun(
  tx: ClientBase,
  cache: Cache,
  project: ManualRunProject,
  options: { readonly runId: string; readonly triggeredBy: string | null; readonly now: Date },
): Promise<{ readonly plan: PlannedRun; readonly credits: number }> {
  // Re-resolved INSIDE the caller's transaction. The route priced the run
  // against the header before opening one; a plan changed in between would
  // otherwise be planned at yesterday's price, and this is the read that
  // shares a snapshot with the rows about to be written.
  const resolved = await resolveEntitlements(tx, project.workspaceId);
  const credits = await deepScanPriceOrThrow(tx, resolved.entitlements);

  await tx.query(
    `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, triggered_by, engine_keys, prompt_scope, status)
     VALUES ($1, $2, $3, 'manual', $4, ARRAY[]::text[], 'all', 'queued')`,
    [options.runId, project.workspaceId, project.projectId, options.triggeredBy],
  );

  const plan = await planRun(tx, cache, {
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    runId: options.runId,
    trigger: "manual",
    cadence: project.cadence,
    planKey: project.planKey,
    scope: "all",
    // STORY-070's resolver, not a second reading of the same three sources:
    // the fair-use ceiling and the credit wallet must roll on the same day.
    periodStart: (await resolveBillingPeriod(tx, project.workspaceId, options.now)).start,
    locale: project.locale,
    personaHint: null,
    normalizerVersion: NORMALIZER_VERSION,
    captureMode: MANUAL_CAPTURE_MODE,
    env: cacheKeyNamespace(),
    sharedCacheEnabled: sharedCacheEnabled(resolved.entitlements),
    nowMs: options.now.getTime(),
  });

  // The price travels back with the plan so the response can state it
  // WITHOUT a second resolution — the two would then be two readings of a
  // schedule that a plan change could move between them.
  return { plan, credits };
}
