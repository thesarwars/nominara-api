import type { ClientBase } from "pg";

// STORY-072 — `plans-and-entitlements.md` §6's reserve → commit → release.
//
// ⚠ THE SINGLE CONDITIONAL STATEMENT IS THE ENTIRE CONCURRENCY DESIGN, and
// every other choice in this file is downstream of it. The story: "reading a
// balance, deciding, and then writing is a race with a window; putting the
// sufficiency test in the predicate makes the DATABASE the arbiter. The loser
// gets zero rows and a clean refusal, with no compensating action needed."
//
// The realistic failure is two operators confirming the same expensive action
// against a balance that covers one, and the damage is a negative balance
// nobody notices until reconciliation. §6's four statements are transcribed
// here rather than reinterpreted.

export interface WalletState {
  readonly includedBalance: number;
  readonly purchasedBalance: number;
  readonly reserved: number;
  /** What a new reservation can draw on — the figure every refusal quotes. */
  readonly available: number;
  readonly cycleEnd: string;
}

/** Which of the two balances a movement touches. Mirrors `credit_ledger.bucket`. */
export type CreditBucket = "included" | "purchased";

/** The running totals a movement may also count itself into. */
export type LifetimeCounter = "granted" | "purchased" | null;

const BUCKET_COLUMN: Readonly<Record<CreditBucket, string>> = Object.freeze({
  included: "included_balance",
  purchased: "purchased_balance",
});

const LIFETIME_COLUMN: Readonly<Record<"granted" | "purchased", string>> = Object.freeze({
  granted: "lifetime_granted",
  purchased: "lifetime_purchased",
});

export interface ProvisionOutcome {
  /**
   * The wallet as this call created it, or null when one was already there.
   *
   * ⚠ NULL MEANS "ALREADY EXISTED", not "absent" — the opposite of
   * `readWallet`'s null, which is why it is spelled out here. An earlier
   * version carried a separate `created` boolean beside it; the two could
   * only ever agree, so a caller checking the wrong one was an equivalent
   * mutant no test could kill. One field, one meaning.
   */
  readonly created: WalletState | null;
}

export interface ReserveOutcome {
  readonly ok: boolean;
  /** Present only on success — the state after the reservation. */
  readonly wallet: WalletState | null;
}

interface WalletRow {
  included_balance: string;
  purchased_balance: string;
  reserved: string;
  cycle_end: string;
}

/**
 * ⚠ `cycle_end` IS FORMATTED BY POSTGRES, never by `Date.toISOString()`.
 *
 * A `date` column comes back from pg as a `Date` at LOCAL midnight, so
 * extracting the day through an ISO string shifts it west of Greenwich:
 *
 *   TZ=UTC              2026-10-15   TZ=Asia/Dhaka       2026-10-14
 *   TZ=America/New_York 2026-10-15   TZ=Europe/Berlin    2026-10-14
 *
 * The figure reaches `x-nominara-credits-cycle-end` and the `402` payload's
 * `details.wallet.cycle_end`, so "expires in N days" renders a day early for
 * an EU-residency deployment — a supported region — and for anyone running
 * the server east of UTC.
 *
 * This is the same trap the integration suite hit and worked around IN THE
 * TEST ONLY; the second-engineer review caught that the production path kept
 * the bug. Every query below asks for `to_char` so there is no Date to
 * mis-format.
 */
const WALLET_COLUMNS = `included_balance, purchased_balance, reserved,
                        to_char(cycle_end, 'YYYY-MM-DD') AS cycle_end`;

function toWalletState(row: WalletRow): WalletState {
  const included = Number(row.included_balance);
  const purchased = Number(row.purchased_balance);
  const reserved = Number(row.reserved);
  return {
    includedBalance: included,
    purchasedBalance: purchased,
    reserved,
    available: included + purchased - reserved,
    cycleEnd: row.cycle_end,
  };
}

/**
 * §6 STEP 1 — ONE conditional UPDATE, race-free. Zero rows means insufficient
 * balance AND NOTHING WAS RESERVED.
 *
 * The sufficiency test lives in the `WHERE`, so two concurrent reservations
 * against a balance that covers one cannot both win: Postgres serialises the
 * writes on the row, the second re-evaluates the predicate against the
 * first's committed effect, and matches nothing.
 *
 * NO `FOR UPDATE` AND NO PRIOR READ, deliberately. A read-then-write with a
 * lock would work and would be slower and easier to get wrong — the window
 * between the read and the write is exactly what an explicit lock exists to
 * close, and a predicate has no window to close.
 */
