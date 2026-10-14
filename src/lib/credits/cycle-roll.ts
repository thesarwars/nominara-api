import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { expireCredits, grantCredits } from "./balance.js";
import type { WalletState } from "./wallet.js";

// STORY-072 AC13 — the billing-cycle roll.
//
// plans-and-entitlements.md §5, "Grant refresh": "At `cycle_end`, `included_balance` is RESET to the plan grant, not
// added. Unused included credits expire, and the UI shows 'expires in N days'." Owner decision 2026-10-14: the same,
// and the unused credits get an `expire` ledger entry. Purchased credits are not this function's: they roll over
// twelve months and their own FIFO expiry is `expire.ts`.
//
// ⚠ A RESET IS TWO LEDGER ENTRIES, NOT ONE UPDATE. A bare `SET included_balance = grant` would balance nothing: the
// ledger replay (`verifyWorkspaceWallet`) would see the balance jump with no entry to account for it, and the
// customer-visible "your 400 unused credits expired" would have no record to point at. `grant` G then `expire` I
// (I = what the bucket held) lands the bucket on exactly G and leaves both movements explicable.
//
// ⚠ GRANT FIRST, EXPIRE SECOND, and it is the order that matters. `ck_wallet_reserved` is immediate, so expiring
// first could momentarily leave `reserved` above `included + purchased` and fail the whole roll on a wallet that is
// perfectly healthy once the grant lands.
//
// ⚠ WHY THE GATE IS THE WALLET'S OWN `cycle_start`, read under the row lock. A replayed webhook, a stale event for an
// earlier period and two concurrent deliveries all ask the same question — "is this cycle newer than the one on file"
// — and the lock makes the answer single-valued. The ledger keys (`cycle_roll:<start>`) are the second layer: if the
// gate says "roll" and the ledger says "already done", the two disagree about history, and that REFUSES instead of
// half-applying (a refused entry is `applied: false`, never an outcome to shrug at).
//
// RESERVATIONS ARE NEVER TOUCHED. `reserved` is not read as a balance and never written here, so a hold taken before
// the roll commits or releases against the new cycle exactly as it would have. The specification does not say
// whether an in-flight hold should be paid from the old cycle's credits or the new grant; the literal reading (the
// bucket is RESET to the grant, so the commit debits the new grant) is what happens, and it is recorded in
// docs-pending/STORY-072 as the one policy question. The only case that cannot be literal is a hold larger than
// what the wallet holds after the reset, which `ck_wallet_reserved` makes unrepresentable: that refuses the whole
// roll (retryable — holds settle within minutes) instead of trimming or releasing someone's reservation.

export interface CycleRollRequest {
  readonly workspaceId: string;
  /** The plan's `credits_per_cycle` for the cycle that is starting. */
  readonly grant: number;
  /** `YYYY-MM-DD`, UTC — `credit_wallets.cycle_start` / `cycle_end` are `date`. */
  readonly cycleStart: string;
  readonly cycleEnd: string;
}

export type CycleRollOutcome =
  | { readonly rolled: true; readonly expired: number; readonly granted: number; readonly wallet: WalletState }
  | { readonly rolled: false; readonly reason: "no_wallet" | "not_newer" };

/** A live reservation is larger than the wallet would hold after the reset: retry once holds settle. */
export class CycleRollBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CycleRollBlockedError";
  }
}

const logger = new Logger("cycle-roll");
const tracer = trace.getTracer("nominara.credits");

interface LockedWallet {
  included_balance: number;
  purchased_balance: number;
  reserved: number;
  newer: boolean;
}

/**
 * Roll a wallet onto a new cycle: expire what the included bucket still holds, grant the plan's allowance, move
 * the cycle dates and restart the per-cycle auto-top-up counter — one transaction (the caller's), all or nothing.
 *
 * ⚠ THE CALLER MUST ALREADY BE IN A TRANSACTION WITH TENANT CONTEXT. Both ledger entries, the cycle dates and the
 * counter reset commit together or not at all.
 */
