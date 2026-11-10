import { z } from "zod";

// STORY-068 — OWNER DECISION 2026-10-23: the email digest is WEEKLY by default for owners, admins and managers; each
// member switches THEIR OWN to daily or off. `GET`/`PATCH /v1/workspaces/{id}/notification-preferences` (`workspace:read`:
// the caller's own membership row, never another member's).
//
// OWNER DECISION 96(a), 2026-11-10: a per-member sentiment-alerts setting (`workspace_members.sentiment_alerts_enabled`, NULL = on, which is every
// existing member's behaviour). Off stops `alert.negative_spike` for THAT member in both places it reaches them: the email and the inbox. The
// onboarding persona step sets it through this same route.
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
    /** Whether negative-sentiment spike alerts reach the caller (email and inbox). On until the caller turns it off. */
    sentiment_alerts: z.boolean(),
  })
  .strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** `null` returns the caller to their role's default. */
export const updateNotificationPreferencesRequestSchema = z
  .object({
    digest_cadence: digestCadenceSchema.nullable().optional(),
    /** `null` returns to the default, on. Omitted leaves it as it is. */
    sentiment_alerts: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((body) => body.digest_cadence !== undefined || body.sentiment_alerts !== undefined, { message: "set digest_cadence, sentiment_alerts or both" });
export type UpdateNotificationPreferencesRequest = z.infer<typeof updateNotificationPreferencesRequestSchema>;
