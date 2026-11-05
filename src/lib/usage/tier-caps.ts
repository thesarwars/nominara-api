import type { ClientBase } from "pg";
import { structuralLimitFrom } from "../entitlements/classification.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { METRIC_SPECS, UNLIMITED_LIMIT, USAGE_METRICS, type UsageMetric } from "./metrics.js";

// STORY-070 AC2, AC3, AC4, AC5, AC8, AC11 — the non-credit tier-cap lifecycle.
//
// schemas/billing-and-credits.md: "The reservation statement is the same
// reserve/commit/release shape as the wallet, single round trip, race-free."
// The story says why the duplication is deliberate rather than lazy: "Both are
// race-prone counters, and using the same single-statement conditional pattern
// means one reviewed approach covers both rather than two
// similar-but-different implementations."
//
// EVERY STATEMENT BELOW PUTS ITS CONDITION IN THE `WHERE` CLAUSE. That is the
// whole design, and it is not a style preference: a read-then-write lets two
// concurrent callers both observe spare capacity and both take it, so the cap
// is exceeded by exactly the amount that made it worth having. The loser here
// matches zero rows and gets a clean refusal with nothing written.

/** §9's reservation SQL, and the schema's own `-1 = unlimited`. */
export { UNLIMITED_LIMIT };

export interface CounterState {
  readonly limitValue: number;
  readonly usedValue: number;
  readonly reservedValue: number;
}

export class UnusableCeilingError extends Error {
  constructor(metric: UsageMetric, value: EntitlementValue) {
    super(
      `usage metric '${metric}' resolved to ${JSON.stringify(value)}, which is not a ceiling. ` +
        "A tier cap must be a number, null/false, or one of the open-ended strings.",
    );
    this.name = "UnusableCeilingError";
  }
}

/**
 * The `limit_value` an entitlement value becomes.
 *
 * Shares `structuralLimitFrom` with `EntitlementGuard` rather than restating
 * the mapping, so "unlimited"/"uncapped"/"custom"/"negotiated" cannot come to
 * mean one thing to a structural limit and another to a counter.
 *
 * A ZERO STAYS ZERO. It is tempting to translate `exports.pdf_per_cycle: 0`
 * into "no counter", but AC7 needs the zero to be visible: the guard has to
 * distinguish "your tier has none of this" from "you have used yours", and it
 * can only do that if the zero survives to be read.
 */
export function limitValueFor(metric: UsageMetric, value: EntitlementValue): number {
  const limit = structuralLimitFrom(value);
  if (limit === undefined) {
    throw new UnusableCeilingError(metric, value);
  }
  return limit.kind === "unlimited" ? UNLIMITED_LIMIT : limit.limit;
}

/**
 * Creates this period's four counter rows, or refreshes their ceilings.
 *
 * AC11's "counters reset per period, and the reset is idempotent" falls out of
 * the primary key rather than out of any resetting logic: a new period is a new
 * `period_start`, so its rows are born at zero and the previous period's rows
 * are left intact as history. There is no statement anywhere that sets
 * `used_value` back to zero, which is what makes running this twice — or
 * fifty times, on every request — harmless.
 *
 * `ON CONFLICT` updates the CEILING and nothing else. A plan change mid-cycle
 * must move the limit (§2: "a plan change is a data change with no redeploy"),
 * and must not forgive what has already been used.
 *
 * `billable` is false for all four. The schema comments it "false for the
 * internal-cost metrics", and the table's own heading is unambiguous about the
 * rest: "Only four metrics live here, and **none of them is charged in
 * credits**." Nothing here reaches an invoice, so nothing here is billable
 * today; the column is what a future metered-overage metric would set.
 */
