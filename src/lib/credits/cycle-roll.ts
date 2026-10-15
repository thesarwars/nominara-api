import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { expireCredits, grantCredits } from "./balance.js";
import { assignCarries, openHolds, writeCarries } from "./hold-carry.js";
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
// The grant is written first and the expiry second. Under option B (below) either order satisfies the schema's
// CHECKs, because the bucket never drops below the carry and `reserved <= carry + purchased`; the replay anchors on
// whichever of the two entries comes first (see `replay.ts`). The order is kept so the ledger reads the same way
// every time.
//
// ⚠ WHY THE GATE IS THE WALLET'S OWN `cycle_start`, read under the row lock. A replayed webhook, a stale event for an
// earlier period and two concurrent deliveries all ask the same question — "is this cycle newer than the one on file"
// — and the lock makes the answer single-valued. The ledger keys (`cycle_roll:<start>`) are the second layer: if the
// gate says "roll" and the ledger says "already done", the two disagree about history, and that REFUSES instead of
// half-applying (a refused entry is `applied: false`, never an outcome to shrug at).
//
// ⚠ RESERVATIONS IN FLIGHT KEEP THEIR HOLD (owner decision 2026-10-15, option B). The roll does NOT reset the whole
// bucket: `min(included, reserved)` credits — the part that backs a hold still open — are the CARRY and stay in the
// bucket with their holds (`hold-carry.ts`). Only `included - carry` is unused, and only that expires. The bucket
// therefore sits at `grant + carry` until the holds settle: a commit pays from the carry, a release (or the unspent
// part of a partial commit) expires it at that moment, so the customer pays an in-flight action once, from the cycle
// it started in. Literal reset charged it twice (grant 1000, spend 300, hold 200, roll to 1200: committing the hold
// ended on 1000, where committing first ends on 1200).
//
// The carry can never exceed what `ck_wallet_reserved` needs, so the roll no longer has a refusal case: after it the
// bucket holds `grant + carry` where `carry = min(included, reserved)`, and `reserved <= carry + purchased` by
// construction. (`CycleRollBlockedError`, which refused a hold larger than the new grant, is gone with it.)
//
// A plan UPGRADE that carries a new period applies §5's conversion rule: the unheld credits CARRY INTO the new grant
// ("remaining credits carry into `included_balance` up to the new grant") instead of expiring and being re-granted, so
// the ledger says "granted what was missing", not "expired 40, granted 450".

export interface CycleRollRequest {
  readonly workspaceId: string;
  /** The plan's `credits_per_cycle` for the cycle that is starting. */
  readonly grant: number;
  /**
   * §5 "Free → paid conversion": the credits left unheld CARRY INTO the new grant (up to it) instead of expiring.
   * Set for an upgrade; a renewal and a downgrade reset.
   */
  readonly carryUnused?: boolean;
  /** `YYYY-MM-DD`, UTC — `credit_wallets.cycle_start` / `cycle_end` are `date`. */
  readonly cycleStart: string;
  readonly cycleEnd: string;
  /**
   * The ISO instant the subscription's period began, set ONLY by a caller that has already seen the subscription's
   * `timestamptz` period start ADVANCE under the subscription row lock. The wallet's cycle is a `date`, so a free wallet
   * provisioned today and upgraded a few hours later has the SAME day on both sides and the day comparison cannot tell
   * a new period from an old one. With this set, a new period starting on the wallet's own `cycle_start` day is a roll,
   * and the ledger key carries the instant so it stays unique. A LATER wallet cycle is still "not newer".
   */
  readonly periodInstant?: string;
}

export type CycleRollOutcome =
  | {
      readonly rolled: true;
      /** What the roll expired: the unused credits that were not held and did not carry into the grant. */
      readonly expired: number;
      /** What the `grant` entry recorded: the grant less whatever carried into it. */
      readonly granted: number;
      /** What stayed in the bucket with the holds open at the roll. */
      readonly carried: number;
      readonly wallet: WalletState;
    }
  | { readonly rolled: false; readonly reason: "no_wallet" | "not_newer" };

const logger = new Logger("cycle-roll");
const tracer = trace.getTracer("nominara.credits");

interface LockedWallet {
  included_balance: number;
  purchased_balance: number;
  reserved: number;
  newer: boolean;
  same_day: boolean;
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
        span.setAttribute("nominara.credits.cycle_roll.carried_credits", outcome.carried);
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
          carried_credits: outcome.carried,
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
    `SELECT included_balance, purchased_balance, reserved, ($2::date > cycle_start) AS newer, ($2::date = cycle_start) AS same_day
       FROM credit_wallets WHERE workspace_id = $1 FOR UPDATE`,
    [workspaceId, request.cycleStart],
  );
  const wallet = locked.rows[0];
  if (wallet === undefined) return { rolled: false, reason: "no_wallet" };
  // A period the subscription says is new, starting on the day the wallet's cycle already began (free wallet, same-day
  // conversion), is a roll too; the calendar day alone cannot see it.
  const sameDayRoll = request.periodInstant !== undefined && wallet.same_day;
  if (!wallet.newer && !sameDayRoll) return { rolled: false, reason: "not_newer" };

  // Option B: what backs a hold stays with it; everything else in the bucket is unused. An upgrade carries the unused
  // credits into the new grant (§5 conversion) instead of expiring them.
  const carried = Math.min(wallet.included_balance, wallet.reserved);
  const unused = wallet.included_balance - carried;
  const carriedIn = request.carryUnused === true ? Math.min(unused, grant) : 0;
  const toGrant = grant - carriedIn;
  const toExpire = unused - carriedIn;

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
    idempotencyKey: `cycle_roll:${sameDayRoll ? request.periodInstant! : request.cycleStart}`,
    actorId: null,
    actorType: "system" as const,
    referenceType: "cycle_roll",
  };

  // Which hold keeps how much. Written ONLY when the roll leaves a ledger entry for the replay to anchor on (a grant or an
  // expiry under this roll's key): a plan with no grant and a bucket that is entirely held writes neither, and then the
  // holds simply settle as they always did.
  if (toGrant > 0 || toExpire > 0) {
    const holds = await openHolds(tx, workspaceId);
    await writeCarries(tx, workspaceId, request.cycleStart, holds, assignCarries(carried, holds));
  }

  if (toGrant > 0) {
    if (!(await grantCredits(tx, attribution, toGrant)).applied) throw disagreement(workspaceId, "grant", request);
  }
  if (toExpire > 0) {
    if (!(await expireCredits(tx, attribution, "included", toExpire)).applied) {
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
    expired: toExpire,
    granted: toGrant,
    carried,
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
