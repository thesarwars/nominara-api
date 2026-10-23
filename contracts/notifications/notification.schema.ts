import { z } from "zod";
import { PAGINATION_LIMIT_DEFAULT, PAGINATION_LIMIT_MAX } from "../common/pagination.schema.js";

// STORY-068 — the in-app inbox. `GET /v1/workspaces/{id}/notifications`, `POST .../notifications/{notification_id}/read`,
// `POST .../notifications/read-all` (all `workspace:read`: every member has an inbox).
//
// schemas/sources-and-rollups.md `notifications`: kind, severity, title, body and payload, addressed to ONE user
// (`user_id`) or to the whole workspace (`user_id` NULL). READ STATE IS PER USER (AC8): a workspace-wide row is read by
// one member without being read for the rest, so `read` / `read_at` are the CALLER's, never the row's.
//
// The stored `payload` is not published as such: it is jsonb written by several producers. What a client needs from it
// is published as typed members — the link to the diagnosing surface (AC13) and the task the alert generated.

export const NOTIFICATION_SEVERITIES = ["info", "warning", "critical"] as const;
export const notificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

/**
 * AC13 — where the alert is diagnosed, with its filters pre-applied. `path` is an app route (`/p/{project_id}/prompts`,
 * `/settings/billing`); `query` holds the filter parameters that surface already reads from its URL (`engines`, `tf`,
 * `stability`, `finding`, `displacement`, `playbook`). A project path names the project by id.
 */
export const notificationDeepLinkSchema = z
  .object({
    path: z.string().regex(/^\/(?!\/)[A-Za-z0-9/_-]*$/u),
    query: z.record(z.string(), z.string()),
  })
  .strict();
export type NotificationDeepLink = z.infer<typeof notificationDeepLinkSchema>;

export const notificationSchema = z
  .object({
    id: z.string().uuid(),
    project_id: z.string().uuid().nullable(),
    /** `alert.<rule>` for a catalog alert (scoring-models.md §15), `usage.quota_threshold`, `credits.threshold`, or a producer's own kind. */
    kind: z.string().min(1),
    severity: notificationSeveritySchema,
    title: z.string(),
    body: z.string().nullable(),
    /** `workspace` = addressed to every member; `user` = addressed to the caller alone. */
    audience: z.enum(["workspace", "user"]),
    deep_link: notificationDeepLinkSchema.nullable(),
    /** The task the alert generated (scoring-models.md §15 "Generates"), or null. */
    task_id: z.string().uuid().nullable(),
    /** The caller's own read state. */
    read: z.boolean(),
    read_at: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .overwrite((value) => Math.min(value, PAGINATION_LIMIT_MAX))
      .max(PAGINATION_LIMIT_MAX)
      .default(PAGINATION_LIMIT_DEFAULT),
    /** `true` lists only what the caller has not read. */
    unread: z.enum(["true", "false"]).default("false"),
  })
  .strict();
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

/** The list body: the page AND the caller's unread count over the whole inbox (the bell badge), which one page cannot give. */
export const notificationListResponseSchema = z
  .object({
    notifications: z.array(notificationSchema),
    unread_count: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export const markNotificationReadResponseSchema = z
  .object({
    id: z.string().uuid(),
    read_at: z.string(),
    unread_count: z.number().int().nonnegative(),
  })
  .strict();
export type MarkNotificationReadResponse = z.infer<typeof markNotificationReadResponseSchema>;

export const markAllNotificationsReadResponseSchema = z
  .object({
    /** How many notifications this call marked read for the caller (0 when there was nothing unread). */
    marked: z.number().int().nonnegative(),
    unread_count: z.number().int().nonnegative(),
  })
  .strict();
export type MarkAllNotificationsReadResponse = z.infer<typeof markAllNotificationsReadResponseSchema>;
