import type { ClientBase } from "pg";
import type { ResolvedEntitlementsResponse } from "../../../contracts/entitlements/resolved-entitlements.schema.js";
import type { Cache } from "../cache/cache.port.js";
import { cacheKeyNamespace } from "../cache/key-namespace.js";
import { resolveEntitlements } from "../entitlements/resolution.js";
import { resolveBillingPeriod } from "../usage/billing-period.js";
import { NotFoundError, PreconditionUnmetError } from "../../api/errors/domain-errors.js";
import { deepScanPriceOrThrow } from "./deep-scan-price.js";
import type { ProjectCadence } from "./dispatch-cells.js";
import { planRun, type PlannedRun } from "./plan-run.js";
import { probeRunCells, resolveRunCells } from "./probe-run.js";
import { NORMALIZER_VERSION } from "../parser/normalize.js";

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

/**
 * ⚠ THE ONE DEFINITION OF "THIS SCAN HAS SOMETHING TO CAPTURE": at least one
 * PLANNED cell.
 *
 * Three places ask, and they must never disagree about a scope the customer
 * is about to be charged for:
 *
 *   - the estimate's `capturable`            (`estimateManualRun`)
 *   - the trigger's in-transaction refusal   (`planManualRun`)
 *   - CreditGuard's refusal BEFORE it reserves (`assertManualRunCapturable`)
 *
 * PLANNED, NOT LIVE. A scope whose every cell the cache already answers has
 * planned cells and no live ones: it is real work with a result — a cheaper
 * one, at the same flat price — and refusing it, or reporting it
 * un-capturable, would answer "is anything left to send an engine?", which is
 * a different question. Taking a number rather than a run is deliberate: the
 * three callers hold three different shapes (a probe, a plan, a bare cell
 * count), and none of them offers a way to hand this a liveness figure.
 */
export function scopeIsCapturable(plannedCells: number): boolean {
  return plannedCells > 0;
}

/**
 * The refusal for an empty scope, built once so the trigger and CreditGuard
 * cannot word it — or classify it — differently. `details.reason` is the
 * discriminator a client reads (see error-details.schema.ts): this endpoint
 * also refuses with `price_not_agreed`, and the two have different remedies.
 */
export function noCapturableScopeError(): InstanceType<typeof PreconditionUnmetError> {
  return new PreconditionUnmetError({
    message:
      "this deep scan has nothing to capture: no engine this project can use is able to capture yet, or it has no active prompts. The scan was not started and nothing was charged.",
    details: { reason: "no_capturable_scope" },
  });
}

/**
 * Refuses an empty scope BEFORE anything has been reserved. CreditGuard calls
 * this for `@Credits("deep_scan")`: the trigger's own refusal in `planManualRun`
 * comes after the reservation, so on its own it charges a reserve-and-release
 * pair to the customer-visible ledger, and on a low balance it is never
 * reached at all — the wallet refuses first, with a `402` telling the
 * customer to buy credits for a scan that could not run.
 *
 * Runs on the caller's transaction and reads two tables. It does not touch
 * the cache: whether a cell would be served from cache is irrelevant to
 * whether the scope is empty (see `scopeIsCapturable`).
 *
 * An unknown project is a 404, exactly as the handler's own
 * `loadManualRunProject` would answer — now before a reservation rather than
 * after one.
 */
