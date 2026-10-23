import { createHash } from "node:crypto";
import type { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { EmailMessage } from "../../modules/identity/ports/email-sender.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-077 — OWNER DECISION 2026-10-23 (2): the downgrade pause/resume email is RETRIED on failure and never sent twice.
//
// The cut-over (and plan:set) used to send the email inline after its commit, and a failed send was logged and lost. Now:
//   1. INSIDE the plan writer's transaction, each email is RECORDED in `downgrade_notices` (migration 0134), keyed by
//      (workspace, request, kind): the request is the Stripe event id, or for plan:set the ticket AND the entitlement
//      version the change produced (`planSetNoticeRequestId`: a ticket is reused across changes). A rolled-
//      back change records nothing, so it still never emails; a redelivered request records nothing new.
//   2. AFTER the commit, one signed tenant job `billing.downgrade_notice` is enqueued per recorded email, its BullMQ job id
//      derived from the same key, so a duplicate enqueue is dropped. The payload carries the notice id only.
//   3. The worker (lib/queue/handlers/billing-downgrade-notice.handler.ts) reads the row, sends it with no transaction
//      open (ADR-0003) and a provider idempotency key derived from the notice id, and marks it sent. A failed send fails
//      the job, so the queue retries it down its ladder; a sent notice is never sent again.
//
//   4. THE RELAY (downgrade-notice-relay.ts, review round 2) re-enqueues, hourly, every notice still unsent five minutes
//      after it was recorded and younger than 23 hours, under a fresh hour-suffixed job key: a job whose ladder ran out
//      during a provider outage, and a notice whose enqueue failed after the commit, are both sent by it.
//
// A FAILED ENQUEUE here is counted (`nominara_billing_downgrade_notice_failed_total{reason="enqueue_failed"}`) and logged
// with the notice id; the relay sends it at its next hourly tick.

export const DOWNGRADE_NOTICE_QUEUE = "billing.downgrade_notice" as const;
export type DowngradeNoticeKind = "paused" | "resumed";

export interface RecordedNotice extends EmailMessage {
  /** `downgrade_notices.id`: the job's payload and the provider idempotency key. */
  readonly id: string;
  readonly kind: DowngradeNoticeKind;
}

/** BullMQ job id for a notice: one per (workspace, request, kind). The request id is hashed (an operator ticket is free text). */
export function downgradeNoticeJobKey(workspaceId: string, requestId: string, kind: DowngradeNoticeKind): string {
  return `dgnotice:${workspaceId}:${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}:${kind}`;
}

/** The provider idempotency key for a notice: the same on every attempt of every job for it. */
export function downgradeNoticeIdempotencyKey(noticeId: string): string {
  return `downgrade-notice/${noticeId}`;
}

/**
 * Records the notices inside the CALLER's tenant transaction. Returns only the rows THIS call inserted: a request that
 * already recorded its notices (a redelivery) returns none, so nothing is enqueued twice.
 */
export async function recordDowngradeNotices(
  tx: ClientBase,
  workspaceId: string,
  requestId: string,
  messages: ReadonlyArray<{ readonly kind: DowngradeNoticeKind; readonly message: EmailMessage }>,
): Promise<RecordedNotice[]> {
  const recorded: RecordedNotice[] = [];
  for (const { kind, message } of messages) {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO downgrade_notices (workspace_id, request_id, kind, recipient, subject, text_body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, request_id, kind) DO NOTHING
       RETURNING id`,
      [workspaceId, requestId, kind, message.to, message.subject, message.textBody],
    );
    const id = row.rows[0]?.id;
    if (id !== undefined) recorded.push({ ...message, id, kind });
  }
  return recorded;
}

export type EnqueueDowngradeNotice = (
  queue: typeof DOWNGRADE_NOTICE_QUEUE,
  workspaceId: string,
  payload: { readonly noticeId: string },
  options: { readonly idempotencyKey: string },
) => Promise<unknown>;

/**
 * AFTER the commit: one job per recorded notice. A failed enqueue is counted and logged (with the notice id, never the
 * address), not thrown: the plan change is committed, and the notice stays recorded and unsent.
 */
export async function enqueueDowngradeNotices(
  enqueue: EnqueueDowngradeNotice | undefined,
  workspaceId: string,
  requestId: string,
  notices: readonly RecordedNotice[],
  logger: Pick<Logger, "log" | "error">,
): Promise<void> {
  for (const notice of notices) {
    try {
      if (enqueue === undefined) throw new Error("this process has no queue producer");
      await enqueue(DOWNGRADE_NOTICE_QUEUE, workspaceId, { noticeId: notice.id }, { idempotencyKey: downgradeNoticeJobKey(workspaceId, requestId, notice.kind) });
      incrementCounter("nominara_billing_downgrade_notice_enqueued_total", { kind: notice.kind });
    } catch (error) {
      incrementCounter("nominara_billing_downgrade_notice_failed_total", { reason: "enqueue_failed" });
      logger.error({
        message: "downgrade notice recorded but its job could not be enqueued: the hourly relay re-enqueues it",
        workspace_id: workspaceId,
        notice_id: notice.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
