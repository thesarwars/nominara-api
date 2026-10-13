import { z } from "zod";
import { errorCodeSchema } from "./error-code.schema.js";

// STORY-023 AC1 (T1) — api-specification.md §2 "Error taxonomy", as
// corrected by task T0d / decision D2. Every error response is served as
// `application/problem+json; charset=utf-8` (§1, §2) and carries RFC 9457's
// top-level members (`type`, `title`, `status`, `detail`) **plus** an
// `error` extension member carrying `code`, `message`, `details`,
// `remediation`, and `request_id` — the RFC shape is what a generic HTTP
// client already knows how to read, the `error` member is what a Nominara
// client actually renders. This file matches the §2 worked example
// field-for-field:
//
//   {
//     "type": "about:blank", "title": "Insufficient Credits", "status": 402,
//     "detail": "This action needs 500 Action Credits. Your wallet has 34 available.",
//     "error": {
//       "code": "insufficient_credits",
//       "message": "This action needs 500 Action Credits. Your wallet has 34 available.",
//       "details": { "required": 500, "available": 34, … },
//       "remediation": { "kind": "purchase_credits", "url": "/settings/billing?pack=agency_vault" },
//       "request_id": "4bf92f3577b34da6a3ce929d0e0e4736"
//     }
//   }
//
// `error.details` and `error.remediation` are **per-code and open at this
// stage**: §2's table gives each code its own `details.*` shape (and not
// every code carries one), and only one worked `remediation` shape is shown
// in the spec so far. The five distinct `NFR-API-13` spend-and-limit
// `details` shapes (`insufficient_credits`, `entitlement_exceeded`,
// `feature_not_in_plan`, `quota_exceeded`, `daily_limit_reached`) are
// STORY-024 / task T7's job, not this one's — modelling them here would be
// inventing a shape the reference has not committed to a schema yet.
export const problemRemediationSchema = z
  .object({
    kind: z.string().min(1),
  })
  .passthrough();

export type ProblemRemediation = z.infer<typeof problemRemediationSchema>;

export const problemErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    remediation: problemRemediationSchema.optional(),
    // STORY-024 AC9 — the OpenTelemetry trace id: 32 lowercase hex, server-generated.
    request_id: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

export type ProblemError = z.infer<typeof problemErrorSchema>;

export const problemDetailsSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1),
    status: z.number().int().min(100).max(599),
    detail: z.string().min(1),
    error: problemErrorSchema,
  })
  .strict();

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
