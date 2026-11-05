import { z } from "zod";
import { featureNotInPlanDetailsSchema, quotaExceededDetailsSchema } from "../common/error-details.schema.js";
import { methodologyFooterSchema } from "./methodology-footer.schema.js";
import { reportFormatSchema, reportSectionSchema, reportTimeframeSchema } from "./report-shared.schema.js";

// NEW-E-0 — POST /v1/projects/{id}/reports/export
//
// OWNER DECISION (plan: "take the planner's recommendation"): keep the
// FRONTEND's synchronous per-project path rather than api-specification §3's
// async `POST /exports`. The file is built in the request. The spec's async
// `/exports` is a week-2 item; that divergence is recorded here, not silently
// taken.
//
// STORY-180 (owner decision 54, 2026-11-02): the file is stored in the reports
// bucket (uploaded after the request commits). `download_url` is the API route
// GET /v1/exports/{id}/download (cookie-authenticated, export:data), which
// answers 302 to a presigned URL that lives 15 minutes, minted afresh on EVERY
// fetch from the STORED key (so an Idempotency-Key replay still downloads, and
// a click never lands before the upload does: 409 until the file is stored).
// It is no longer a `data:` URL; a client must open it (navigate or window.open,
// so the session cookie travels), not decode it. The redirect target carries
// `Content-Disposition: attachment; filename="<filename>"`.
//
// Permission export:data (step-up for owner/admin). 0 credits. One
// `pdf_exports` usage unit for PDF via @Meter; CSV is gated by exports.csv.
// Idempotency-Key is honoured (header, not part of this body).

/** How long the presigned URL an on-screen download redirects to stays valid (owner decision 54 (2)). */
export const EXPORT_DOWNLOAD_URL_SECONDS = 900;

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
    /** The API download route for this export (an http(s) URL). Opening it redirects to a fresh EXPORT_DOWNLOAD_URL_SECONDS presign. Never a `data:` URL. */
    download_url: z.url({ protocol: /^https?$/ }),
    /** Always present, in every format (NFR-AGY-05). */
    footer: methodologyFooterSchema,
    /** `cap` null = uncapped. 0 is a real cap (feature_not_in_plan), never "unknown". */
    pdf: z.object({ used: z.number().int().nonnegative(), cap: z.number().int().nonnegative().nullable() }).strict(),
  })
  .strict();

/** GET /v1/exports/{id}/download - `id` is report_artifacts.id (the response's `export_id`). */
export const exportDownloadParamsSchema = z.object({ id: z.uuid() }).strict();
export type ExportDownloadParams = z.infer<typeof exportDownloadParamsSchema>;

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
