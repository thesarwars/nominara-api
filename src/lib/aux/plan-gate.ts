import type { ClientBase } from "pg";
import { FeatureNotInPlanError } from "../../api/errors/domain-errors.js";
import { grantedValueSql } from "../entitlements/granted.js";
import { AUX_AUDITS_ENTITLEMENT, auxAuditsIncluded } from "./onboarding-audit.js";

/** The paid-plan gate on the full page audit (decision 47), shared by the in-project route and the tool route so the two cannot drift. 403 `feature_not_in_plan`, naming the lowest unlocking plan. */
export async function requireAuxAudits(tx: ClientBase, entitlements: Readonly<Record<string, { readonly value: unknown } | undefined>>): Promise<void> {
  if (auxAuditsIncluded(entitlements)) return;
  const lowest = await tx.query<{ key: string }>(
    `SELECT key FROM plans WHERE is_public AND ${grantedValueSql("(entitlements -> $1 -> 'value')")} ORDER BY sort_order ASC LIMIT 1`,
    [AUX_AUDITS_ENTITLEMENT],
  );
  throw new FeatureNotInPlanError({
    message: "AUX audits are not included in this plan",
    details: { key: AUX_AUDITS_ENTITLEMENT, min_plan: lowest.rows[0]?.key ?? "unknown" },
  });
}
