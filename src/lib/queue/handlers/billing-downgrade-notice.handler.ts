import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { selectEmailSender } from "../../../modules/identity/email-sender.selector.js";
import { EmailSuppressedError, type EmailSender } from "../../../modules/identity/ports/email-sender.js";
import { downgradeNoticeIdempotencyKey } from "../../billing/downgrade-notice-outbox.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor } from "../worker-factory.js";

// STORY-077 — OWNER DECISION 2026-10-23 (2): `billing.downgrade_notice` sends one recorded downgrade pause/resume email
// (lib/billing/downgrade-notice-outbox.ts) and marks it sent.
//
// A SIGNED TENANT job, PHASED (ADR-0003): `createJobProcessor` verified the signature before any client was acquired.
//   prepare  one short tenant transaction: read the notice; one already sent (a retry after a commit, a duplicate job, a
//            stalled-job redelivery) ends the job here with nothing sent.
//   run      NO transaction and no connection: the provider call. A failure is THROWN, so the queue retries the job down
//            its ladder and the notice stays unsent. The provider idempotency key is derived from the notice id, so a
//            send that reached the provider but timed out on the way back is not delivered twice by the retry (Resend
//            de-duplicates on it for 24 hours, far beyond the ladder).
//   commit   a second short tenant transaction: mark it sent, only if still unsent.
// A SUPPRESSED recipient (STORY-178) is not a failure: it cannot succeed on a retry, so the job ends normally (counted as
// `suppressed`) instead of walking the ladder into the dead-letter queue. The notice stays unsent: `downgrade_notices` has no
// terminal "suppressed" state (a schema decision, reported with STORY-178), so the relay still re-offers it until its age cap.
//
// The notice is TRANSACTIONAL (owner decision 8 lists reports, digests and alerts as the mail a complaint suppresses): a
// spam complaint about a report must not stop the notice that a plan change paused projects. A hard bounce still does.
// Two deliveries racing through `run` at once both reach the provider with the same key; the provider keeps one.
//
// The payload is `.strict()` and carries the notice id ONLY: the address, subject and body are read from the row.

// Review round 2: one span around the send (the job's only network I/O) and every log line carrying the workspace id,
// as billing-customer-email.handler does. Ids only: never the address, the subject or the body.
const tracer = trace.getTracer("nominara.billing-downgrade-notice");

const payloadSchema = z.object({ workspaceId: z.string().uuid(), kid: z.string(), noticeId: z.string().uuid() }).strict();

interface Prepared {
  readonly id: string;
  readonly workspaceId: string;
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
}

export interface BillingDowngradeNoticeDeps {
  readonly sender?: EmailSender;
}

export function createBillingDowngradeNoticeHandler(_context: QueueHandlerContext, deps: BillingDowngradeNoticeDeps = {}): JobProcessor {
  const logger = new Logger("billing.downgrade_notice");
  // Chosen on the first job, not at boot, as the other billing handlers do.
  let sender = deps.sender;
  const senderFor = (): EmailSender => (sender ??= selectEmailSender());

  return phasedProcessor<Prepared, "sent" | "suppressed">({
    async prepare(tx: ClientBase, job: Job) {
      const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
      const found = await tx.query<{ id: string; recipient: string; subject: string; text_body: string }>(
        "SELECT id, recipient, subject, text_body FROM downgrade_notices WHERE id = $1 AND workspace_id = $2 AND sent_at IS NULL",
        [payload.noticeId, payload.workspaceId],
      );
      const row = found.rows[0];
      if (row === undefined) {
        incrementCounter("nominara_billing_downgrade_notice_jobs_total", { outcome: "already_sent" });
        return PHASES_DONE;
      }
      return { id: row.id, workspaceId: payload.workspaceId, to: row.recipient, subject: row.subject, textBody: row.text_body };
    },

    async run(prepared: Prepared) {
      return await tracer.startActiveSpan("billing.downgrade_notice.send", async (span) => {
        span.setAttributes({ "nominara.workspace_id": prepared.workspaceId, "nominara.downgrade_notice.id": prepared.id });
        try {
          await senderFor().send({ to: prepared.to, subject: prepared.subject, textBody: prepared.textBody, idempotencyKey: downgradeNoticeIdempotencyKey(prepared.id), transactional: true });
        } catch (error) {
          if (error instanceof EmailSuppressedError) {
            span.setAttribute("nominara.email.suppressed", error.kind);
            return "suppressed" as const;
          }
          span.setStatus({ code: SpanStatusCode.ERROR });
          incrementCounter("nominara_billing_downgrade_notice_failed_total", { reason: "send_failed" });
          logger.warn({
            event: "billing.downgrade_notice.send_failed",
            workspace_id: prepared.workspaceId,
            notice_id: prepared.id,
            error: error instanceof Error ? error.name : "unknown",
          });
          throw error;
        } finally {
          span.end();
        }
        return "sent" as const;
      });
    },

    async commit(tx: ClientBase, prepared: Prepared, outcome) {
      if (outcome === "suppressed") {
        incrementCounter("nominara_billing_downgrade_notice_jobs_total", { outcome: "suppressed" });
        logger.log({ event: "billing.downgrade_notice.suppressed", workspace_id: prepared.workspaceId, notice_id: prepared.id });
        return;
      }
      await tx.query("UPDATE downgrade_notices SET sent_at = now() WHERE id = $1 AND sent_at IS NULL", [prepared.id]);
      incrementCounter("nominara_billing_downgrade_notice_jobs_total", { outcome: "sent" });
      logger.log({ event: "billing.downgrade_notice.sent", workspace_id: prepared.workspaceId, notice_id: prepared.id });
    },
  });
}
