import { z } from "zod";

// NEW-D-1 — `GET /v1/billing/usage` (billing:read). The spec lists the route
// with no shape; this is the owner-approved one (the demo's, made explicit).
//
// Only CUSTOMER-VISIBLE caps appear. `usage_counters` also holds
// `fair_use_captures` (deliberately unpublished) and the internal token
// observability metrics; none are exposed (billing-and-credits.md).
//
// ⚠ `cap` NULL MEANS UNLIMITED AND `cap` 0 MEANS THE TIER HAS NONE. They are
// different: 0 is `403 feature_not_in_plan` territory, null is no ceiling.
// (The column stores unlimited as -1; the handler maps it to null.)
export const usageMeterSchema = z
  .object({
    used: z.number().int().nonnegative(),
    cap: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const usageResponseSchema = z
  .object({
    /** `YYYY-MM-DD`, the counter period these figures belong to. */
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    pdf_exports: usageMeterSchema,
    /** Live (unrevoked, unexpired) share tokens. A gauge, not a period counter. */
    share_links_active: z.number().int().nonnegative(),
  })
  .strict();

export type UsageMeter = z.infer<typeof usageMeterSchema>;
export type UsageResponse = z.infer<typeof usageResponseSchema>;