export async function provisionUsageCounters(
  tx: ClientBase,
  workspaceId: string,
  periodStart: string,
  entitlements: Readonly<Record<string, { readonly value: EntitlementValue }>>,
): Promise<void> {
  for (const metric of USAGE_METRICS) {
    const spec = METRIC_SPECS[metric];
    const limitValue =
      spec.entitlementKey === null
        ? // No plan-facing ceiling exists for the internal-cost metrics, and
          // inventing one would put our embedding spend in a customer's plan.
          // They are metered, never enforced.
          UNLIMITED_LIMIT
        : limitValueFor(metric, entitlements[spec.entitlementKey]?.value ?? null);

    await tx.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, billable)
       VALUES ($1, $2, $3, $4, false)
       ON CONFLICT (workspace_id, metric, period_start)
       DO UPDATE SET limit_value = EXCLUDED.limit_value, updated_at = now()`,
      [workspaceId, metric, periodStart, limitValue],
    );
  }
}

export interface ReservationRequest {
  readonly workspaceId: string;
  readonly metric: UsageMetric;
  readonly periodStart: string;
  readonly quantity: number;
  /**
   * What a later commit or release names to settle this reservation.
   *
   * Optional, and the consequence is stated rather than hidden: without one,
   * the reservation is made but no `usage_reservations` row exists, so nothing
   * can commit or release it and it stands until the period rolls.
   * Over-counting for the rest of a cycle is the safe direction for a ceiling,
   * and it is what capture does today (see `src/lib/capture/fair-use.ts`).
   */
  readonly jobId?: string;
}

export type ReservationOutcome =
  | { readonly ok: true; readonly remaining: number | null; readonly alreadyHeld: false }
  /** The job already holds a reservation. Nothing was added — see the note on replay below. */
  | { readonly ok: true; readonly remaining: null; readonly alreadyHeld: true }
  | { readonly ok: false };

/**
 * Reserves `quantity` against this period's ceiling. ONE statement.
 *
 * AC2: "a single conditional statement with the sufficiency test in its
 * predicate, returning nothing when exhausted — no partial state."
 *
 * The data-modifying CTE is what keeps that true across two tables: the
 * counter update is the anchor, and the reservation row is inserted only from
 * the rows the update actually matched. Exhausted means the update matches
 * nothing, the insert selects from nothing, and neither table is touched.
 *
 * REPLAY. `NOT EXISTS` over `usage_reservations` makes a second reserve under
 * the same job id a no-op rather than a second increment — a redelivered
 * queue job must not consume the cap twice. It returns `alreadyHeld: true`
 * rather than silently succeeding, because a caller reserving a LARGER
 * quantity under an id it already used is asking for something this shape
 * cannot give, and should find that out.
 *
 * A RELEASED reservation is not a held one (STORY-180 r6). A release gives the capacity back, so a retry under the same job id must
 * take it again - capped and counted - rather than be waved through as a replay that holds nothing. The ON CONFLICT re-opens the
 * settled row (only a released row can conflict here: the `bumped` predicate already excludes reserved and committed ones).
 *
 * An UNLIMITED ceiling still takes this path and still increments. It is a
 * ceiling that never binds, not a counter that stops counting — and the
 * internal-cost view exists precisely for the accounts too large to cap.
 */
export async function reserveTierCap(tx: ClientBase, request: ReservationRequest): Promise<ReservationOutcome> {
  const { workspaceId, metric, periodStart, quantity, jobId } = request;

  if (quantity < 0) {
    throw new Error(`tier-cap reservation: quantity must not be negative (got ${String(quantity)})`);
  }
  // Reserving nothing must not touch the row. A no-op increment still takes
  // the row lock and would serialise every caller in the workspace behind a
  // request that needed nothing.
  if (quantity === 0) {
    return { ok: true, remaining: null, alreadyHeld: false };
  }

  if (jobId === undefined) {
    const result = await tx.query<{ remaining: string | null }>(
      `UPDATE usage_counters
          SET reserved_value = reserved_value + $4, updated_at = now()
        WHERE workspace_id = $1 AND metric = $2 AND period_start = $3
          AND (limit_value = $5 OR used_value + reserved_value + $4 <= limit_value)
      RETURNING CASE WHEN limit_value = $5 THEN NULL
                     ELSE limit_value - (used_value + reserved_value) END AS remaining`,
      [workspaceId, metric, periodStart, quantity, UNLIMITED_LIMIT],
    );
    const row = result.rows[0];
    return row === undefined ? { ok: false } : { ok: true, remaining: numberOrNull(row.remaining), alreadyHeld: false };
  }

  const result = await tx.query<{ remaining: string | null; already_held: boolean }>(
    `WITH bumped AS (
       UPDATE usage_counters
          SET reserved_value = reserved_value + $4, updated_at = now()
        WHERE workspace_id = $1 AND metric = $2 AND period_start = $3
          AND (limit_value = $5 OR used_value + reserved_value + $4 <= limit_value)
          AND NOT EXISTS (SELECT 1 FROM usage_reservations r
                           WHERE r.workspace_id = $1 AND r.metric = $2 AND r.job_id = $6 AND r.state <> 'released')
      RETURNING CASE WHEN limit_value = $5 THEN NULL
                     ELSE limit_value - (used_value + reserved_value) END AS remaining
     ), claimed AS (
       INSERT INTO usage_reservations (workspace_id, metric, job_id, period_start, quantity)
       SELECT $1, $2, $6, $3, $4 FROM bumped
       ON CONFLICT (workspace_id, metric, job_id)
       DO UPDATE SET state = 'reserved', settled_at = NULL, period_start = EXCLUDED.period_start, quantity = EXCLUDED.quantity, created_at = now()
       RETURNING job_id
     )
     SELECT (SELECT remaining FROM bumped) AS remaining,
            NOT EXISTS (SELECT 1 FROM claimed) AS already_held`,
    [workspaceId, metric, periodStart, quantity, UNLIMITED_LIMIT, jobId],
  );

  // The trailing SELECT is a bare projection, so it always returns exactly one
  // row; what varies is whether the CTEs above matched anything.
  const row = result.rows[0]!;
  if (!row.already_held) {
    return { ok: true, remaining: numberOrNull(row.remaining), alreadyHeld: false };
  }

  // Nothing was inserted, and that has two causes with opposite meanings: the
  // job already holds a reservation, or the ceiling refused. They are told
  // apart by whether the row exists, not by guessing — a refusal reported as a
  // replay would let a run proceed past an exhausted cap.
  const held = await tx.query(
    "SELECT 1 FROM usage_reservations WHERE workspace_id = $1 AND metric = $2 AND job_id = $3 AND state <> 'released'",
    [workspaceId, metric, jobId],
  );
  return (held.rowCount ?? 0) > 0 ? { ok: true, remaining: null, alreadyHeld: true } : { ok: false };
}

/**
 * Reserved becomes used. AC3: "in one statement with both deltas."
 *
 * Both deltas together is the requirement, and it is not pedantry: as two
 * statements there is an instant where the amount is counted twice — once as
 * used and once as still reserved — and any concurrent reservation reading
 * the counter in that window is refused capacity that exists.
 *
 * IDEMPOTENT BY `state = 'reserved'` in the predicate. A second commit of one
 * job matches no reservation, so `claimed` is empty and the counter update
 * matches nothing.
 */
export async function commitTierCap(
  tx: ClientBase,
  workspaceId: string,
  metric: UsageMetric,
  jobId: string,
): Promise<boolean> {
  const result = await tx.query(
    `WITH claimed AS (
       UPDATE usage_reservations
          SET state = 'committed', settled_at = now()
        WHERE workspace_id = $1 AND metric = $2 AND job_id = $3 AND state = 'reserved'
      RETURNING period_start, quantity
     )
     UPDATE usage_counters c
        SET used_value     = c.used_value     + claimed.quantity,
            reserved_value = c.reserved_value - claimed.quantity,
            updated_at     = now()
       FROM claimed
      WHERE c.workspace_id = $1 AND c.metric = $2 AND c.period_start = claimed.period_start`,
    [workspaceId, metric, jobId],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * The reservation goes back. AC4/AC5: idempotent by job identifier, so a
 * retried compensation does not over-release.
 *
 * `GREATEST(..., 0)` is belt to the `state` predicate's braces. The predicate
 * is what makes the release happen once; the clamp is what stops a counter
 * going negative if it ever does not — and `ck_usage_nonneg` would otherwise
 * turn a compensation into a failed transaction, which is the worst moment for
 * one, since the compensation is already running because something failed.
 */
export async function releaseTierCap(
  tx: ClientBase,
  workspaceId: string,
  metric: UsageMetric,
  jobId: string,
): Promise<boolean> {
  const result = await tx.query(
    `WITH claimed AS (
       UPDATE usage_reservations
          SET state = 'released', settled_at = now()
        WHERE workspace_id = $1 AND metric = $2 AND job_id = $3 AND state = 'reserved'
      RETURNING period_start, quantity
     )
     UPDATE usage_counters c
        SET reserved_value = GREATEST(c.reserved_value - claimed.quantity, 0),
            updated_at     = now()
       FROM claimed
      WHERE c.workspace_id = $1 AND c.metric = $2 AND c.period_start = claimed.period_start`,
    [workspaceId, metric, jobId],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * AC9 — the internal-cost metrics: metered, never enforced.
 *
 * No reservation, and that is the difference rather than an omission. A
 * reservation holds capacity for an outcome that has not happened yet; embedding
 * and arbiter tokens are known only once they have been spent, so there is
 * nothing to hold. They go straight to `used_value` against an unlimited
 * ceiling, which is what "absorbed, never billed, but metered so a runaway is
 * visible" describes.
 */
export async function meterInternalUsage(
  tx: ClientBase,
  workspaceId: string,
  metric: UsageMetric,
  periodStart: string,
  quantity: number,
): Promise<void> {
  if (METRIC_SPECS[metric].customerFacing) {
    throw new Error(
      `metric '${metric}' is customer-facing and must go through reserveTierCap, not meterInternalUsage — ` +
        "counting it as used without a reservation would let a concurrent caller see capacity that is already spoken for.",
    );
  }
  if (quantity <= 0) {
    return;
  }
  await tx.query(
    `UPDATE usage_counters SET used_value = used_value + $4, updated_at = now()
      WHERE workspace_id = $1 AND metric = $2 AND period_start = $3`,
    [workspaceId, metric, periodStart, quantity],
  );
}

/**
 * The two warning thresholds: scoring-models.md §15 `quota_threshold`, "metered usage crosses 80% / 95%".
 *
 * STORY-068, owner decision 2026-10-23: 80 and 95 (STORY-070 shipped 80/90). `warned_at_95` arrived in migration 0135;
 * `warned_at_90` stays in the table (expand phase) and is no longer written.
 */
export const WARNING_THRESHOLDS = [80, 95] as const;

const WARNING_COLUMN: Readonly<Record<(typeof WARNING_THRESHOLDS)[number], string>> = { 80: "warned_at_80", 95: "warned_at_95" };

export type WarningThreshold = (typeof WARNING_THRESHOLDS)[number];

/**
 * AC8 — "Warning thresholds fire once per threshold per period, not per
 * request."
 *
 * The once-ness is in the `warned_at_NN IS NULL` predicate, not in application
 * code, so it holds across processes and across a restart. Whoever calls this
 * fires a notification for each threshold RETURNED, and a threshold is
 * returned exactly once per period because the statement that returns it is
 * the statement that stamps it.
 *
 * `limit_value > 0` excludes both an unlimited ceiling (-1, which nothing can
 * be 80% of) and a zero one (which is 80% consumed at zero usage, and would
 * warn a customer about an allowance they never had).
 *
 * The comparison is `used * 100 >= limit * NN` rather than `used / limit >=
 * NN/100` — integer arithmetic on bigints, with no float rounding deciding
 * whether a customer is warned.
 */
export async function crossedWarningThresholds(
  tx: ClientBase,
  workspaceId: string,
  metric: UsageMetric,
  periodStart: string,
): Promise<WarningThreshold[]> {
  const crossed: WarningThreshold[] = [];
  for (const threshold of WARNING_THRESHOLDS) {
    const column = WARNING_COLUMN[threshold];
    const result = await tx.query(
      `UPDATE usage_counters
          SET ${column} = now()
        WHERE workspace_id = $1 AND metric = $2 AND period_start = $3
          AND limit_value > 0
          AND ${column} IS NULL
          AND (used_value + reserved_value) * 100 >= limit_value * $4`,
      [workspaceId, metric, periodStart, threshold],
    );
    if ((result.rowCount ?? 0) === 1) {
      crossed.push(threshold);
    }
  }
  return crossed;
}

export async function readCounter(
  tx: ClientBase,
  workspaceId: string,
  metric: UsageMetric,
  periodStart: string,
): Promise<CounterState | undefined> {
  const result = await tx.query<{ limit_value: string; used_value: string; reserved_value: string }>(
    "SELECT limit_value, used_value, reserved_value FROM usage_counters WHERE workspace_id = $1 AND metric = $2 AND period_start = $3",
    [workspaceId, metric, periodStart],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        limitValue: Number(row.limit_value),
        usedValue: Number(row.used_value),
        reservedValue: Number(row.reserved_value),
      };
}

function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}
