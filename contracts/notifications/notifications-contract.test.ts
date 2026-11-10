import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  notificationDeepLinkSchema,
  notificationListQuerySchema,
  notificationListResponseSchema,
  notificationSchema,
  notificationPreferencesSchema,
  updateNotificationPreferencesRequestSchema,
} from "./index.js";

const row = {
  id: "0190a000-0000-7000-8000-000000000001",
  project_id: null,
  kind: "alert.sov_drop_engine",
  severity: "warning",
  title: "t",
  body: null,
  audience: "workspace",
  deep_link: { path: "/p/0190a000-0000-7000-8000-000000000002/prompts", query: { engines: "gemini", tf: "7d" } },
  task_id: null,
  read: false,
  read_at: null,
  created_at: "2026-10-23T00:00:00.000Z",
} as const;

describe("STORY-068 · notification contracts", () => {
  it("[AC6] a notification carries kind, severity, title, body, its audience and a typed deep link", () => {
    expect(notificationSchema.safeParse(row).success).toBe(true);
    // The raw producer payload is not part of the wire shape.
    expect(notificationSchema.safeParse({ ...row, payload: {} }).success).toBe(false);
  });

  it("[AC13] a deep link is an app path with string filter parameters; an absolute URL is refused", () => {
    expect(notificationDeepLinkSchema.safeParse({ path: "https://evil.example/x", query: {} }).success).toBe(false);
    expect(notificationDeepLinkSchema.safeParse({ path: "//evil", query: {} }).success).toBe(false);
    expect(notificationDeepLinkSchema.safeParse({ path: "/settings/billing", query: {} }).success).toBe(true);
  });

  it("[AC8] the list body carries the caller's unread count beside the page", () => {
    expect(notificationListResponseSchema.safeParse({ notifications: [row], unread_count: 1 }).success).toBe(true);
    expect(notificationListQuerySchema.parse({})).toEqual({ limit: 50, unread: "false" });
    expect(notificationListQuerySchema.safeParse({ unread: "yes" }).success).toBe(false);
  });

  it("[owner 2026-10-23] a preference is off, daily or weekly, and null restores the role default", () => {
    for (const cadence of ["off", "daily", "weekly", null]) expect(updateNotificationPreferencesRequestSchema.safeParse({ digest_cadence: cadence }).success, String(cadence)).toBe(true);
    expect(updateNotificationPreferencesRequestSchema.safeParse({ digest_cadence: "monthly" }).success).toBe(false);
    expect(updateNotificationPreferencesRequestSchema.safeParse({}).success).toBe(false);
  });

  it("[owner decision 96a] sentiment_alerts is a boolean the caller sets alone, or null to return to the default (on)", () => {
    for (const value of [true, false, null]) expect(updateNotificationPreferencesRequestSchema.safeParse({ sentiment_alerts: value }).success, String(value)).toBe(true);
    expect(updateNotificationPreferencesRequestSchema.safeParse({ sentiment_alerts: false, digest_cadence: "daily" }).success).toBe(true);
    expect(updateNotificationPreferencesRequestSchema.safeParse({ sentiment_alerts: "off" }).success).toBe(false);
    expect(notificationPreferencesSchema.safeParse({ digest_cadence: "weekly", is_default: true, sentiment_alerts: true }).success).toBe(true);
    expect(notificationPreferencesSchema.safeParse({ digest_cadence: "weekly", is_default: true }).success).toBe(false);
  });

  it("every schema is representable in JSON Schema (the client is generated from it)", () => {
    for (const schema of [notificationSchema, notificationListQuerySchema, notificationListResponseSchema]) expect(() => z.toJSONSchema(schema, { io: "input" })).not.toThrow();
  });
});
