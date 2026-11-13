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
    /**
     * STORY-096 AC15 - the two customer-visible DAILY caps (plans-and-entitlements.md section 2). Capture-backed tool runs are one counter shared
     * across every tool; command parses are the model-resolved ones (locally-resolved commands are free and uncounted). `used` is today's UTC-day
     * count and `cap` the plan's CURRENT limit, `null` where the plan sets none (every paid tier). They are read from `credit_daily_counters`, not
     * `usage_counters`, and a purchased pack never moves them. All three are OPTIONAL in the contract only because a new required response field is
     * classified a MAJOR change by contracts:diff and these are purely additive; the server always sends them.
     */
    daily_lookups: usageMeterSchema.optional(),
    daily_nlp_parses: usageMeterSchema.optional(),
    /** The next UTC midnight, when both daily counters roll over. */
    daily_resets_at: z.iso.datetime().optional(),
  })
  .strict();

export type UsageMeter = z.infer<typeof usageMeterSchema>;
export type UsageResponse = z.infer<typeof usageResponseSchema>;