export async function reserveCredits(tx: ClientBase, workspaceId: string, amount: number): Promise<ReserveOutcome> {
  assertPositiveInteger(amount, "reserve");

  const result = await tx.query<WalletRow>(
    `UPDATE credit_wallets
        SET reserved = reserved + $2, updated_at = now()
      WHERE workspace_id = $1
        AND (included_balance + purchased_balance - reserved) >= $2
     RETURNING ${WALLET_COLUMNS}`,
    [workspaceId, amount],
  );

  const row = result.rows[0];
  return row === undefined ? { ok: false, wallet: null } : { ok: true, wallet: toWalletState(row) };
}

/**
 * §6 STEP 2 — COMMIT the actual amount, releasing the FULL original
 * reservation.
 *
 * ⚠ `committed` MAY BE LESS THAN `reserved`, and the difference is released
 * by the same statement rather than by a second call. AC5: a per-unit action
 * commits what it used; "a FLAT-PRICED action commits exactly what it
 * reserved, with no partial commit", which callers express by passing the
 * same number twice.
 *
 * EXPIRING BUCKET FIRST — AC4, and it is a customer-favouring default with a
 * real consequence. Spending durable purchased credits first would let
 * granted credits lapse at cycle end while the ones the customer paid for
 * were consumed, which is quietly extractive.
 *
 * The `reserved >= $3` predicate is not in §6 and is added deliberately: a
 * double commit would drive `reserved` negative, and the schema's own CHECK
 * would turn a bookkeeping bug into a failed request on an action that had
 * already succeeded. Zero rows is the honest answer to "commit something that
 * is not reserved".
 */
export async function commitCredits(
  tx: ClientBase,
  workspaceId: string,
  committed: number,
  reserved: number,
): Promise<WalletState | null> {
  assertNonNegativeInteger(committed, "commit");
  assertPositiveInteger(reserved, "commit reservation");
  if (committed > reserved) {
    throw new Error(`cannot commit ${String(committed)} against a reservation of ${String(reserved)}`);
  }

  const result = await tx.query<WalletRow>(
    `WITH split AS (
       SELECT LEAST(included_balance, $2::int) AS from_included,
              GREATEST($2::int - LEAST(included_balance, $2::int), 0) AS from_purchased
         FROM credit_wallets WHERE workspace_id = $1 FOR UPDATE
     )
     UPDATE credit_wallets w
        SET included_balance  = w.included_balance  - s.from_included,
            purchased_balance = w.purchased_balance - s.from_purchased,
            reserved          = w.reserved - $3,
            lifetime_spent    = w.lifetime_spent + $2,
            updated_at        = now()
       FROM split s
      WHERE w.workspace_id = $1
        AND w.reserved >= $3
     RETURNING w.included_balance, w.purchased_balance, w.reserved,
               to_char(w.cycle_end, 'YYYY-MM-DD') AS cycle_end`,
    [workspaceId, committed, reserved],
  );

  const row = result.rows[0];
  return row === undefined ? null : toWalletState(row);
}

/**
 * §6 STEP 3 — RELEASE on failure, cancellation, or the unused portion.
 *
 * `GREATEST(reserved - $2, 0)` is §6's own clamp and it is AC6: releasing
 * twice must not drive `reserved` below zero. A clamp rather than a guard
 * because a double release is a retry, not a bug to surface — the second one
 * is correct to be a no-op.
 */
export async function releaseCredits(tx: ClientBase, workspaceId: string, amount: number): Promise<void> {
  assertPositiveInteger(amount, "release");
  await tx.query(
    `UPDATE credit_wallets
        SET reserved = GREATEST(reserved - $2, 0), updated_at = now()
      WHERE workspace_id = $1`,
    [workspaceId, amount],
  );
}

/**
 * Create the wallet row if this workspace has none.
 *
 * ⚠ NOTHING ELSE IN THE PRODUCT EVER CREATED ONE. There is no other
 * `INSERT INTO credit_wallets` anywhere in `src/`, and workspace creation
 * says in a comment that it deliberately does not touch the table. §6 assumes
 * the row exists and never says who makes it, so before this every workspace
 * had no wallet and the first request to a priced route would have found
 * none.
 *
 * ON THE REQUEST PATH, not in a nightly job, for the reason
 * `provisionUsageCounters` gives about tier caps: a scheduled provisioner
 * leaves a window in which a cycle has begun and the row does not exist yet,
 * and every request inside that window fails. Idempotent by construction, so
 * the common path is one `ON CONFLICT DO NOTHING` that touches nothing.
 *
 * THE GRANT IS NOT RE-APPLIED HERE. This creates a missing row and nothing
 * else — an existing wallet is left exactly as it is. Topping one up is the
 * subscription lifecycle's job and getting it wrong mints credits, which is
 * precisely what the removed `refreshIncludedGrant` did.
 */
