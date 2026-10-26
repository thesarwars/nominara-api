import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { selectEmailSender } from "../../../modules/identity/email-sender.selector.js";
import { EmailSuppressedError, type EmailSender } from "../../../modules/identity/ports/email-sender.js";
import { prepareDigest } from "../../notifications/digest.js";
import { emailIdempotencyKey, type EnqueueNotifyDispatch } from "../../notifications/routing.js";
import { stampCreditThresholds } from "../../notifications/thresholds.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../connection.js";
import { QueueProducer } from "../queue-producer.js";
import type { QueueHandlerContext } from "../handlers.js";
import { PHASES_DONE, phasedProcessor, signingKeysFromEnv, type JobProcessor } from "../worker-factory.js";

// STORY-068 — `notify.dispatch` (system-architecture.md §4: any producer, rollup group, key `ntf:{event}`). THE one send
// path for notification email. A SIGNED TENANT job, PHASED
// (ADR-0003 / NFR-ARCH-04), on the STORY-077 downgrade-notice precedent:
//
//   prepare  one short tenant transaction:
//              `email`        read the outbox row (an immediate critical email or an assembled digest) and the
//                             recipient's address, live; a row already sent ends the job here with nothing sent;
//              `digest`       assemble the member's digest for the period (lib/notifications/digest.ts): an empty one is
//                             recorded `skipped_empty` and the job ends with NOTHING SENT (AC10);
//              `credit_check` stamp the wallet's credit thresholds and write their notifications (AC7), AFTER the debit's
//                             ledger transaction committed; nothing to send in this job.
//   run      NO transaction and no connection: the provider call. A failure is THROWN, so the queue retries the job; the
//            provider idempotency key is derived from the outbox row id, so a send that reached the provider but timed
//            out on the way back is not delivered twice by the retry (AC11). A SUPPRESSED recipient (STORY-178) is not a
//            failure: it is the expected steady state for a bounced member, it cannot succeed on a retry, and a thrown error
//            would walk the retry ladder and end in the dead-letter queue (the SLO-24 depth rule pages on that). The job
//            ends normally, counted as `suppressed`.
//   commit   a second short tenant transaction: mark it sent, only if still pending (nothing for a suppressed one).
//
// OPEN (needs a schema decision, reported with STORY-178): the outbox row of a suppressed send stays `pending`, because
// `notification_emails.status` has no terminal "suppressed" value. The relay therefore still re-enqueues it every five minutes
// until EMAIL_RELAY_MAX_AGE; each such job ends here at once, with nothing sent and nothing retried.
//
// The payload is `.strict()` and carries ids only: the address, subject and body are read from the database.

const tracer = trace.getTracer("nominara.notify-dispatch");

const payloadSchema = z.discriminatedUnion("kind", [
  z.object({ workspaceId: z.string().uuid(), kid: z.string(), kind: z.literal("email"), emailId: z.string().uuid() }).strict(),
  z
    .object({
      workspaceId: z.string().uuid(),
      kid: z.string(),
      kind: z.literal("digest"),
      userId: z.string().uuid(),
      cadence: z.enum(["daily", "weekly"]),
      periodStart: z.string().datetime(),
      periodEnd: z.string().datetime(),
    })
    .strict(),
  z.object({ workspaceId: z.string().uuid(), kid: z.string(), kind: z.literal("credit_check") }).strict(),
]);

interface Prepared {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
}

export interface NotifyDispatchDeps {
  readonly sender?: EmailSender;
  /** The enqueue a critical credit warning's own emails use after commit. */
  readonly enqueue?: EnqueueNotifyDispatch;
}

async function readPending(tx: ClientBase, workspaceId: string, emailId: string): Promise<Prepared | undefined> {
  const found = await tx.query<{ id: string; kind: string; email: string; subject: string; text_body: string }>(
    `SELECT e.id, e.kind, u.email::text AS email, e.subject, e.text_body
       FROM notification_emails e JOIN users u ON u.id = e.user_id
      WHERE e.id = $1 AND e.workspace_id = $2 AND e.status = 'pending'
        AND u.deleted_at IS NULL AND u.status = 'active' AND u.email_verified_at IS NOT NULL`,
    [emailId, workspaceId],
  );
  const row = found.rows[0];
  return row === undefined ? undefined : { id: row.id, workspaceId, kind: row.kind, to: row.email, subject: row.subject, textBody: row.text_body };
}

