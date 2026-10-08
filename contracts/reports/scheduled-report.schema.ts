import { z } from "zod";
import { reportFormatSchema, reportSectionSchema, reportTimeframeSchema } from "./report-shared.schema.js";

// NEW-E-0 — /v1/scheduled-reports (GET/POST/PATCH/DELETE) and
// POST /v1/scheduled-reports/{id}/send-now. Permission agency:branding.
//
// Field names follow the frontend's ScheduledReport (pending.ts); the service
// maps label<->name, day<->day_of_period, hour<->send_hour_local,
// paused<->NOT active, next_run_at<->next_send_at, sections<->include_sections.
//
// OWNER DECISION: while email is only logged, a delivery reads `logged`, never
// `delivered` (honesty rule). The frontend status union gains `logged`.
// `scheduled_report_deliveries` (NEW-E-1) is the history table; the status
// vocabulary here is its CHECK.

export const scheduleCadenceSchema = z.enum(["weekly", "biweekly", "monthly", "quarterly"]);
export const scheduleFormatSchema = z.enum([...reportFormatSchema.options, "both"]);
export const deliveryStatusSchema = z.enum(["delivered", "failed", "skipped_cap", "logged"]);

export const scheduledReportDeliverySchema = z
  .object({
    delivery_id: z.uuid(),
    at: z.iso.datetime(),
    status: deliveryStatusSchema,
    /** Failure reason or the cap/reset-date message for skipped_cap; null otherwise. */
    reason: z.string().nullable(),
    recipients: z.number().int().nonnegative(),
  })
  .strict();

const scheduleFieldsShape = {
  label: z.string().trim().min(1).max(120),
  project_ids: z.array(z.uuid()).min(1),
  sections: z.array(reportSectionSchema).min(1),
  cadence: scheduleCadenceSchema,
  /** Day of the period (weekday 1-7 for weekly/biweekly; day of month otherwise); the service range-checks it per cadence. */
  day: z.number().int().min(1).max(28),
  /** Workspace-local hour, 0-23. */
  hour: z.number().int().min(0).max(23),
  format: scheduleFormatSchema,
  recipients: z.array(z.email()).min(1).max(25),
  timeframe: reportTimeframeSchema,
  /** Pinned theme; null = workspace default. Must belong to the same workspace. */
  theme_id: z.uuid().nullable(),
};

// Defaults live on CREATE only. A default inside a shared shape would survive
// `.partial()` and silently reset timeframe/theme_id on every PATCH.
export const createScheduledReportRequestSchema = z
  .object({
    ...scheduleFieldsShape,
    timeframe: scheduleFieldsShape.timeframe.default("30d"),
    theme_id: scheduleFieldsShape.theme_id.default(null),
  })
  .strict();

/** The frontend only toggles `paused`, but every field is patchable. At least one key is required. */
export const updateScheduledReportRequestSchema = z
  .object({
    ...z.object(scheduleFieldsShape).partial().shape,
    paused: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const scheduledReportSchema = z
  .object({
    id: z.uuid(),
    label: z.string(),
    project_ids: z.array(z.uuid()),
    sections: z.array(reportSectionSchema),
    cadence: scheduleCadenceSchema,
    day: z.number().int(),
    hour: z.number().int(),
    format: scheduleFormatSchema,
    recipients: z.array(z.string()),
    timeframe: reportTimeframeSchema,
    theme_id: z.uuid().nullable(),
    paused: z.boolean(),
    next_run_at: z.iso.datetime().nullable(),
    /** Every attempt is listed, including failures and cap skips — never silently dropped. */
    deliveries: z.array(scheduledReportDeliverySchema),
  })
  .strict();

export const scheduledReportListResponseSchema = z.array(scheduledReportSchema);

export type CreateScheduledReportRequest = z.infer<typeof createScheduledReportRequestSchema>;
export type UpdateScheduledReportRequest = z.infer<typeof updateScheduledReportRequestSchema>;
export type ScheduledReport = z.infer<typeof scheduledReportSchema>;
export type ScheduledReportDelivery = z.infer<typeof scheduledReportDeliverySchema>;

// NEW-E-100c — POST /v1/scheduled-reports/{id}/send-now returns the delivery
// attempt it produced. A cap skip is a 200 whose status is `skipped_cap` and
// whose `reason` names the cap and the reset date: the skip is an outcome the
// caller is told about, never an error and never silent. A tier with no export
// allowance is NOT an attempt: it is the 403 feature_not_in_plan refusal.
export const sendScheduledReportNowResponseSchema = scheduledReportDeliverySchema;
export type SendScheduledReportNowResponse = z.infer<typeof sendScheduledReportNowResponseSchema>;
