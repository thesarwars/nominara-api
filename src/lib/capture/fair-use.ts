import type { ClientBase } from "pg";
import { QuotaExceededError } from "../../api/errors/domain-errors.js";
import { resolveBillingPeriod } from "../usage/billing-period.js";
import { reserveTierCap, UNLIMITED_LIMIT } from "../usage/tier-caps.js";

// STORY-032 AC10 and AC11 — the fair-use ceiling, and the charge hook.
//
// These are two different questions that a reader can easily conflate, so
// they live together and say so explicitly:
//
//   FAIR USE is a non-credit TIER CAP. It is not billing. It binds only on
//   pathological configuration — a project with far more cells than the plan
//   was designed around — and refuses with `quota_exceeded`, whose
//   remediation is `wait_for_cycle`.
//
//   THE CHARGE is credits, and §5's table is unambiguous: only a MANUAL run
//   is charged, and it pays the plan's FLAT deep-scan price regardless of how
//   many cells the cache suppressed. scheduled, verification, drift_sample
//   and conversion_backfill are all zero.

/** §5's trigger set, and the only one of them that is charged. */
export type RunTrigger = "scheduled" | "manual" | "verification" | "drift_sample" | "conversion_backfill";

export const CHARGED_TRIGGERS: readonly RunTrigger[] = ["manual"];

export const FAIR_USE_METRIC = "fair_use_captures" as const;

/**
 * Re-exported so STORY-032's call sites and tests keep one name for it. The
 * sentinel now lives in `src/lib/usage/metrics.ts`, with the counter lifecycle
 * it belongs to — STORY-070 moved it there, as this story's own AC10 note
 * said it should: one module owns `usage_counters`, rather than a second
 * counter lifecycle growing inside `src/lib/capture/`.
 */
export { UNLIMITED_LIMIT };

/**
 * Reserves `cells` against this cycle's fair-use ceiling, ATOMICALLY.
 *
 * A thin wrapper over `reserveTierCap` since STORY-070. The atomicity
 * argument, the unlimited branch and the reserved-rather-than-used reasoning
 * all live there now; what stays here is capture's own vocabulary — cells, a
 * run — so a reader of the planning path is not sent to a billing module to
 * learn what is being reserved.
 *
 * NO JOB ID IS PASSED, and the consequence is stated rather than hidden:
 * nothing can release a capture's reservation, so a run that dies mid-flight
 * leaves it standing until the period rolls. Over-counting for the rest of a
 * cycle is the safe direction for a ceiling. Threading `context.runId` through
 * is what would make it releasable, and it belongs with the worker that
 * converts reserved into used as cells land — which does not exist yet.
 *
 * Returns false rather than throwing, because the caller knows what it was
 * planning and this function does not. `assertFairUseCapacity` is the throwing
 * form for callers that just want the refusal.
 */
export async function reserveFairUseCapacity(
  tx: ClientBase,
  workspaceId: string,
  periodStart: string,
  cells: number,
): Promise<boolean> {
  if (cells < 0) {
    throw new Error(`fair-use reservation: cells must not be negative (got ${String(cells)})`);
  }
  const outcome = await reserveTierCap(tx, {
    workspaceId,
    metric: FAIR_USE_METRIC,
    periodStart,
    quantity: cells,
  });
  return outcome.ok;
}

/**
 * Gives `cells` back to this cycle's fair-use ceiling — the compensation for a
 * reservation whose cells were never captured (NEW-A-10: a run that could not
 * be dispatched).
 *
 * `GREATEST(..., 0)` because `ck_usage_nonneg` would otherwise turn a
 * compensation into a failed transaction. Reserved only, never `used_value`:
 * nothing was captured, so nothing was used.
 */
export async function releaseFairUseCapacity(
  tx: ClientBase,
  workspaceId: string,
  periodStart: string,
  cells: number,
): Promise<void> {
  if (cells <= 0) return;
  await tx.query(
    `UPDATE usage_counters
        SET reserved_value = GREATEST(reserved_value - $4, 0), updated_at = now()
      WHERE workspace_id = $1 AND metric = $2 AND period_start = $3`,
    [workspaceId, FAIR_USE_METRIC, periodStart, cells],
  );
}

/**
 * The throwing form.
 *
 * THE CEILING IS NOT IN THE DETAILS, and that is `FR-CRD-19` rather than an
 * omission: the fair-use figure "is not published — a limit nobody hits adds a
 * dimension and reduces trust at the same time", and a 429 carrying it would
 * publish it to precisely the customer who was about to ask what it is.
 * `METRIC_SPECS` is what decides that, per metric, so the decision lives in
 * one place rather than at each throw site.
 *
 * The metric and the reset date ARE carried. STORY-070 AC6 asks for them, and
 * without a reset date "wait for the cycle" is not an action anybody can take.
 * The extra read to resolve the period end is on the refusal path only, which
 * §11 says never happens on legitimate use.
 */
export async function assertFairUseCapacity(
  tx: ClientBase,
  workspaceId: string,
  periodStart: string,
  cells: number,
): Promise<void> {
  if (await reserveFairUseCapacity(tx, workspaceId, periodStart, cells)) {
    return;
  }
  const period = await resolveBillingPeriod(tx, workspaceId);
  throw new QuotaExceededError({
    message: "this cycle's fair-use capture ceiling is exhausted",
    // No `limit`. METRIC_SPECS records fair use as unpublished, and this
    // assertion is what makes that hold on the one path where the figure could
    // otherwise escape.
    details: { metric: FAIR_USE_METRIC, resets_at: period.end },
  });
}

export interface DeepScanChargeInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly trigger: RunTrigger;
  readonly cellsPlanned: number;
  readonly cellsCharged: number;
  readonly cellsCached: number;
}

/**
 * AC11's charge hook — a NO-OP until EPIC-10 builds the wallet.
 *
 * It exists now, and is called now, so that adding the wallet is a change
 * inside this function rather than a change to every call site. The same
 * reasoning EPIC-03 applied to the guard chain: composing the slot early
 * means filling it later is not a refactor.
 *
 * THE PRICE IS FLAT AND CACHE-INDEPENDENT. §5's table: a manual run "commits
 * the plan's FLAT deep-scan price", and the run summary "discloses the
 * live/cached cell split as work done, never as billing arithmetic". A
 * customer whose run was 90% cache-served pays the same as one whose run was
 * not — pricing per live cell would make the bill depend on what other
 * tenants happened to ask recently, which is unexplainable and unbudgetable.
 * The counts travel with the call for the summary, never for the price.
 *
 * Returns what WOULD be charged so the caller can record it, rather than
 * silently doing nothing and leaving no trace that the hook ran.
 */
export function commitDeepScanCharge(input: DeepScanChargeInput): { charged: boolean; reason: string } {
  if (!CHARGED_TRIGGERS.includes(input.trigger)) {
    // §5's table, spelled out: a scheduled run is inside the subscription
    // envelope; verification is platform-initiated, and charging to measure
    // our own recommendation would be indefensible; drift_sample is absorbed;
    // a conversion backfill was already paid for by the tool run.
    return { charged: false, reason: `trigger "${input.trigger}" is not charged` };
  }
  // EPIC-10 fills this in. Until then the hook records its own inaction
  // rather than pretending to have charged.
  return { charged: false, reason: "the credit wallet does not exist yet (EPIC-10)" };
}
