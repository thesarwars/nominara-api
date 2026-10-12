import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { refundCredits } from "./balance.js";
import { refundableDebitFor } from "./undo.js";

// SCANFIX D2 - what a FINISHED run owes the customer.
//
// THE RULE IS THE REFERENCE'S, NOT A PER-CELL ARITHMETIC. plans-and-entitlements.md
// §5 ("Failed action") and page-inventory.md FR-SCAN-01h: **a run that captures
// nothing is refunded in full; a partial run is charged in full and says so.** A
// deep scan is a FLAT-priced action (§6: "reserves and commits the same amount.
// There is no partial commit, because there is no per-cell arithmetic to adjust"),
// so there is nothing to apportion to the cells that failed. The incident ticket
// asked for "refund only the failed cells" on a mixed run; that contradicts the
// reference, and the reference wins (recorded in the change that added this file).
//
// "CAPTURES NOTHING" MEANS NOTHING WAS DELIVERED: no live capture AND no cell
// served from cache. A suppressed cell is a delivered answer (run-progress.ts: "A
// SUPPRESSED CELL IS DONE"; undo.ts: re-triggering a fully cached scan must not
// refund it - that was a free, unbounded loop).
//
// APPEND-ONLY, BALANCED, IDEMPOTENT, and it shares the undo path's machinery on
// purpose: `refundableDebitFor` finds the run's commit entry and recovers the exact
// bucket split from the `*_after` columns, so credits go back to where they came
// from (expiring ones do not turn durable); each refund carries THE DEBIT'S OWN
// idempotency key per bucket, so `ux_credit_ledger_idem` refuses a second one - from
// a redelivered final job, a second finalisation, a reaper pass, or a customer's
// undo that got there first. The `reference_type = 'run'` / `reference_id` pair is
// the mandatory reason: it ties the refund to the run that failed.
//
// A run with no debit (a scheduled run lives inside the subscription) refunds
// nothing and that is not an error.

const logger = new Logger("credits.run-settlement");

export interface RunSettlementInput {
  readonly workspaceId: string;
  readonly runId: string;
  /** Cells that produced an answer: live captures plus cache-served (suppressed) cells. */
  readonly deliveredCells: number;
}

export interface RunSettlementOutcome {
  readonly refunded: number;
}

/** Must be called inside the run's tenant transaction, by whoever just moved the run to a terminal status. */
export async function settleFinishedRunCredits(tx: ClientBase, input: RunSettlementInput): Promise<RunSettlementOutcome> {
  if (input.deliveredCells > 0) return { refunded: 0 };

  const debit = await refundableDebitFor(tx, input.workspaceId, input.runId);
  if (debit === null || debit.credits === 0 || debit.alreadyRefunded) return { refunded: 0 };

  let refunded = 0;
  for (const [bucket, amount] of [
    ["included", debit.fromIncluded],
    ["purchased", debit.fromPurchased],
  ] as const) {
    if (amount === 0) continue;
    const outcome = await refundCredits(
      tx,
      {
        workspaceId: input.workspaceId,
        idempotencyKey: `${debit.idempotencyKey}:${bucket}`,
        actorId: null,
        actorType: "system",
        referenceType: "run",
        referenceId: input.runId,
      },
      bucket,
      amount,
    );
    if (outcome.applied) refunded += amount;
  }

  if (refunded > 0) {
    incrementCounter("nominara_credits_run_refunded_total", { reason: "nothing_captured" });
    logger.log({ event: "credits.run.refunded", workspace_id: input.workspaceId, run_id: input.runId, credits: refunded, reason: "nothing_captured" });
  }
  return { refunded };
}
