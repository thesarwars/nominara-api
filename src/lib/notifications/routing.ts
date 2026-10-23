import type { NotificationDeepLink, NotificationSeverity } from "../../../contracts/notifications/index.js";

// STORY-068 AC12 — SEVERITY DETERMINES CHANNEL. The highest severity (`critical`) is emailed at once as well as shown in
// the inbox; `warning` and `info` wait for the recipient's digest. OWNER DECISION 2026-10-23: urgent alerts (a
// displacement with impact >= 60, a credit balance under 10%) email immediately.

export type NotificationChannel = "in_app" | "email";

export function channelsFor(severity: NotificationSeverity): NotificationChannel[] {
  return severity === "critical" ? ["in_app", "email"] : ["in_app"];
}

export function emailsImmediately(severity: NotificationSeverity): boolean {
  return channelsFor(severity).includes("email");
}

export const NOTIFY_DISPATCH_QUEUE = "notify.dispatch" as const;

/**
 * What a `notify.dispatch` job carries: an outbox row to send, a digest to assemble for one member and period, or a
 * credit-threshold check (STORY-068 AC7: asked by the notify sweep, so it always runs in its own tenant transaction after
 * the debit that crossed the threshold committed, never inside a ledger transaction).
 */
export type NotifyDispatchPayload =
  | { readonly kind: "email"; readonly emailId: string }
  | { readonly kind: "digest"; readonly userId: string; readonly cadence: "daily" | "weekly"; readonly periodStart: string; readonly periodEnd: string }
  | { readonly kind: "credit_check" };

export type EnqueueNotifyDispatch = (
  queue: typeof NOTIFY_DISPATCH_QUEUE,
  workspaceId: string,
  payload: NotifyDispatchPayload,
  options: { readonly idempotencyKey: string },
) => Promise<unknown>;

/** The BullMQ job id of an outbox row's send (`ntf:{event}`, system-architecture.md §4). */
export function emailJobKey(emailId: string): string {
  return `ntf:email:${emailId}`;
}

/** One credit check per workspace per sweep slot (5 minutes): replicas ticking together ask once. */
export function creditCheckJobKey(workspaceId: string, now: Date): string {
  return `ntf:credit:${workspaceId}:${String(Math.floor(now.getTime() / 300_000))}`;
}

/** The relay's job id for an outbox row in one hour: BullMQ keeps the base id for an hour, so a re-add needs a fresh one. */
export function emailRelayJobKey(emailId: string, hour: string): string {
  return [emailJobKey(emailId), "relay", hour].join(":");
}

export function digestJobKey(workspaceId: string, userId: string, cadence: string, periodStart: string): string {
  return `ntf:digest:${workspaceId}:${userId}:${cadence}:${periodStart}`;
}

/** The provider idempotency key: the same on every attempt of every job for one outbox row. */
export function emailIdempotencyKey(emailId: string): string {
  return `notification-email/${emailId}`;
}

/** The deep link as an app-relative href (`/p/{id}/prompts?engines=gemini&tf=7d`). */
export function deepLinkHref(link: NotificationDeepLink): string {
  const query = new URLSearchParams(Object.entries(link.query).sort(([a], [b]) => a.localeCompare(b))).toString();
  return query === "" ? link.path : `${link.path}?${query}`;
}
