import { z } from "zod";
import { reportTimeframeSchema } from "../reports/report-shared.schema.js";

// STORY-111 / NFR-CMP-02, NFR-CMP-13 - the machine-readable export a right-of-access request returns.
//
// NFR-CMP-13: "Every metric in every export carries scoring version, engine set, timeframe, sample size, live-capture ratio, and the
// data-through timestamp, so a compliance or legal team can always reconstruct what a number meant." All six are REQUIRED keys here;
// `live_capture_ratio` and `data_through` are nullable because "nothing measured" is a different statement from 0 and from "today".

export const subjectExportMetricMetadataSchema = z
  .object({
    scoring_version: z.string().min(1),
    engines: z.array(z.string()),
    timeframe: reportTimeframeSchema,
    sample_size: z.number().int().nonnegative(),
    live_capture_ratio: z.number().min(0).max(1).nullable(),
    data_through: z.string().nullable(),
  })
  .strict();
export type SubjectExportMetricMetadata = z.infer<typeof subjectExportMetricMetadataSchema>;

export const subjectExportMetricSchema = z
  .object({
    workspace_id: z.uuid(),
    project_id: z.uuid(),
    metric: z.literal("visibility_score"),
    /** null = no score in the window (not 0). */
    value: z.number().nullable(),
    metadata: subjectExportMetricMetadataSchema,
  })
  .strict();
export type SubjectExportMetric = z.infer<typeof subjectExportMetricSchema>;

export const subjectExportTableSchema = z
  .object({
    table: z.string().min(1),
    /** The columns whose value identifies the subject. */
    subject_columns: z.array(z.string()).min(1),
    /** Secret-bearing columns are named here and never exported. */
    omitted_columns: z.array(z.string()),
    row_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    rows: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();

export const subjectExportSchema = z
  .object({
    format_version: z.literal(1),
    request_id: z.uuid(),
    subject_user_id: z.uuid(),
    generated_at: z.iso.datetime(),
    profile: z.record(z.string(), z.unknown()).nullable(),
    tables: z.array(subjectExportTableSchema),
    metrics: z.array(subjectExportMetricSchema),
  })
  .strict();
export type SubjectExport = z.infer<typeof subjectExportSchema>;

/** The audit actions that make a request traceable end to end (AC: received, processed, completed, actor recorded). */
export const subjectRequestAuditActionSchema = z.enum([
  "subject_request.received",
  "subject_request.processed",
  "subject_request.completed",
  "subject_request.blocked",
  /** Erasure queued, not run: a legal hold covers a workspace of the subject (owner decision 68b). It runs when the hold lapses or is released. */
  "subject_request.deferred",
  "subject_request.failed",
]);
export type SubjectRequestAuditAction = z.infer<typeof subjectRequestAuditActionSchema>;
export const subjectRequestKindSchema = z.enum(["access", "erasure"]);
export type SubjectRequestKind = z.infer<typeof subjectRequestKindSchema>;
