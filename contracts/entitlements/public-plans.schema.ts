import { z } from "zod";
import { addonGrantSchema, addonKindSchema } from "../billing/addon.schema.js";
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

/** A one-time credit pack (`credit_packs`, public rows only). The Stripe price id and every internal column stay out of the body. */
export const publicCreditPackSchema = z
  .object({
    key: z.string().min(1),
    display_name: z.string().min(1),
    credits: z.number().int().positive(),
    /** `numeric(12,2)` as text, never a float. */
    price: z.string().regex(/^\d+\.\d{2}$/),
    currency: z.string().length(3),
    /** The cheapest plan that can buy it, or `null` for every plan. */
    min_plan_key: z.string().nullable(),
    sort_order: z.number().int(),
  })
  .strict();

/**
 * A subscription add-on (extra project, extra seat): its monthly price, the plans that may buy it (the plan flag `projects.addon_allowed` /
 * `seats.addon_allowed`, read from the plans the body already carries) and what ONE unit grants on each of them. The extra project states its
 * prompt slots (FR-CRD-05): the grant is the resolver's own arithmetic, so the line on the page and the resolved entitlements cannot disagree.
 */
export const publicAddonSchema = z
  .object({
    kind: addonKindSchema,
    display_name: z.string().min(1),
    monthly_usd: z.string().regex(/^\d+\.\d{2}$/),
    currency: z.literal("USD"),
    /** Plan keys that may buy it, in plan order. */
    available_on_plans: z.array(z.string().min(1)),
    /** `plan_key -> what one unit grants on that plan`, for the plans above only. */
    grant_by_plan: z.record(z.string(), addonGrantSchema),
  })
  .strict();

export const publicAddonsSchema = z.object({ credit_packs: z.array(publicCreditPackSchema), subscription: z.array(publicAddonSchema) }).strict();

export const publicPlansResponseSchema = z
  .object({
    plans: z.array(publicPlanSchema),
    /** Engines that can be captured (`status <> 'disabled'`); a disabled engine is a claim the product cannot keep. */
    engines: z.array(publicEngineCadenceSchema),
    /** The add-on rows (FR-CRD-15: no hardcoded price or limit on the page): credit packs and the two subscription add-ons, live-filtered like the plans. */
    addons: publicAddonsSchema,
    generated_at: z.iso.datetime(),
  })
  .strict();

export type PublicPlan = z.infer<typeof publicPlanSchema>;
export type PublicEngineCadence = z.infer<typeof publicEngineCadenceSchema>;
export type PublicCreditPack = z.infer<typeof publicCreditPackSchema>;
export type PublicAddon = z.infer<typeof publicAddonSchema>;
export type PublicPlansResponse = z.infer<typeof publicPlansResponseSchema>;
