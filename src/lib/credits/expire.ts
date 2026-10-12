import type { ClientBase, Pool, PoolClient } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { expireCredits } from "./balance.js";

// STORY-076 AC4 / STORY-073 AC12 — scheduled FIFO expiry of purchased credits.
//
// `plans-and-entitlements.md` §5: "Purchased rollover — 12 months from purchase, FIFO by expiry. Expiry writes an
// `expire` ledger entry." `schemas/billing-and-credits.md`: "Expiry is FIFO by `expires_at` and writes an `expire`
// ledger entry, so the balance change is always explicable."
//
// `expireCredits` (balance.ts) is the ledger half and has existed, tested, since STORY-073. Nothing decided HOW MANY
// credits to pass it, and nothing called it, so a purchased credit never expired. This is the deciding half.
//
// ⚠ HOW MANY — THE ACCOUNTING, because the wallet holds ONE `purchased_balance` and not a balance per lot.
//
//   P  the wallet's purchased balance now.
//   T  every credit that ever entered the purchased bucket and is not an expiry candidate's consumption:
//        - credits landed by a SUCCEEDED purchase (`credit_purchases.status = 'succeeded'`), one lot each, PLUS
//        - net-positive `adjustment` entries on the purchased bucket (a goodwill credit): credits with NO lot and NO
//          expiry. They are treated as non-expiring lots, the youngest of all.
//   E  the part of T whose lot has elapsed (`expires_at <= now()`). Adjustments are never in E.
//
// WHY THE ADJUSTMENTS MUST BE IN T. `consumed = T - P` is only true if every credit that raised P is in T. A positive
// adjustment raised P without raising T, so it read as NEGATIVE consumption and inflated `E - consumed`: lot 100
// elapsed, 100 spent, +100 goodwill, and the sweep expired the goodwill. Only POSITIVE adjustment entries are added; a
// negative adjustment is a debit and stays consumption (oldest lot first), exactly like a spend.
//
// THE OTHER WAYS CREDITS REACH THE PURCHASED BUCKET (decision, from the ledger's entry types):
//   purchase     only the Stripe credit-pack handler writes it, in the same transaction that marks the lot
//                `succeeded`, so every `purchase` entry has a lot. In T through the lot.
//   refund       `run-settlement` and `undo` put back credits a run debit took from the bucket. That is the reversal of
//                a consumption, so it is deliberately NOT added to T: it lowers `T - P` and the credits return to the
//                oldest lot's remainder, as if never spent. (If that lot has elapsed they can expire; if the debit
//                came from a younger lot that is a known, bounded over-expiry of an undo that straddles an elapsed
//                lot, accepted because the alternative, tracking per-lot balances, is a schema change.)
//   grant        included bucket only.
//   release      moves `reserved`, never a balance.
// A NEW code path that credits the purchased bucket without a lot MUST be added here, or it will be expired as one.
//
// Spending is oldest-lot-first (FIFO by expiry), so whatever has left the bucket — spent, expired before, or
// adjusted away — came out of the OLDEST lots first. Everything that is not in P is therefore consumption:
// `consumed = T - P`. The elapsed lots are the oldest, so what remains of them is `E - consumed`, and that — never
// more than P — is what has expired and not yet been taken.
//
//   expirable = min( P,  max(0, E - max(0, T - P)),  included + P - reserved )
//
// It is a RECOMPUTATION, not an increment, which is what makes it idempotent without a marker: after an expiry the
// entry has lowered P by exactly what it took, so `T - P` has risen by the same and the next run finds zero. A
// redelivered job, a second replica and a retry after a crash all arrive at the same answer.
//
// ⚠ THE THIRD TERM IS A SAFETY, NOT A POLICY. `ck_wallet_reserved` makes `reserved <= included + purchased`, and a
// reservation is a hold on credits an in-flight action will commit. Expiring the credits under a live hold would
// either violate the constraint (the sweep fails) or strand the action. So the sweep takes what it can without
// touching the hold and the next run — after the action commits or the reconciler releases it — takes the rest.
//
// ⚠ THE LEDGER KEY IS MONOTONIC PER EXPIRY: `expire:purchased:<cumulative credits expired from the bucket, including
// this entry>`. A day-and-amount key collided whenever two expiries on one day were the same size (a hold released
// after a partial expiry), and the collision rolled the second expiry back silently. The cumulative total strictly
// rises with every applied entry, so two different expiries never share a key, and a redelivery of the same one
// (same cumulative total) is refused by the unique index.
//
// ⚠ IT ERRS TOWARD UNDER-EXPIRING, deliberately: `P` bounds the answer, and the live lots (and adjustments) are the
// youngest, consumed last. A lot with no `expires_at` (a sales grant) is in T and never in E for the same reason.
//
// ⚠ INCLUDED CREDITS ARE NOT THIS JOB'S. Included expiry is the cycle-end grant refresh (STORY-075), which resets
// the bucket rather than expiring a lot of it.
//
// ⚠ TWO CONNECTIONS, for the reason `reconcile.ts` gives: `credit_purchases` and `credit_wallets` carry FORCE ROW
// LEVEL SECURITY, so a cross-tenant DISCOVERY on the runtime role sees nothing and reports a clean run over an estate
// full of elapsed lots. Discovery is the privileged connection; each expiry is an ordinary tenant-scoped write.