export async function provisionWallet(
  tx: ClientBase,
  workspaceId: string,
  grant: number,
  cycle: { readonly start: string; readonly end: string },
): Promise<ProvisionOutcome> {
  assertNonNegativeInteger(grant, "grant");
  const result = await tx.query<WalletRow>(
    `INSERT INTO credit_wallets
       (workspace_id, included_balance, purchased_balance, reserved, lifetime_granted, cycle_start, cycle_end)
     -- BOTH USES OF $2 ARE CAST. included_balance is integer and
     -- lifetime_granted is bigint, and Postgres refuses to deduce one type
     -- for a parameter used as both: "inconsistent types deduced for
     -- parameter $2".
     VALUES ($1, $2::int, 0, 0, $2::bigint, $3::date, $4::date)
     ON CONFLICT (workspace_id) DO NOTHING
     RETURNING ${WALLET_COLUMNS}`,
    [workspaceId, grant, cycle.start, cycle.end],
  );

  // ⚠ RETURNING IS EMPTY ON A CONFLICT, which is exactly the signal the
  // caller needs: it distinguishes "this call minted the grant" from "a
  // wallet was already here". STORY-073 needs it because the grant has to be
  // accounted for in the ledger, and accounting for it twice is minting
  // credits — see `provisionWalletWithGrant`.
  const row = result.rows[0];
  return { created: row === undefined ? null : toWalletState(row) };
}

/**
 * Move ONE balance by a signed delta, optionally counting it into a lifetime
 * total — the statement behind `grant`, `purchase`, `expire`, `refund` and
 * `adjustment`.
 *
 * ⚠ THE COLUMN NAMES COME FROM A CLOSED LOOKUP, NEVER FROM THE ARGUMENT.
 * `bucket` and `lifetime` are unions, and the SQL is assembled from constants
 * indexed by them. A template that interpolated the caller's string would be
 * an injection site in the one table where it would be least visible.
 *
 * ⚠ IT CAN FAIL, AND THAT IS THE POINT. `ck_wallet_nonneg` refuses a balance
 * below zero and `ck_wallet_reserved` refuses one that drops under what is
 * currently reserved — so expiring credits out from under a live reservation
 * raises rather than quietly succeeding at the wrong number. The caller sees
 * a constraint violation, which is the honest answer to "take away credits
 * that are already spoken for".
 *
 * Returns null when the workspace has no wallet row.
 */
export async function applyBucketDelta(
  tx: ClientBase,
  workspaceId: string,
  bucket: CreditBucket,
  delta: number,
  lifetime: LifetimeCounter = null,
): Promise<WalletState | null> {
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error(`bucket delta must be a non-zero integer, received ${String(delta)}`);
  }

  const column = BUCKET_COLUMN[bucket];
  const lifetimeClause = lifetime === null ? "" : `, ${LIFETIME_COLUMN[lifetime]} = ${LIFETIME_COLUMN[lifetime]} + $2`;

  const result = await tx.query<WalletRow>(
    `UPDATE credit_wallets
        SET ${column} = ${column} + $2${lifetimeClause}, updated_at = now()
      WHERE workspace_id = $1
     RETURNING ${WALLET_COLUMNS}`,
    [workspaceId, delta],
  );

  const row = result.rows[0];
  return row === undefined ? null : toWalletState(row);
}

/**
 * Take the workspace's wallet row lock, and nothing else.
 *
 * ⚠ THIS IS HOW TWO SETTLEMENT PATHS AGREE ON WHAT IS STILL HELD. Every
 * statement in this file already locks the row on its way to moving a
 * balance, which serialises the MOVEMENTS — but a path that reads the ledger
 * to decide whether to move at all is a check-then-act, and the window
 * between them is where a reservation gets released twice, or committed
 * after the reconciler already swept it.
 *
 * The second-engineer review reproduced both: the reconciler and the
 * interceptor each released the same hold, destroying 40 credits of an
 * unrelated live reservation; and a swept reservation was committed anyway,
 * because `commitCredits` tests the workspace's AGGREGATE `reserved` and
 * could not tell whose hold it was eating.
 *
 * Taking the lock BEFORE the ledger read closes both. Returns false when the
 * workspace has no wallet row.
 */
export async function lockWallet(tx: ClientBase, workspaceId: string): Promise<boolean> {
  const result = await tx.query(`SELECT 1 FROM credit_wallets WHERE workspace_id = $1 FOR UPDATE`, [workspaceId]);
  return (result.rowCount ?? 0) > 0;
}

