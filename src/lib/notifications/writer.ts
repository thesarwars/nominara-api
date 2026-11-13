import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { notificationDeepLinkSchema, type NotificationDeepLink, type NotificationSeverity } from "../../../contracts/notifications/index.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { emailableMembers, SENTIMENT_ALERT_KIND, seesProject } from "./audience.js";
import { renderImmediateEmail } from "./render.js";
import { channelsFor, emailJobKey, emailsImmediately, NOTIFY_DISPATCH_QUEUE, type EnqueueNotifyDispatch } from "./routing.js";

// STORY-068 — THE notification writer. Every producer that adopts it gets, from one place:
//   * AC11 IDEMPOTENCY BY EVENT KEY — `(workspace_id, event_key)` is unique (migration 0135), and the INSERT is
//     `ON CONFLICT DO NOTHING`, so a retried job, a redelivered event or a second page view writes nothing;
//   * AC12 SEVERITY ROUTING — `channels` from the severity; a critical notification records one immediate email per
//     recipient in the `notification_emails` outbox IN THE CALLER'S TRANSACTION, and one `notify.dispatch` job per email
//     is enqueued AFTER COMMIT (a rolled-back write sends nothing). The send itself happens in the worker with no
//     transaction open (ADR-0003 / NFR-ARCH-04); the notify sweep relays any email whose job never ran.
// NOTHING HERE TOUCHES THE NETWORK. The enqueue is an after-commit effect; a failed enqueue is counted and logged, never
// thrown, and the relay sends the email at its next tick.

const logger = new Logger("notifications.writer");

export interface NotificationInput {
  readonly workspaceId: string;
  readonly projectId: string | null;
  /** NULL addresses the whole workspace. */
  readonly userId: string | null;
  readonly kind: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string | null;
  /** AC11 — the idempotency key: the same logical event always carries the same key. */
  readonly eventKey: string;
  readonly deepLink?: NotificationDeepLink | null;
  readonly taskId?: string | null;
  /** Producer facts kept on the row (the alert rule, its scope); never published as such. */
  readonly facts?: Readonly<Record<string, string | number | boolean | null>>;
  /**
   * STORY-098 (PROVISIONAL): email NOW although the severity would wait for the digest. For an event the agency wants in its
   * inbox at once but that is not an alert (a share link's first view). Same outbox, same suppression, same relay.
   */
  readonly emailNow?: boolean;
}

export interface WriteOutcome {
  /** The notification's id; null when the event key already existed (nothing was written). */
  readonly id: string | null;
  readonly created: boolean;
  /** The outbox rows recorded for an immediate email. */
  readonly emailIds: readonly string[];
}

export interface WriterOptions {
  /** Absent in a process without a queue producer: the emails are recorded and the relay sends them. */
  readonly enqueue?: EnqueueNotifyDispatch;
  /** The app's public origin, for the link in an email (`WEBAUTHN_ORIGIN` is the app's origin). */
  readonly appOrigin?: string;
  /**
   * For a caller on the API request path, which has no queue producer: the outbox rows are recorded and NO enqueue is attempted
   * (not even a failing one); the notify sweep's relay sends them at its next tick.
   */
  readonly relayOnly?: boolean;
}

export async function writeNotification(tx: ClientBase, input: NotificationInput, options: WriterOptions = {}): Promise<WriteOutcome> {
  const deepLink = input.deepLink === undefined || input.deepLink === null ? null : notificationDeepLinkSchema.parse(input.deepLink);
  const payload = { ...(input.facts ?? {}), deep_link: deepLink, task_id: input.taskId ?? null };
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO notifications (workspace_id, project_id, user_id, kind, severity, title, body, payload, channels, event_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::text[], $10)
     ON CONFLICT (workspace_id, event_key) WHERE event_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [input.workspaceId, input.projectId, input.userId, input.kind, input.severity, input.title, input.body, JSON.stringify(payload), input.emailNow === true ? ["in_app", "email"] : channelsFor(input.severity), input.eventKey],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    incrementCounter("nominara_notifications_written_total", { kind: input.kind, outcome: "duplicate" });
    return { id: null, created: false, emailIds: [] };
  }
  incrementCounter("nominara_notifications_written_total", { kind: input.kind, outcome: "created" });
  if (input.emailNow !== true && !emailsImmediately(input.severity)) return { id, created: true, emailIds: [] };

  const rendered = renderImmediateEmail({ title: input.title, body: input.body, deepLink, appOrigin: options.appOrigin });
  const emailIds: string[] = [];
  for (const member of await emailableMembers(tx, input.workspaceId, input.userId)) {
    if (!seesProject(member.visible, input.projectId)) continue;
    if (input.kind === SENTIMENT_ALERT_KIND && !member.sentimentAlerts) continue;
    const row = await tx.query<{ id: string }>(
      `INSERT INTO notification_emails (workspace_id, user_id, kind, dedupe_key, notification_id, notification_count, status, subject, text_body)
       VALUES ($1, $2, 'immediate', $3, $4, 1, 'pending', $5, $6)
       ON CONFLICT (workspace_id, user_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [input.workspaceId, member.userId, `immediate:${id}`, id, rendered.subject, rendered.textBody],
    );
    const emailId = row.rows[0]?.id;
    if (emailId !== undefined) emailIds.push(emailId);
  }
  await tx.query("UPDATE notifications SET dispatched_at = now() WHERE id = $1", [id]);

  const store = currentTenantStore();
  if (emailIds.length > 0 && store !== undefined && options.relayOnly !== true) {
    const enqueue = options.enqueue;
    store.afterCommit(() => {
      for (const emailId of emailIds) {
        void (async () => {
          if (enqueue === undefined) throw new Error("this process has no queue producer");
          await enqueue(NOTIFY_DISPATCH_QUEUE, input.workspaceId, { kind: "email", emailId }, { idempotencyKey: emailJobKey(emailId) });
          incrementCounter("nominara_notifications_email_enqueued_total", { kind: "immediate" });
        })().catch((error: unknown) => {
          incrementCounter("nominara_notifications_email_enqueue_failed_total", { kind: "immediate" });
          logger.warn({
            message: "notification email recorded but not enqueued: the notify sweep relays it",
            workspace_id: input.workspaceId,
            email_id: emailId,
            error: error instanceof Error ? error.name : "unknown",
          });
        });
      }
    });
  }
  return { id, created: true, emailIds };
}
