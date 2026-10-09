import type { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { afterCommit } from "../../tenancy/tenant-context.js";

// NEW-D-7 checkpoint-3 finding 4 / owner decision 4 — the ONE place a debit asks for an auto top-up.
//
// A top-up charges a saved card through Stripe, and no request handler may make that call (KAD-06). So the
// debit path does the only thing it may: when the balance it just committed is below the workspace's
// threshold, it enqueues a signed tenant `billing.auto_topup` job and returns. The worker verifies the
// signature, then the auto-top-up service's `trigger` does the evaluating and the charging.
//
// This asks a cheap question and decides nothing: whether to charge, whether the plan still allows it, the cap
// and the saved card are all re-decided by `trigger` under the wallet lock. A false positive here costs one job
// that answers `not_in_plan` or `cap_reached`; a false negative costs a top-up one debit late.

export type EnqueueAutoTopup = (
  queue: "billing.auto_topup",
  workspaceId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
) => Promise<unknown>;

/**
 * One key per workspace per UTC minute: a burst of debits while the balance is low queues one job, and a
 * balance that is still low a minute later is looked at again. (BullMQ drops a job whose id it still holds.)
 */
export function autoTopupJobKey(workspaceId: string, now: Date): string {
  const minute = now.toISOString().slice(0, 16).replace(/[-T:]/g, "");
  return `autotopup:${workspaceId}:${minute}`;
}

/**
 * Inside the debit's transaction: is auto top-up on, with a threshold the balance is now below? If so, enqueue
 * AFTER COMMIT, so the job runs on another connection and sees this debit. A failed enqueue is logged and
 * counted, never thrown: the debit is committed and the next one asks again.
 */
export async function requestAutoTopupIfBelowThreshold(
  tx: ClientBase,
  workspaceId: string,
  enqueue: EnqueueAutoTopup,
  logger: Pick<Logger, "log" | "error">,
  now: () => Date = () => new Date(),
): Promise<void> {
  const below = await tx.query(
    `SELECT 1 FROM credit_wallets
      WHERE workspace_id = $1 AND auto_topup_enabled AND auto_topup_threshold IS NOT NULL
        AND (included_balance + purchased_balance - reserved) < auto_topup_threshold`,
    [workspaceId],
  );
  if ((below.rowCount ?? 0) === 0) return;

  const key = autoTopupJobKey(workspaceId, now());
  afterCommit(() => {
    void enqueue("billing.auto_topup", workspaceId, {}, key)
      .then(() => {
        incrementCounter("nominara_billing_auto_topup_enqueued_total", {});
        logger.log({ event: "billing.auto_topup.enqueued", workspace_id: workspaceId });
      })
      .catch((error: unknown) => {
        incrementCounter("nominara_billing_auto_topup_enqueue_failed_total", {});
        logger.error({ event: "billing.auto_topup.enqueue_failed", workspace_id: workspaceId, error: error instanceof Error ? error.name : "unknown" });
      });
  });
}