export interface ExpiryConnections {
  /** MUST bypass RLS — a cross-tenant scan. See above. */
  readonly discovery: ClientBase;
  /** The runtime pool; each workspace's expiry runs in `withTenantContext` for it. */
  readonly work: Pool;
}

export interface ExpiryOutcome {
  /** Workspaces with at least one elapsed succeeded lot and a purchased balance (or no wallet, which fails). */
  readonly workspacesChecked: number;
  /** Of those, the ones that actually had credits to expire. */
  readonly workspacesExpired: number;
  readonly creditsExpired: number;
  readonly failures: readonly { workspaceId: string; reason: string }[];
}

interface WalletRow {
  purchased_balance: string;
  included_balance: string;
  reserved: string;
}

/**
 * The pure arithmetic, exported so the three terms can be pinned without a database.
 * Inputs are non-negative integers; the result is a non-negative integer.
 */
export function expirableCredits(input: {
  readonly purchased: number;
  readonly included: number;
  readonly reserved: number;
  readonly elapsedLots: number;
  /** Every credit that entered the bucket as a lot or a net-positive adjustment (adjustments are never elapsed). */
  readonly allLots: number;
}): number {
  const consumed = Math.max(0, input.allLots - input.purchased);
  const remainingOfElapsed = Math.max(0, input.elapsedLots - consumed);
  const headroom = Math.max(0, input.included + input.purchased - input.reserved);
  return Math.max(0, Math.min(input.purchased, remainingOfElapsed, headroom));
}

export async function expireDuePurchasedCredits(connections: ExpiryConnections): Promise<ExpiryOutcome> {
  // Only workspaces that HAVE an elapsed succeeded lot are opened at all: the common night is a no-op.
  // ...and of those, only wallets that still HOLD purchased credits: once a workspace's bucket is empty its old elapsed
  // lot has nothing left to expire, and must not be reopened every night forever. The LEFT JOIN keeps a workspace with
  // NO wallet row in the list on purpose: that is a sequencing bug the sweep reports as a failure, not a skip.
  const due = await connections.discovery.query<{ workspace_id: string }>(
    `SELECT DISTINCT p.workspace_id
       FROM credit_purchases p
       LEFT JOIN credit_wallets w ON w.workspace_id = p.workspace_id
      WHERE p.status = 'succeeded' AND p.expires_at IS NOT NULL AND p.expires_at <= now()
        AND (w.workspace_id IS NULL OR w.purchased_balance > 0)
      ORDER BY p.workspace_id`,
  );

  let workspacesExpired = 0;
  let creditsExpired = 0;
  const failures: { workspaceId: string; reason: string }[] = [];

  for (const { workspace_id: workspaceId } of due.rows) {
    // Checked out INSIDE the try (reconcile.ts): a pool timeout partway through must not discard the outcome of the
    // workspaces already expired.
    let client: PoolClient | undefined;
    try {
      client = await connections.work.connect();
      const expired = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        expireForWorkspace(tx, workspaceId),
      );
      if (expired > 0) {
        workspacesExpired += 1;
        creditsExpired += expired;
      }
    } catch (error) {
      // One workspace's failure never stops the rest; the next run retries it.
      failures.push({ workspaceId, reason: error instanceof Error ? error.message : String(error) });
    } finally {
      client?.release();
    }
  }

  return { workspacesChecked: due.rows.length, workspacesExpired, creditsExpired, failures };
}

