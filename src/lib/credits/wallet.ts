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
): Promise<void> {
  assertNonNegativeInteger(grant, "grant");
  await tx.query(
    `INSERT INTO credit_wallets
       (workspace_id, included_balance, purchased_balance, reserved, lifetime_granted, cycle_start, cycle_end)
     -- BOTH USES OF $2 ARE CAST. included_balance is integer and
     -- lifetime_granted is bigint, and Postgres refuses to deduce one type
     -- for a parameter used as both: "inconsistent types deduced for
     -- parameter $2".
     VALUES ($1, $2::int, 0, 0, $2::bigint, $3::date, $4::date)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId, grant, cycle.start, cycle.end],
  );
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

export interface PurchasableOption {
  readonly key: string;
  readonly displayName: string;
  readonly credits: number;
  readonly priceUsd: string;
  readonly currency: string;
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
  }>(
    `SELECT p.key, p.display_name, p.credits::text, p.price_usd::text, p.currency
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