export function createNotifyDispatchHandler(context: QueueHandlerContext, deps: NotifyDispatchDeps = {}): JobProcessor {
  const logger = new Logger("notify.dispatch");
  // Chosen on the first send, not at boot, as the billing email handlers do.
  let sender = deps.sender;
  const senderFor = (): EmailSender => (sender ??= selectEmailSender());
  let producer: QueueProducer | undefined;
  const enqueue: EnqueueNotifyDispatch =
    deps.enqueue ??
    (async (queue, workspaceId, payload, options): Promise<unknown> => {
      producer ??= new QueueProducer(createQueueWorkerConnection(context.env.QUEUE_REDIS_URL), queueKeyPrefix(context.env.NODE_ENV), signingKeysFromEnv(context.env));
      return producer.enqueueTenantJob(queue, workspaceId, payload, options);
    });
  const appOrigin = (): { appOrigin?: string } => (typeof context.env.WEBAUTHN_ORIGIN === "string" ? { appOrigin: context.env.WEBAUTHN_ORIGIN } : {});

  return phasedProcessor<Prepared, "sent" | "suppressed">({
    async prepare(tx: ClientBase, job: Job) {
      const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
      if (payload.kind === "credit_check") {
        const crossed = await stampCreditThresholds(tx, payload.workspaceId, { enqueue, ...appOrigin() });
        incrementCounter("nominara_notify_dispatch_jobs_total", { kind: "credit_check", outcome: crossed.length > 0 ? "warned" : "nothing" });
        return PHASES_DONE;
      }
      let emailId: string;
      if (payload.kind === "digest") {
        const digest = await prepareDigest(
          tx,
          { workspaceId: payload.workspaceId, userId: payload.userId, cadence: payload.cadence, periodStart: payload.periodStart, periodEnd: payload.periodEnd },
          appOrigin(),
        );
        if (digest.outcome !== "pending") {
          incrementCounter("nominara_notify_dispatch_jobs_total", { kind: "digest", outcome: digest.outcome });
          logger.log({ event: "notify.dispatch.digest", workspace_id: payload.workspaceId, outcome: digest.outcome });
          return PHASES_DONE;
        }
        emailId = digest.emailId;
      } else {
        emailId = payload.emailId;
      }
      const prepared = await readPending(tx, payload.workspaceId, emailId);
      if (prepared === undefined) {
        incrementCounter("nominara_notify_dispatch_jobs_total", { kind: payload.kind, outcome: "nothing_pending" });
        return PHASES_DONE;
      }
      return prepared;
    },

    async run(prepared: Prepared) {
      return await tracer.startActiveSpan("notify.dispatch.send", async (span) => {
        span.setAttributes({ "nominara.workspace_id": prepared.workspaceId, "nominara.notification_email.id": prepared.id, "nominara.notification_email.kind": prepared.kind });
        try {
          await senderFor().send({ to: prepared.to, subject: prepared.subject, textBody: prepared.textBody, idempotencyKey: emailIdempotencyKey(prepared.id) });
        } catch (error) {
          if (error instanceof EmailSuppressedError) {
            span.setAttribute("nominara.email.suppressed", error.kind);
            return "suppressed" as const;
          }
          span.setStatus({ code: SpanStatusCode.ERROR });
          incrementCounter("nominara_notify_dispatch_failed_total", { kind: prepared.kind, reason: "send_failed" });
          logger.warn({
            event: "notify.dispatch.send_failed",
            workspace_id: prepared.workspaceId,
            email_id: prepared.id,
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
        incrementCounter("nominara_notify_dispatch_jobs_total", { kind: prepared.kind, outcome: "suppressed" });
        logger.log({ event: "notify.dispatch.suppressed", workspace_id: prepared.workspaceId, email_id: prepared.id, kind: prepared.kind });
        return;
      }
      await tx.query("UPDATE notification_emails SET status = 'sent', sent_at = now() WHERE id = $1 AND status = 'pending'", [prepared.id]);
      incrementCounter("nominara_notify_dispatch_jobs_total", { kind: prepared.kind, outcome: "sent" });
      // Ids only: never the address, the subject or the body.
      logger.log({ event: "notify.dispatch.sent", workspace_id: prepared.workspaceId, email_id: prepared.id, kind: prepared.kind });
    },
  });
}
