// STORY-068 RED stub — replaced by the implementation.
import type { NotificationDeepLink, NotificationSeverity } from "../../../contracts/notifications/index.js";
export type NotifyDispatchPayload =
  | { readonly kind: "email"; readonly emailId: string }
  | { readonly kind: "digest"; readonly userId: string; readonly cadence: "daily" | "weekly"; readonly periodStart: string; readonly periodEnd: string }
  | { readonly kind: "credit_check" };
export type EnqueueNotifyDispatch = (queue: "notify.dispatch", workspaceId: string, payload: NotifyDispatchPayload, options: { readonly idempotencyKey: string }) => Promise<unknown>;
export function channelsFor(_severity: NotificationSeverity): string[] { return []; }
export function deepLinkHref(_link: NotificationDeepLink): string { return ""; }
