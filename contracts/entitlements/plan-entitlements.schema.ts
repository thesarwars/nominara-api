import { z } from "zod";
import { ENTITLEMENT_KEYS } from "../../src/db/seed/plan-entitlements.js";

// KAD-05: zod is the single contract source. This schema is what
// coding-standards.md §"Contracts/validation rules" means by "every jsonb
// column has a documented shape ... and a zod schema in contracts" — it
// validates `plans.entitlements` (schemas/billing-and-credits.md).
//
// STORY-069 AC1 and AC2: every key now carries a LIVE FLAG, and the seed is
// validated against this schema.
//
// WHY THE FLAG IS PER KEY RATHER THAN A LIST OF UNBUILT FEATURES.
// §2's not-live table includes `whitelabel.custom_domain`, which is also a
// real matrix row with real per-tier values — `true` on Business and
// Enterprise, and "live at launch + 30 days". So a key can carry a genuine
// granted value and still not be live. A separate list would have to be
// consulted by every consumer and would be forgotten by one of them; a flag
// on the value cannot be read without being seen.
//
// The per-value type stays a union rather than being tightened per key. The
// matrix genuinely mixes types for the SAME key across tiers —
// `optimizer.enabled` is `false` on free, `"unlimited"` on starter, and
// `true` elsewhere; `exports.pdf_per_cycle` is `0`, `25`, then `"unlimited"`.
// A per-key type would therefore have to be a union of exactly those three
// anyway, and would encode today's tier values into the type, so a plan edit
// — the thing AC11 requires to work with no redeploy — would stop type
// checking. Pinning the KEY SET exactly is what this schema is for.
export const entitlementValueSchema = z.union([z.number(), z.boolean(), z.string(), z.null()]);

export const entitlementSchema = z
  .object({
    value: entitlementValueSchema,
    live: z.boolean(),
  })
  .strict();

const entitlementShape = Object.fromEntries(ENTITLEMENT_KEYS.map((key) => [key, entitlementSchema])) as Record<
  (typeof ENTITLEMENT_KEYS)[number],
  typeof entitlementSchema
>;

export const planEntitlementsSchema = z.object(entitlementShape).strict();

export type Entitlement = z.infer<typeof entitlementSchema>;
export type PlanEntitlements = z.infer<typeof planEntitlementsSchema>;