export async function assertManualRunCapturable(tx: ClientBase, projectId: string): Promise<void> {
  await loadManualRunProject(tx, projectId);
  // No `captureReadyEngineKeys` seam here, deliberately: this runs in the
  // request path, where the registry's own answer is the only one there is.
  // A spec that needs a capture-ready engine replaces the registry
  // (deep-scan-zero-scope-http.spec.ts), so guard and handler see the same one.
  const { cells } = await resolveRunCells(tx, { projectId, scope: "all" });
  if (!scopeIsCapturable(cells.length)) throw noCapturableScopeError();
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
  /**
   * The merged entitlement set this estimate was computed from.
   *
   * Exposed so the caller can answer §7's threshold questions from THE SAME
   * SNAPSHOT that produced the price, on the same connection. See the note at
   * `estimateManualRun`.
   */
  readonly entitlements: ResolvedEntitlementsResponse["entitlements"];
  readonly credits: number;
  readonly forecast: ManualRunForecast;
  readonly promptCount: number;
  readonly engineKeys: readonly string[];
  /**
   * Whether the trigger would accept this scan. THE SAME PREDICATE as the
   * trigger's refusal — `scopeIsCapturable` over the planned cells — so the
   * estimate and the trigger cannot disagree.
   */
  readonly capturable: boolean;
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
  /**
   * ⚠ A TEST SEAM, AND PRODUCTION NEVER SETS IT. STORY-152.
   *
   * Forwarded to `ProbeRunContext.captureReadyEngineKeys`, which documents
   * it. Needed here because this function builds the probe context itself, so
   * a spec asking what a scan would cost cannot otherwise reach it — and the
   * forecast tests are about the cache split and the prompt-times-engine
   * fan-out, neither of which exists over an empty engine set.
   *
   * AN OBJECT RATHER THAN A FIFTH POSITIONAL `readonly string[]`. It sits
   * behind `now: Date = new Date()`, and a caller that miscounted arguments
   * could otherwise reach a capture-readiness override by accident — a
   * reviewer of STORY-152 flagged exactly that. A named field cannot be
   * passed by miscounting.
   */
  options: { readonly captureReadyEngineKeys?: readonly string[] } = {},
): Promise<ManualRunEstimate> {
  // ONE resolution, several questions asked of it. `deep_scan.credits` and
  // `no_shared_cache` both come from the merged entitlement set, and reading
  // it twice on a route that answers in a modal is a round trip for nothing.
  //
  // ⚠ IT IS RETURNED, so the caller does not resolve a second time.
  // STORY-074 needed `projects.max` and `credits.included_per_cycle` for the
  // confirmation verdict and reached for `EntitlementResolver` — which takes
  // its OWN pool connection while the request already holds one, deadlocking
  // `PG_POOL` at ten concurrent estimates. It also read a different snapshot
  // through a Valkey memo, so one response could quote plan A's price beside
  // plan B's thresholds. Handing this one back closes both.
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
    // Spread, not assigned — `exactOptionalPropertyTypes` distinguishes an
    // explicit `undefined` from an absent key, and only the absent key takes
    // the registry default.
    ...(options.captureReadyEngineKeys === undefined
      ? {}
      : { captureReadyEngineKeys: options.captureReadyEngineKeys }),
  });

  return {
    entitlements: resolved.entitlements,
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
    capturable: scopeIsCapturable(probe.cells.length),
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
  options: {
    readonly runId: string;
    readonly triggeredBy: string | null;
    readonly now: Date;
    /**
     * ⚠ A TEST SEAM, AND PRODUCTION NEVER SETS IT. STORY-152 — see
     * `PlanRunContext.captureReadyEngineKeys`, which documents it. The
     * run-lifecycle specs plan a run and then assert dispatch, progress,
     * suppression and failure over its cells; none of that exists when the
     * capture-ready set is empty, which it is in production.
     */
    readonly captureReadyEngineKeys?: readonly string[];
  },
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
    // Spread, not assigned — see the same note in `estimateManualRun`.
    ...(options.captureReadyEngineKeys === undefined
      ? {}
      : { captureReadyEngineKeys: options.captureReadyEngineKeys }),
  });

  // ⚠ NOTHING TO CAPTURE IS REFUSED — NEVER STARTED, NEVER CHARGED.
  //
  // A run with zero planned cells (no engine this project is entitled to can
  // capture yet, or no active prompts) used to be planned, recorded and
  // returned with the full flat price, and `@Credits("deep_scan")` debits on
  // any 2xx — so the customer paid for a scan that could capture nothing.
  // That is every project today: no engine adapter is capture-ready until
  // STORY-001, so `captureReadyEngineKeys()` is empty in production.
  //
  // Thrown INSIDE the request transaction and before anything reaches the
  // debit: TenantContextInterceptor rolls the capture_runs row back, and
  // CreditInterceptor settles only on a handler's success value. `planned`,
  // not `live` — a run whose every cell the cache answers is still real work
  // with a result, just a cheaper one; only an EMPTY scope is refused.
  //
  // This is the IN-TRANSACTION BACKSTOP, not the front line. CreditGuard
  // refuses an empty scope before it reserves (`assertManualRunCapturable`),
  // so a request reaches here empty only if the scope emptied between that
  // check and this transaction — and then the reservation is released and the
  // customer charged nothing, as before.
  if (!scopeIsCapturable(plan.planned)) throw noCapturableScopeError();

  // The price travels back with the plan so the response can state it
  // WITHOUT a second resolution — the two would then be two readings of a
  // schedule that a plan change could move between them.
  return { plan, credits };
}
