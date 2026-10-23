import { z } from "zod";

// STORY-068 — OWNER DECISION 2026-10-23: the email digest is WEEKLY by default for owners, admins and managers; each
// member switches THEIR OWN to daily or off. `GET`/`PATCH /v1/workspaces/{id}/notification-preferences` (`workspace:read`:
// the caller's own membership row, never another member's).
//
// `off` stops alert email entirely for the caller in this workspace, the immediate critical email included; the in-app
// inbox is unaffected. Analysts and viewers default to `off` and may opt in.

export const DIGEST_CADENCES = ["off", "daily", "weekly"] as const;
export const digestCadenceSchema = z.enum(DIGEST_CADENCES);
export type DigestCadence = z.infer<typeof digestCadenceSchema>;

export const notificationPreferencesSchema = z
  .object({
    digest_cadence: digestCadenceSchema,
    /** True while the caller has not chosen: the cadence shown is their role's default. */
    is_default: z.boolean(),
  })
  .strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** `null` returns the caller to their role's default. */
export const updateNotificationPreferencesRequestSchema = z
  .object({
    digest_cadence: digestCadenceSchema.nullable(),
  })
  .strict();
export type UpdateNotificationPreferencesRequest = z.infer<typeof updateNotificationPreferencesRequestSchema>;