export async function rollIncludedCycle(tx: ClientBase, request: CycleRollRequest): Promise<CycleRollOutcome> {
  if (!Number.isInteger(request.grant) || request.grant < 0) {
    throw new Error(`cycle grant must be a non-negative integer, received ${String(request.grant)}`);
  }

  return tracer.startActiveSpan("credits.cycle_roll", async (span) => {
    try {
      const outcome = await roll(tx, request);
      span.setAttribute("nominara.credits.cycle_roll.rolled", outcome.rolled);
      if (outcome.rolled) {
        span.setAttribute("nominara.credits.cycle_roll.expired_credits", outcome.expired);
        span.setAttribute("nominara.credits.cycle_roll.granted_credits", outcome.granted);
      }
      incrementCounter("nominara_credits_cycle_roll_total", { outcome: outcome.rolled ? "rolled" : outcome.reason });
      if (outcome.rolled) {
        // The workspace ID, never its name; amounts are counts of credits, not engine text or PII.
        logger.log({
          message: "billing cycle rolled: included bucket reset to the plan grant",
          workspace_id: request.workspaceId,
          cycle_start: request.cycleStart,
          expired_credits: outcome.expired,
          granted_credits: outcome.granted,
        });
      }
      return outcome;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      incrementCounter("nominara_credits_cycle_roll_total", { outcome: "failed" });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function roll(tx: ClientBase, request: CycleRollRequest): Promise<CycleRollOutcome> {
  const { workspaceId, grant } = request;

  // The lock, then the question. `newer` is computed by Postgres so no JS Date ever stands in for a `date`.
  const locked = await tx.query<LockedWallet>(
    `SELECT included_balance, purchased_balance, reserved, ($2::date > cycle_start) AS newer
       FROM credit_wallets WHERE workspace_id = $1 FOR UPDATE`,
    [workspaceId, request.cycleStart],
  );
  const wallet = locked.rows[0];
  if (wallet === undefined) return { rolled: false, reason: "no_wallet" };
  if (!wallet.newer) return { rolled: false, reason: "not_newer" };

  if (wallet.reserved > grant + wallet.purchased_balance) {
    throw new CycleRollBlockedError(
      `workspace ${workspaceId} holds ${String(wallet.reserved)} credits in live reservations, more than the ` +
        `${String(grant + wallet.purchased_balance)} it would hold after the cycle reset: retry once they settle`,
    );
  }

  // Cycle dates first, so every ledger snapshot below carries the NEW `cycle_end`. The counter restarts here
  // (EC-48: it resets only at cycle roll).
  await tx.query(
    `UPDATE credit_wallets
        SET cycle_start = $2::date, cycle_end = $3::date, auto_topup_count_cycle = 0, updated_at = now()
      WHERE workspace_id = $1`,
    [workspaceId, request.cycleStart, request.cycleEnd],
  );

  const attribution = {
    workspaceId,
    idempotencyKey: `cycle_roll:${request.cycleStart}`,
    actorId: null,
    actorType: "system" as const,
    referenceType: "cycle_roll",
  };

  const unused = wallet.included_balance;
  let granted = 0;
  if (grant > 0) {
    if (!(await grantCredits(tx, attribution, grant)).applied) throw disagreement(workspaceId, "grant", request);
    granted = grant;
  }
  if (unused > 0) {
    if (!(await expireCredits(tx, attribution, "included", unused)).applied) {
      throw disagreement(workspaceId, "expire", request);
    }
  }

  const after = await tx.query<{ included_balance: number; purchased_balance: number; reserved: number; cycle_end: string }>(
    `SELECT included_balance, purchased_balance, reserved, to_char(cycle_end, 'YYYY-MM-DD') AS cycle_end
       FROM credit_wallets WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = after.rows[0]!;
  return {
    rolled: true,
    expired: unused,
    granted,
    wallet: {
      includedBalance: row.included_balance,
      purchasedBalance: row.purchased_balance,
      reserved: row.reserved,
      available: row.included_balance + row.purchased_balance - row.reserved,
      cycleEnd: row.cycle_end,
    },
  };
}

function disagreement(workspaceId: string, entry: "grant" | "expire", request: CycleRollRequest): Error {
  return new Error(
    `workspace ${workspaceId} is rolling into the cycle starting ${request.cycleStart} but its ledger already holds ` +
      `the ${entry} entry for it: the wallet and the ledger disagree about whether this cycle was processed`,
  );
}
