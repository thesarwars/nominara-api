import type { ClientBase } from "pg";
import { QuotaExceededError } from "../../api/errors/domain-errors.js";

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

export const FAIR_USE_METRIC = "fair_use_captures";

/**
 * The unlimited sentinel, from §9's reservation SQL.
 *
 * Named rather than written as a bare `-1` in the statement, because the
 * literal is indistinguishable from a typo at the call site and the failure
 * it guards against is silent: without the branch below, the comparison for
 * an unlimited row reads `used + reserved + cells <= -1`, which is false for
 * every positive request. The sentinel that must NEVER block would block
 * ALWAYS — the exact inverse of its meaning, and invisible until an
 * enterprise workspace on a negotiated ceiling is refused every capture.
 */
export const UNLIMITED_LIMIT = -1;

/**
 * Reserves `cells` against this cycle's fair-use ceiling, ATOMICALLY.
 *
 * One statement, and that is the requirement rather than a style preference.
 * A read-then-write would let two runs planning concurrently both observe
 * spare capacity and both reserve it, so the cap would be exceeded by exactly
 * the amount that made it worth having. The `WHERE` clause below is what
 * makes the check and the increment the same operation: it either matches a
 * row with room and increments it, or matches nothing.
 *
 * An UNLIMITED ceiling still takes this path and still increments: it is a
 * ceiling that never binds, not a counter that stops counting. Skipping the
 * write would leave an enterprise workspace with no usage signal at all,
 * and the internal-cost view exists precisely for the accounts too large to
 * cap.
 *
 * Reserved rather than used: the cells have not been captured yet. A worker
 * converts reserved into used as each lands, and a run that dies mid-flight
 * leaves a reservation the cycle rollover clears — over-counting for the rest
 * of a cycle is the safe direction for a ceiling.
 *
 * Returns false rather than throwing, because the caller knows what it was
 * planning and this function does not. `assertFairUseCapacity` is the
 * throwing form for callers that just want the refusal.
 */
export async function reserveFairUseCapacity(
  tx: ClientBase,
  workspaceId: string,
  periodStart: string,
  cells: number,
): Promise<boolean> {
  // Reserving nothing always succeeds, and must not touch the row: a run
  // fully served from cache has nothing to reserve, and writing a no-op
  // increment would still take the row lock and serialise planning across
  // every project in the workspace for no reason.
  if (cells === 0) return true;
  if (cells < 0) {
    throw new Error(`fair-use reservation: cells must not be negative (got ${String(cells)})`);
  }

  const result = await tx.query(
    `UPDATE usage_counters
        SET reserved_value = reserved_value + $4
      WHERE workspace_id = $1
        AND metric = $2
        AND period_start = $3
        AND (limit_value = $5 OR used_value + reserved_value + $4 <= limit_value)`,
    [workspaceId, FAIR_USE_METRIC, periodStart, cells, UNLIMITED_LIMIT],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * The throwing form. `quota_exceeded` carries NO details, deliberately —
 * contracts/common/error-details.schema.ts records that as a finding rather
 * than an omission: it is the one spend-and-limit code the reference gives no
 * details shape for, and inventing `{limit, used}` here would publish a shape
 * no reference committed to.
 */
export async function assertFairUseCapacity(
  tx: ClientBase,
  workspaceId: string,
  periodStart: string,
  cells: number,
): Promise<void> {
  if (!(await reserveFairUseCapacity(tx, workspaceId, periodStart, cells))) {
    throw new QuotaExceededError({
      message: "this cycle's fair-use capture ceiling is exhausted",
    });
  }
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
