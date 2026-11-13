import type { ClientBase } from "pg";
/** `credit_daily_counters.action_code`, verbatim. A route cannot invent a fourth family and quietly get its own allowance. */
export type DailyCapAction = "lookup" | "nlp_command";

/**
 * The entitlement each family's limit is read from - plans-and-entitlements.md section 2's table. A MAP RATHER THAN A CONVENTION: the two naming
 * schemes already diverge (`lookup` reads `credits.lookups_per_day_max`).
 */
export const DAILY_CAP_ENTITLEMENT: Readonly<Record<DailyCapAction, string>> = Object.freeze({
  lookup: "credits.lookups_per_day_max",
  nlp_command: "credits.nlp_parses_per_day_max",
});

// STORY-071 — the daily counter, `plans-and-entitlements.md` §6 STEP 0.
//
// A RATE BOUND, NOT A COST ALLOWANCE, and everything here follows from that.
// The story: "a monthly allowance alone lets a scripted account consume the
// entire month in an hour, which converts a small marketing cost into an
// unbounded one. The daily cap makes the exposure per-day rather than
// per-month, AND NO AMOUNT OF PURCHASING CHANGES THAT."
//
// So this touches `credit_daily_counters` and never `credit_wallets`. A
// workspace with a wallet full from a purchased pack is bound by exactly the
// same row as one with nothing in it — there is no code path here that could
// read a balance even if someone wanted it to.

export interface DailyCapOutcome {
  /** How many of today's allowance are left AFTER this action. */
  readonly remainingToday: number;
  readonly limit: number;
  readonly used: number;
}

/**
 * §6 STEP 0, verbatim — ONE CONDITIONAL UPSERT with the limit test in its
 * predicate.
 *
 * AC2 and AC10 are the same requirement seen from two sides: a read-then-write
 * would let two concurrent requests both observe `used = limit - 1` and both
 * proceed, so the cap would bind at `limit + 1` under exactly the burst it
 * exists to stop. Putting the test in the `DO UPDATE ... WHERE` makes the
 * check and the increment one atomic statement, and Postgres serialises the
 * conflicting upserts on the row.
 *
 * NULL when exhausted — zero rows come back, which is the refusal.
 */
export async function incrementDailyCounter(
  tx: ClientBase,
  workspaceId: string,
  action: DailyCapAction,
  limit: number,
): Promise<DailyCapOutcome | null> {
  const result = await tx.query<{ remaining_today: string; used_count: string; limit_count: string }>(
    `INSERT INTO credit_daily_counters (workspace_id, utc_date, action_code, used_count, limit_count)
     VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2, 1, $3)
     ON CONFLICT (workspace_id, utc_date, action_code) DO UPDATE
        SET used_count = credit_daily_counters.used_count + 1,
            -- AC8 — the limit is re-resolved on every write, so a mid-day
            -- upgrade takes effect on the next action rather than at the
            -- next UTC midnight. Without this the row would hold the limit
            -- the day STARTED on, and an upgrade a customer just paid for
            -- would do nothing until tomorrow.
            limit_count = EXCLUDED.limit_count,
            updated_at = now()
      WHERE credit_daily_counters.used_count < EXCLUDED.limit_count
     RETURNING limit_count - used_count AS remaining_today, used_count, limit_count`,
    [workspaceId, action, limit],
  );

  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    remainingToday: Number(row.remaining_today),
    used: Number(row.used_count),
    limit: Number(row.limit_count),
  };
}

/**
 * AC6's compensation — give the increment back.
 *
 * "The counter increments before the wallet reservation, and A WALLET FAILURE
 * COMPENSATES THE INCREMENT. Otherwise a user with no credits burns their
 * allowance discovering they have none."
 *
 * The reverse order is the tempting one and is wrong: reserving first would
 * let a user with no credits attempt repeatedly, each failing at the wallet,
 * without ever consuming their allowance — which sounds fair until you notice
 * the daily cap then bounds nothing. Incrementing first bounds ATTEMPTS;
 * compensating keeps a genuine empty-wallet case from being punished for it.
 *
 * ⚠ COMPENSATED, NOT ROLLED BACK. The increment and the wallet reservation do
 * not share a transaction — the reservation happens later in the request, and
 * by then the counter's statement has long committed so that a concurrent
 * request could see it. A decrement is the only correct undo, and the
 * `used_count >= 1` guard is what stops a double compensation driving the row
 * negative past its own CHECK.
 */
export async function compensateDailyCounter(
  tx: ClientBase,
  workspaceId: string,
  action: DailyCapAction,
): Promise<void> {
  await tx.query(
    `UPDATE credit_daily_counters
        SET used_count = used_count - 1, updated_at = now()
      WHERE workspace_id = $1
        AND utc_date = (now() AT TIME ZONE 'UTC')::date
        AND action_code = $2
        AND used_count >= 1`,
    [workspaceId, action],
  );
}

/**
 * §1's `X-Nominara-Daily-Resets-At` — the next UTC midnight.
 *
 * UTC AND NOT THE WORKSPACE'S ZONE, deliberately, and it is the one place in
 * the product where that is right. `credit_daily_counters.utc_date` is the
 * column's own name and the primary key's own component; a reset time in a
 * local zone would name an instant at which the row does not roll over, and
 * the customer would watch the clock pass it with nothing changing.
 */
export function nextUtcMidnight(now: Date): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return new Date(midnight).toISOString();
}

/**
 * AC12 — rows older than the retention window are purged nightly.
 *
 * The counter's only job is bounding TODAY. Yesterday's row is read by
 * nothing: the upsert keys on today's date, and a refusal quotes the limit
 * from the row it just tried to write. Keeping them would grow a row per
 * workspace per action per day forever to answer a question nobody asks.
 */
export async function purgeDailyCounters(tx: ClientBase, retainDays: number): Promise<number> {
  const result = await tx.query(
    `DELETE FROM credit_daily_counters
      WHERE utc_date < (now() AT TIME ZONE 'UTC')::date - make_interval(days => $1::int)`,
    [retainDays],
  );
  return result.rowCount ?? 0;
}

/** How long a counter row is kept. Long enough to answer a support question, no longer. */
export const DAILY_COUNTER_RETAIN_DAYS = 35;
