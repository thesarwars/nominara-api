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
//   T  every credit ever landed by a SUCCEEDED purchase (`credit_purchases.status = 'succeeded'`).
//   E  the part of T whose lot has elapsed (`expires_at <= now()`).
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
// ⚠ IT ERRS TOWARD UNDER-EXPIRING, deliberately. Credits that return to the bucket (a refund, an adjustment) lower
// `T - P` and so leave more of an elapsed lot expirable, never less of a live one; a credit the customer still owns
// under a live lot is never expired, because `P` bounds the answer and the live lots are the youngest, consumed last.
// A lot with no `expires_at` (a sales grant) is in T and never in E: it is the youngest by construction.
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
  /** Workspaces with at least one elapsed succeeded lot. */
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
  readonly allLots: number;
}): number {
  const consumed = Math.max(0, input.allLots - input.purchased);
  const remainingOfElapsed = Math.max(0, input.elapsedLots - consumed);
  const headroom = Math.max(0, input.included + input.purchased - input.reserved);
  return Math.max(0, Math.min(input.purchased, remainingOfElapsed, headroom));
}

export async function expireDuePurchasedCredits(connections: ExpiryConnections): Promise<ExpiryOutcome> {
  // Only workspaces that HAVE an elapsed succeeded lot are opened at all: the common night is a no-op.
  const due = await connections.discovery.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id
       FROM credit_purchases
      WHERE status = 'succeeded' AND expires_at IS NOT NULL AND expires_at <= now()
      ORDER BY workspace_id`,
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

  const lots = await tx.query<{ elapsed: string; total: string }>(
    `SELECT coalesce(sum(credits) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now()), 0)::text AS elapsed,
            coalesce(sum(credits), 0)::text AS total
       FROM credit_purchases
      WHERE workspace_id = $1 AND status = 'succeeded'`,
    [workspaceId],
  );

  const amount = expirableCredits({
    purchased: Number(row.purchased_balance),
    included: Number(row.included_balance),
    reserved: Number(row.reserved),
    elapsedLots: Number(lots.rows[0]!.elapsed),
    allLots: Number(lots.rows[0]!.total),
  });
  if (amount === 0) return 0;

  // The key carries the day AND the amount: a same-day redelivery that recomputes the same amount is a ledger no-op
  // (the unique index), and a genuinely different amount (a hold released since) is a different, legitimate entry.
  const day = new Date().toISOString().slice(0, 10);
  const outcome = await expireCredits(
    tx,
    { workspaceId, idempotencyKey: `expire:${day}:${String(amount)}`, actorId: null, actorType: "system" },
    "purchased",
    amount,
  );
  return outcome.applied ? amount : 0;
}
