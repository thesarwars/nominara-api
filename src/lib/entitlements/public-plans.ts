import { z } from "zod";
import {
  PUBLIC_PLANS_WITHHELD_KEYS,
  publicEngineCadenceSchema,
  type PublicEngineCadence,
  type PublicPlan,
} from "../../../contracts/entitlements/public-plans.schema.js";
import { entitlementSchema, entitlementValueSchema } from "../../../contracts/entitlements/plan-entitlements.schema.js";
import type { PublicAddon, PublicCreditPack } from "../../../contracts/entitlements/public-plans.schema.js";
import { ADDON_CATALOG, addonGrant } from "../billing/addon-catalog.js";
import { ADDON_KINDS } from "./resolution.js";

// STORY-103 (API part) - the one live filter behind `GET /v1/public/plans`. Pure: no I/O, so the pricing page's snapshot and the
// in-app comparison cannot disagree about what is live (plans-and-entitlements.md section 12, "one flag, two consumers").
//
// FAIL CLOSED. `plans.entitlements` is a jsonb column, so a row can hold anything. A document that is not `{key: {value, live}}`
// is refused rather than published: a public body assembled from a malformed row is a claim nobody checked.

const WITHHELD: ReadonlySet<string> = new Set(PUBLIC_PLANS_WITHHELD_KEYS);

const storedEntitlementsSchema = z.record(z.string(), entitlementSchema);

/** `key -> value` for the keys that carry `live: true` and are not on the withheld list. Everything else is absent. */
export function publicEntitlementsFrom(raw: unknown): Record<string, z.infer<typeof entitlementValueSchema>> {
  const stored = storedEntitlementsSchema.parse(raw);
  const out: Record<string, z.infer<typeof entitlementValueSchema>> = {};
  for (const [key, entitlement] of Object.entries(stored)) {
    if (entitlement.live && !WITHHELD.has(key)) out[key] = entitlement.value;
  }
  return out;
}

export interface PlanRow {
  readonly key: string;
  readonly display_name: string;
  readonly currency: string;
  readonly sort_order: number;
  readonly entitlements: unknown;
}

export function publicPlanFrom(row: PlanRow): PublicPlan {
  return {
    key: row.key,
    display_name: row.display_name,
    // `char(3)` comes back padded by some drivers; an ISO code has no spaces.
    currency: row.currency.trim(),
    sort_order: row.sort_order,
    entitlements: publicEntitlementsFrom(row.entitlements),
  };
}

export interface EngineRow {
  readonly key: string;
  readonly display_name: string;
  readonly cadence_by_plan: unknown;
}

export function publicEngineFrom(row: EngineRow): PublicEngineCadence {
  return publicEngineCadenceSchema.parse({ engine_key: row.key, display_name: row.display_name, cadence_by_plan: row.cadence_by_plan });
}

export interface CreditPackRow {
  readonly key: string;
  readonly display_name: string;
  readonly credits: number;
  readonly price_usd: string;
  readonly currency: string;
  readonly min_plan_key: string | null;
  readonly sort_order: number;
}

export function publicCreditPackFrom(row: CreditPackRow): PublicCreditPack {
  return {
    key: row.key,
    display_name: row.display_name,
    credits: row.credits,
    price: row.price_usd,
    currency: row.currency.trim(),
    min_plan_key: row.min_plan_key,
    sort_order: row.sort_order,
  };
}

/**
 * The two subscription add-ons: the catalog's price, the plans whose own `*.addon_allowed` flag is live and true, and what ONE unit grants on each.
 * The grant is `addonGrant` - the resolver's own arithmetic - over the plan's STORED entitlements (not the filtered body), so the extra project's
 * prompt slots (FR-CRD-05) are stated even where `prompts.max_per_project` is not itself published. Fails closed on a malformed plan document.
 */
export function publicAddonsFrom(plans: readonly PlanRow[]): PublicAddon[] {
  const parsed = plans.map((row) => ({ key: row.key, stored: storedEntitlementsSchema.parse(row.entitlements) }));
  return ADDON_KINDS.map((kind): PublicAddon => {
    const entry = ADDON_CATALOG[kind];
    const available = parsed.filter((p) => p.stored[entry.allowedKey]?.live === true && p.stored[entry.allowedKey]?.value === true);
    return {
      kind,
      display_name: entry.displayName,
      monthly_usd: entry.monthlyUsd,
      currency: "USD",
      available_on_plans: available.map((p) => p.key),
      grant_by_plan: Object.fromEntries(available.map((p) => [p.key, addonGrant(p.stored, kind)])),
    };
  });
}
