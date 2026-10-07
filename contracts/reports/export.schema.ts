import { z } from "zod";
import { featureNotInPlanDetailsSchema, quotaExceededDetailsSchema } from "../common/error-details.schema.js";
import { methodologyFooterSchema } from "./methodology-footer.schema.js";
import { reportFormatSchema, reportSectionSchema, reportTimeframeSchema } from "./report-shared.schema.js";

// NEW-E-0 — POST /v1/projects/{id}/reports/export
//
// OWNER DECISION (plan: "take the planner's recommendation"): keep the
// FRONTEND's synchronous per-project path rather than api-specification §3's
// async `POST /exports`. Artifact storage is inline for week 1, so the file
// comes back as a `data:` URL and the row in `report_artifacts` stores
// object_key = 'inline:<id>'. The spec's async `/exports` is a week-2 item;
// that divergence is recorded here, not silently taken.
//
// Permission export:data (step-up for owner/admin). 0 credits. One
// `pdf_exports` usage unit for PDF via @Meter; CSV is gated by exports.csv.
// Idempotency-Key is honoured (header, not part of this body).

export const exportRequestSchema = z
  .object({
    format: reportFormatSchema,
    sections: z.array(reportSectionSchema).min(1),
    timeframe: reportTimeframeSchema,
    hide_competitors: z.boolean(),
    hide_costs: z.boolean(),
  })
  .strict();

export const exportResponseSchema = z
  .object({
    /** report_artifacts.id */
    export_id: z.uuid(),
    format: reportFormatSchema,
    filename: z.string().min(1),
    download_url: z.string().min(1),
    /** Always present, in every format (NFR-AGY-05). */
    footer: methodologyFooterSchema,
    /** `cap` null = uncapped. 0 is a real cap (feature_not_in_plan), never "unknown". */
    pdf: z.object({ used: z.number().int().nonnegative(), cap: z.number().int().nonnegative().nullable() }).strict(),
  })
  .strict();

/**
 * Export refusal keeps the two conditions distinct (NFR-API-13):
 *   403 feature_not_in_plan — a tier with ZERO allowance ("zero stays zero")
 *   429 quota_exceeded      — a non-zero allowance that is used up
 * Both reuse the shared details shapes; neither is redefined here.
 */
export const exportFeatureNotInPlanDetailsSchema = featureNotInPlanDetailsSchema;
export const exportQuotaExceededDetailsSchema = quotaExceededDetailsSchema;

export type ExportRequest = z.infer<typeof exportRequestSchema>;
export type ExportResponse = z.infer<typeof exportResponseSchema>;
