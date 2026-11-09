import { z } from "zod";
import { entitlementValueSchema } from "./plan-entitlements.schema.js";

// STORY-103 (API part) - `GET /v1/public/plans`: the live-filtered plans snapshot the pricing page is built from and the in-app
// plan comparison reads. Public and unauthenticated, global data only (`plans`, `engines`; no `workspace_id`).
//
// ONE FLAG, TWO CONSUMERS (plans-and-entitlements.md section 12). A key reaches this body only if it carries `live: true` in
// `plans.entitlements`; a deferred key is ABSENT, not greyed out and not flagged. So the body carries bare values, and a consumer
// has no flag to forget to check.
//
// PUBLIC, SO WITHHELD AS WELL AS FILTERED. Two live keys are not customer concepts and must not be published
// (FR-CRD-19: the fair-use ceiling; FR-CRD-26 / FR-CRD-24: the internal credit price of a deep scan). Neither is ever in this body,
// whatever its live flag says. The list is closed and lives here so the service and its tests read one definition.
export const PUBLIC_PLANS_WITHHELD_KEYS = ["fair_use.captures_per_cycle", "deep_scan.credits"] as const;

export const publicPlanSchema = z
  .object({
    key: z.string().min(1),
    display_name: z.string().min(1),
    /** ISO 4217, from `plans.currency`. Always stated, never inferred from the visitor. */
    currency: z.string().length(3),
    sort_order: z.number().int(),
    /** Live, non-withheld entitlement keys only, as `key -> value`. Prices are the `price.*` keys; there is no second copy. */
    entitlements: z.record(z.string(), entitlementValueSchema),
  })
  .strict();

/** `engines.cadence_by_plan` verbatim: `plan_key -> run_kind -> runs per 30-day cycle` (the per-engine refresh table, FR-CRD-17). */
export const publicEngineCadenceSchema = z
  .object({
    engine_key: z.string().min(1),
    display_name: z.string().min(1),
    cadence_by_plan: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())),
  })
  .strict();

export const publicPlansResponseSchema = z
  .object({
    plans: z.array(publicPlanSchema),
    /** Engines that can be captured (`status <> 'disabled'`); a disabled engine is a claim the product cannot keep. */
    engines: z.array(publicEngineCadenceSchema),
    generated_at: z.iso.datetime(),
  })
  .strict();

export type PublicPlan = z.infer<typeof publicPlanSchema>;
export type PublicEngineCadence = z.infer<typeof publicEngineCadenceSchema>;
export type PublicPlansResponse = z.infer<typeof publicPlansResponseSchema>;