export async function readWallet(tx: ClientBase, workspaceId: string): Promise<WalletState | null> {
  const result = await tx.query<WalletRow>(
    `SELECT ${WALLET_COLUMNS}
       FROM credit_wallets WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toWalletState(row);
}

/**
 * Whether the wallet's cycle has ALREADY ENDED without being rolled.
 *
 * ⚠ NOTHING IN `src/` WRITES `cycle_end` AFTER `provisionWallet`. The roll is
 * STORY-075/076's, so every wallet still carries the date it was provisioned
 * against, and a workspace provisioned in August reports a cycle ending in
 * August. Read straight through, that turns a date six weeks in the past into
 * a future expiry deadline on the billing screen.
 *
 * ⚠ COMPARED IN POSTGRES, NEVER AGAINST A JS `Date`. The reconciler's grace
 * window was written the other way first and found zero orphans, because the
 * two clocks are not the same clock. `CURRENT_DATE` is the database's own
 * day, which is the day `cycle_end` was written against.
 */
export async function cycleHasLapsed(tx: ClientBase, workspaceId: string): Promise<boolean> {
  const result = await tx.query<{ lapsed: boolean }>(
    `SELECT cycle_end < CURRENT_DATE AS lapsed FROM credit_wallets WHERE workspace_id = $1`,
    [workspaceId],
  );
  return result.rows[0]?.lapsed ?? false;
}

export interface PurchasableOption {
  readonly key: string;
  readonly displayName: string;
  readonly credits: number;
  readonly priceUsd: string;
  readonly currency: string;
  /** Lowest plan that may buy it; null = every tier. */
  readonly minPlanKey: string | null;
  /** The catalog position (`credit_packs.sort_order`); the first element of the list cursor's sort key. */
  readonly sortOrder: number;
}

/**
 * AC9 — the purchasable options, FILTERED TO THE WORKSPACE'S TIER.
 *
 * A refusal that offered a pack the customer cannot buy would turn a
 * remediable failure into a dead end: they would click through to a purchase
 * flow that refuses them for a second, unrelated reason. The filter is the
 * same plan-order comparison `lowestPricedPlan` makes, done IN THE DATABASE
 * so a plan change needs no redeploy.
 */
export async function purchasableOptions(tx: ClientBase, workspaceId: string): Promise<PurchasableOption[]> {
  const result = await tx.query<{
    key: string;
    display_name: string;
    credits: string;
    price_usd: string;
    currency: string;
    min_plan_key: string | null;
    sort_order: number;
  }>(
    `SELECT p.key, p.display_name, p.credits::text, p.price_usd::text, p.currency, p.min_plan_key, p.sort_order
       FROM credit_packs p
       JOIN workspaces w ON w.id = $1
       JOIN plans workspace_plan ON workspace_plan.key = w.plan_key
       LEFT JOIN plans pack_plan ON pack_plan.key = p.min_plan_key
      WHERE p.is_public
        AND (p.min_plan_key IS NULL OR pack_plan.sort_order <= workspace_plan.sort_order)
      ORDER BY p.sort_order ASC, p.credits ASC`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    key: row.key,
    displayName: row.display_name,
    credits: Number(row.credits),
    priceUsd: row.price_usd,
    currency: row.currency,
    minPlanKey: row.min_plan_key,
    sortOrder: row.sort_order,
  }));
}

/**
 * ⚠ `refreshIncludedGrant` WAS HERE AND HAS BEEN REMOVED.
 *
 * It clamped with `GREATEST(included_balance, grant)` and cited §5's
 * mid-cycle top-up. The second-engineer review showed that is not §5's rule:
 * §5 tops up by `(new_grant − old_grant) × days_remaining / cycle_days`
 * against the OLD GRANT, and the clamp compared against the REMAINING
 * BALANCE — a different quantity, with no proration at all.
 *
 * The reproduction: a customer on a 1,200 grant who has spent 1,100 has 100
 * left; any same-cycle resync — an entitlement refresh, a plan-change webhook
 * redelivery, a Stripe retry — took them back to 1,200 and added 1,100 to
 * `lifetime_granted`. Free credits minted by a retry.
 *
 * It had NO PRODUCTION CALLER, so removing it costs nothing today. Grant
 * refresh belongs with the subscription lifecycle that knows the prior grant
 * and the cycle position — STORY-075 — and implementing §5's formula here
 * from a signature that cannot see the old grant would be guessing.
 */

function assertPositiveInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${what} must be a positive integer, received ${String(value)}`);
  }
}

function assertNonNegativeInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative integer, received ${String(value)}`);
  }
}