/** One workspace, inside its own tenant transaction. Returns the credits expired (0 = nothing to do). */
async function expireForWorkspace(tx: ClientBase, workspaceId: string): Promise<number> {
  // THE WALLET ROW LOCK FIRST. The lot arithmetic reads P, and a spend between that read and the expiry would make it
  // stale; `FOR UPDATE` serialises this against every reserve, commit and release on the wallet, and against a second
  // sweep, which then recomputes against the post-expiry balance and finds nothing. It is also the order `balance.ts`
  // requires (wallet lock before the ledger row draws its `seq`).
  const wallet = await tx.query<WalletRow>(
    `SELECT purchased_balance::text, included_balance::text, reserved::text
       FROM credit_wallets WHERE workspace_id = $1 FOR UPDATE`,
    [workspaceId],
  );
  const row = wallet.rows[0];
  if (row === undefined) {
    // NOT A SKIP. An elapsed lot with no wallet to take credits from is a sequencing bug the operator must see.
    throw new Error(`workspace ${workspaceId} has elapsed credit lots and no credit wallet`);
  }

  const lots = await tx.query<{ elapsed: string; total: string; newest_elapsed_id: string | null }>(
    `SELECT coalesce(sum(credits) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now()), 0)::text AS elapsed,
            coalesce(sum(credits), 0)::text AS total,
            (array_agg(id ORDER BY expires_at DESC, id) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now()))[1]::text
              AS newest_elapsed_id
       FROM credit_purchases
      WHERE workspace_id = $1 AND status = 'succeeded'`,
    [workspaceId],
  );

  // Read under the wallet lock like everything above. Positive adjustments only: see the header.
  const ledger = await tx.query<{ adjusted: string; expired: string }>(
    `SELECT coalesce(sum(credits) FILTER (WHERE entry_type = 'adjustment' AND credits > 0), 0)::text AS adjusted,
            coalesce(sum(credits) FILTER (WHERE entry_type = 'expire'), 0)::text AS expired
       FROM credit_ledger
      WHERE workspace_id = $1 AND bucket = 'purchased' AND entry_type IN ('adjustment', 'expire')`,
    [workspaceId],
  );

  const amount = expirableCredits({
    purchased: Number(row.purchased_balance),
    included: Number(row.included_balance),
    reserved: Number(row.reserved),
    elapsedLots: Number(lots.rows[0]!.elapsed),
    allLots: Number(lots.rows[0]!.total) + Number(ledger.rows[0]!.adjusted),
  });
  if (amount === 0) return 0;

  const newestElapsedLot = lots.rows[0]!.newest_elapsed_id;
  const expiredAfter = Number(ledger.rows[0]!.expired) + amount;
  const outcome = await expireCredits(
    tx,
    {
      workspaceId,
      idempotencyKey: `expire:purchased:${String(expiredAfter)}`,
      actorId: null,
      actorType: "system",
      // The newest elapsed lot this entry covers; the ledger's reference is a single id.
      ...(newestElapsedLot === null ? {} : { referenceType: "credit_purchase", referenceId: newestElapsedLot }),
    },
    "purchased",
    amount,
  );
  return outcome.applied ? amount : 0;
}
