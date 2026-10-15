import type { ClientBase } from "pg";

// STORY-070 AC11 — "Counters reset per period, and the reset is idempotent."
//
// A counter cannot reset without something saying when a period starts, and
// `usage_counters.period_start` is a bare `date` with nothing in the schema
// pointing at where it comes from. Three sources exist, and they are consulted
// in order of authority rather than convenience.

/**
 * The cycle a workspace's non-credit caps are counted against, as a `date`
 * string.
 *
 * THE ORDER IS THE POINT:
 *
 *   1. `credit_wallets.cycle_start` — once STORY-072 provisions wallets this
 *      is authoritative, and it is what makes the two allowances roll
 *      TOGETHER. A workspace whose credits reset on the 14th and whose PDF
 *      exports reset on the 1st has two "cycles", and every sentence written
 *      about "this cycle" becomes ambiguous.
 *
 *   2. `subscriptions.current_period_start` — the billing period Stripe is
 *      actually charging for, for a workspace that has a subscription but no
 *      wallet yet. Restricted to a LIVE subscription: a canceled row's period
 *      is history, and counting against it would put every counter in a period
 *      that never rolls.
 *
 *   3. The calendar month — a free workspace has no subscription and no
 *      wallet, and still has a `credits.lookups_per_day_max` tier and a
 *      fair-use ceiling to count against. Anchoring to the first of the month
 *      is arbitrary but stable, which is the only property a reset needs.
 *
 * A UTC date, deliberately, matching `credit_daily_counters.utc_date` and §3's
 * "3 capture-backed tool runs per UTC day". A period boundary that moved with
 * the workspace's timezone would let a counter reset twice on the day a
 * timezone setting changed.
 */
export interface BillingPeriod {
  /** `usage_counters.period_start`. */
  readonly start: string;
  /**
   * When the counters roll — what a `429 quota_exceeded` reports as
   * `resets_at`.
   *
   * A refusal whose remediation is "wait for the cycle" is only actionable if
   * it says when the cycle ends. §9 gives `quota_exceeded`'s sibling
   * `daily_limit_reached` a `resets_at` for exactly this reason, and a tier cap
   * without one leaves the customer told to wait for an unspecified date.
   */
  readonly end: string;
}

export async function resolveBillingPeriod(
  tx: ClientBase,
  workspaceId: string,
  now: Date = new Date(),
): Promise<BillingPeriod> {
  const result = await tx.query<{ period_start: string | null; period_end: string | null }>(
    `SELECT w.cycle_start::text        AS wallet_start,
            w.cycle_end::text          AS wallet_end,
            -- ⚠ THE UTC DAY, whatever the session's TimeZone. A bare timestamptz::date uses the session zone, and the
            -- roll (apply-plan.ts utcDate) names its cycle by the UTC day: in America/Los_Angeles an instant at
            -- 2026-10-01T00:00Z is 30 September, so the period derivation and the wallet would name different days.
            (s.current_period_start AT TIME ZONE 'UTC')::date::text AS sub_start,
            (s.current_period_end   AT TIME ZONE 'UTC')::date::text AS sub_end
       FROM (SELECT $1::uuid AS id) target
       LEFT JOIN credit_wallets w ON w.workspace_id = target.id
       LEFT JOIN LATERAL (
         SELECT current_period_start, current_period_end
           FROM subscriptions
          WHERE workspace_id = target.id
            AND status IN ('trialing','active','past_due')
          ORDER BY current_period_start DESC
          LIMIT 1
       ) s ON true`,
    [workspaceId],
  );

  const row = result.rows[0] as unknown as
    | { wallet_start: string | null; wallet_end: string | null; sub_start: string | null; sub_end: string | null }
    | undefined;

  const start = row?.wallet_start ?? row?.sub_start ?? null;
  const end = row?.wallet_start !== null && row?.wallet_start !== undefined ? row.wallet_end : (row?.sub_end ?? null);

  // Both halves come from the SAME source or from neither. Mixing a wallet's
  // start with a subscription's end would produce a period that is not any
  // real cycle, and every "resets on" sentence built from it would be wrong.
  return start !== null && end !== null && end !== undefined
    ? { start, end }
    : { start: calendarMonthStart(now), end: nextCalendarMonthStart(now) };
}

/** The first of `now`'s UTC month, as `YYYY-MM-DD`. */
export function calendarMonthStart(now: Date): string {
  return `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** The first of the FOLLOWING UTC month — when a calendar-month period rolls. */
export function nextCalendarMonthStart(now: Date): string {
  const year = now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 11 ? 1 : now.getUTCMonth() + 2;
  return `${String(year)}-${String(month).padStart(2, "0")}-01`;
}
