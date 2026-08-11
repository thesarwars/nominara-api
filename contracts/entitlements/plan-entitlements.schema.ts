import { z } from "zod";
import { ENTITLEMENT_KEYS } from "../../src/db/seed/plan-entitlements.js";

// KAD-05: zod is the single contract source. This schema is what
// coding-standards.md §"Contracts/validation rules" means by "every jsonb
// column has a documented shape ... and a zod schema in contracts" — it
// validates `plans.entitlements` (schemas/billing-and-credits.md).
//
// Deliberately permissive per-value type (STORY-007 scope): the matrix mixes
// numbers, booleans, and descriptive strings for the same key across tiers
// (e.g. `optimizer.enabled` is `false` on free, `"unlimited"` on starter,
// `true` elsewhere). STORY-069 ("Plans seed, entitlement resolution") owns
// tightening per-key types and adding the live-flag wrapper once resolution
// semantics are built; this schema's job is to pin the *key set* exactly —
// an unknown or missing key fails validation — while leaving the value
// shape permissive enough to hold every real value in the reference matrix.
const entitlementValueSchema = z.union([z.number(), z.boolean(), z.string(), z.null()]);

const entitlementShape = Object.fromEntries(
  ENTITLEMENT_KEYS.map((key) => [key, entitlementValueSchema]),
) as Record<(typeof ENTITLEMENT_KEYS)[number], typeof entitlementValueSchema>;

export const planEntitlementsSchema = z.object(entitlementShape).strict();

export type PlanEntitlements = z.infer<typeof planEntitlementsSchema>;
