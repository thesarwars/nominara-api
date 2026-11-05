import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { refundCredits } from "./balance.js";
import { refundableDebitFor } from "./undo.js";

// AUXLIVE-3 (STORY-194, owner decision 34 item 3) - what a manual AUX audit owes the customer when it FAILS.
//
// plans-and-entitlements.md section 5 ("Failed action") and STORY-082: an action that delivers nothing is refunded in full; a partial audit
// ("some pages unreachable") is charged in full and names what it could not reach. So the only callers are the two places an audit is known to
// have delivered nothing: `crawl.audit` finishing `failed` (not one site file answered, or the project gone), and the producer failing to hand the
// job to the queue at all.
//
// It is the capture run's refund (run-settlement.ts) for a different reference: `refundableDebitFor` finds the audit's commit entry
// (`reference_type = 'aux_audit'`) and recovers the exact bucket split, so expiring credits do not turn durable; each refund carries THE DEBIT'S OWN
// idempotency key per bucket, so `ux_credit_ledger_idem` refuses a second one - from a redelivered job, the dispatch compensation racing the
// handler, or a second finalisation. APPEND-ONLY and BALANCED like every other ledger movement.
//
// An audit with no debit (onboarding, scheduled) refunds nothing, and that is not an error.

const logger = new Logger("credits.aux-audit-refund");

/** The ledger's `reference_type` for a manual audit's debit and its refund. */
export const AUX_AUDIT_REFERENCE = "aux_audit";

export interface AuxAuditRefundInput {
  readonly workspaceId: string;
  readonly auditId: string;
  /** A short code for the log and the metric: `audit_failed`, `dispatch_failed`, `project_gone`. */
  readonly reason: string;
}

/** Must be called inside the audit's tenant transaction, by whoever just moved the audit to a failed state. */
export async function refundAuxAuditCharge(tx: ClientBase, input: AuxAuditRefundInput): Promise<{ readonly refunded: number }> {
  const debit = await refundableDebitFor(tx, input.workspaceId, input.auditId, AUX_AUDIT_REFERENCE);
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
        idempotencyKey: [debit.idempotencyKey, bucket].join(":"),
        actorId: null,
        actorType: "system",
        referenceType: AUX_AUDIT_REFERENCE,
        referenceId: input.auditId,
      },
      bucket,
      amount,
    );
    if (outcome.applied) refunded += amount;
  }

  if (refunded > 0) {
    incrementCounter("nominara_credits_aux_audit_refunded_total", { reason: input.reason });
    logger.log({ event: "credits.aux_audit.refunded", workspace_id: input.workspaceId, audit_id: input.auditId, credits: refunded, reason: input.reason });
  }
  return { refunded };
}
