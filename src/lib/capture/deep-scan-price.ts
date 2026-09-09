import type { ClientBase } from "pg";
import type { ResolvedEntitlementsResponse } from "../../../contracts/entitlements/resolved-entitlements.schema.js";
import { resolveEntitlements } from "../entitlements/resolution.js";
import { FeatureNotInPlanError, PreconditionUnmetError } from "../../api/errors/domain-errors.js";

// STORY-034 — what a manual deep scan costs.
//
// ONE FLAT PRICE, FROM THE PLAN, AND NOT FROM THE CELL COUNT.
// `plans-and-entitlements.md`'s schedule is `deep_scan.credits`:
//
//   free  starter  growth  business  enterprise
//   null    100     200      500     "negotiated"
//
// The price is cache-independent by design — fair-use.ts spells out why: a
// customer whose run was 90% cache-served pays the same as one whose run was
// not, because pricing per live cell would make the bill depend on what other
// tenants happened to ask recently. The live/cached split travels with the
// summary as work done, never as billing arithmetic.
//
// NOT AN `EntitlementGuard` KEY. §9's classification has two lists —
// structural limits and feature flags — and a PRICE is neither, so
// `classification.ts` correctly carries no entry for it and this module
// resolves it itself rather than a key being invented into that file to
// borrow the guard's refusal.

export const DEEP_SCAN_PRICE_KEY = "deep_scan.credits";

/** The schedule's numeric case, or null when the value is not a price. */
export function deepScanPriceFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The lowest tier whose schedule carries an actual number.
 *
 * Read rather than written down. `structural-usage.ts` makes the case against
 * the alternative: "a hardcoded `min_plan` is the same defect wearing a
 * different hat" — it keeps its own copy of the pricing table and goes stale
 * the first time the schedule moves. `plans.sort_order` already orders the
 * tiers and `plans.entitlements` already holds the values.
 */
async function lowestPricedPlan(tx: ClientBase): Promise<string | null> {
  const result = await tx.query<{ key: string }>(
    `SELECT key
       FROM plans
      WHERE jsonb_typeof(entitlements -> $1 -> 'value') = 'number'
      ORDER BY sort_order ASC
      LIMIT 1`,
    [DEEP_SCAN_PRICE_KEY],
  );
  return result.rows[0]?.key ?? null;
}

/**
 * The workspace's deep-scan price, resolved through plan, add-ons and overrides.
 *
 * The two non-numeric values in the schedule mean different things, and
 * conflating them would tell an enterprise customer to upgrade.
 *
 * `null` — the tier does not include manual deep scans. A free workspace can
 * be told that, and the remedy is a plan: `feature_not_in_plan` carries
 * `upgrade_plan` remediation by class.
 *
 * `"negotiated"` — enterprise, where the figure lives in the workspace's
 * `entitlement_overrides` because it was agreed per contract. When no
 * override has been written the price is genuinely unknown, and that is an
 * operator's unfinished setup rather than anything the customer did. Refusing
 * with `precondition_unmet` says so; inventing a number would charge against
 * a contract nobody agreed to, and defaulting to the business tier's 500
 * would silently under- or over-bill the largest accounts.
 */
export async function deepScanPriceOrThrow(
  tx: ClientBase,
  entitlements: ResolvedEntitlementsResponse["entitlements"],
): Promise<number> {
  const value = entitlements[DEEP_SCAN_PRICE_KEY]?.value ?? null;
  const price = deepScanPriceFrom(value);
  if (price !== null) return price;

  if (value === null || value === undefined) {
    throw new FeatureNotInPlanError({
      message: "manual deep scans are not included in this plan",
      details: { key: DEEP_SCAN_PRICE_KEY, min_plan: (await lowestPricedPlan(tx)) ?? "unknown" },
    });
  }
  throw new PreconditionUnmetError({
    message: `this workspace's deep-scan price resolves to "${String(value)}", which is not a credit figure`,
  });
}

/** The same, for a caller that has not resolved the entitlement set already. */
export async function deepScanPrice(tx: ClientBase, workspaceId: string): Promise<number> {
  return deepScanPriceOrThrow(tx, (await resolveEntitlements(tx, workspaceId)).entitlements);
}
