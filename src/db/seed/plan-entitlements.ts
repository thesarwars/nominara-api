// Transcribed row-by-row from plans-and-entitlements.md §2's entitlement
// matrix, in the exact row order the table appears in that document, so a
// future diff against the reference is a straight visual comparison.
//
// Value encoding decision (STORY-007 scope, not STORY-069's):
//   - "—" (not applicable for that tier)      -> null
//   - a plain "✓" / "✗"                        -> true / false
//   - "✓ (detail)" where the detail carries a  -> the detail as a descriptive
//     distinct number/cadence/qualifier           string, e.g. "10_active"
//   - a plain number or "custom"/"negotiated"/ -> the number, or that string,
//     "uncapped"/"unlimited"                      verbatim
//
// STORY-069 ("Plans seed, entitlement resolution") is explicitly upstream of
// this story's output and owns two refinements this seed does NOT attempt:
// wrapping every key with a `live` flag, and full zod-validated resolution
// semantics. This story's job is narrower — get the real matrix values into
// the database so `workspaces.plan_key` has something to reference and the
// property "a plan change is a data change" starts existing.
export type EntitlementValue = number | boolean | string | null;

type Tier = "free" | "starter" | "growth" | "business" | "enterprise";

const TIERS: readonly Tier[] = ["free", "starter", "growth", "business", "enterprise"] as const;

// [key, free, starter, growth, business, enterprise] — same row order as the
// reference table.
const MATRIX: ReadonlyArray<readonly [string, ...EntitlementValue[]]> = [
  ["price.monthly_usd", 0, 49, 129, 349, "custom"],
  ["price.annual_usd", null, 490, 1290, 3490, "custom"],
  ["workspaces.owned_max", 1, 1, 1, 1, 1],
  ["projects.max", 0, 1, 3, 5, "custom"],
  ["projects.addon_allowed", false, false, true, true, null],
  ["prompts.max_per_project", null, 30, 40, 50, "custom"],
  ["prompts.max_total", 0, 30, 120, 250, "uncapped"],
  ["prompts.free_at_creation", null, 10, 10, 10, 10],
  // Free is 1 too (owner decision 67a): Prompt Research Keep costs 1 credit per kept prompt from the included credits. Free has no project, so in-project generation never reads it.
  ["prompts.credits_per_generated", 1, 1, 1, 1, 1],
  ["seats.max", 1, 3, 7, 20, "unlimited"],
  ["seats.addon_allowed", false, true, true, true, null],
  ["competitors.max_per_project", null, 10, 10, 10, "custom"],
  ["engines.enabled", "none_tools_only", "3_core", 4, 6, "all_6_plus_private"],
  ["tools.engine_set", 2, 3, 4, 4, 4],
  ["tools.engines_selectable", false, false, false, false, false],
  ["deep_scan.credits", null, 100, 200, 500, "negotiated"],
  ["scan.cadence", null, "weekly", "twice_weekly", "daily_priority", "hourly_priority"],
  ["scan.runs_per_cycle", null, 4, 8, "4_full_plus_26_priority", "negotiated"],
  ["scan.priority_subset_size", null, null, null, 50, "50_default"],
  ["credits.included_per_cycle", 60, 450, 1200, 3000, "custom"],
  ["credits.lookups_per_day_max", 3, null, null, null, null],
  ["credits.nlp_parses_per_day_max", 20, null, null, null, null],
  ["credits.rollover_purchased_months", 12, 12, 12, 12, 12],
  ["credits.packs_purchasable", true, true, true, true, true],
  ["exports.pdf_per_cycle", 0, 0, 25, "unlimited", "unlimited"],
  ["exports.csv", false, false, true, true, true],
  ["share_links.enabled", false, false, "10_active", "50_active", "unlimited"],
  ["whitelabel.custom_domain", false, false, false, true, true],
  ["whitelabel.remove_branding", false, false, false, true, true],
  ["whitelabel.email_digest", false, false, false, "weekly", "configurable"],
  ["integrations.gsc", false, false, true, true, true],
  ["optimizer.enabled", false, "unlimited", true, true, true],
  [
    "aux.scheduled_audits",
    false,
    "1_per_project_per_month",
    "1_per_project_per_month",
    "1_per_project_per_month_plus_post_fix",
    "configurable",
  ],
  ["api.keys_max", 0, 0, 0, 3, "uncapped"],
  ["sso.oidc", false, false, false, false, true],
  ["scim.provisioning", false, false, false, false, true],
  ["audit_log.export", false, false, false, true, true],
  ["drift_sampling.enabled", false, false, false, "le_20_prompts", true],
  ["retention.raw_captures_days", 30, 90, 180, 395, 1095],
  ["retention.rollups_days", null, 395, 730, 1095, "unlimited"],
  ["residency.region_choice", "us-east-1", "us-east-1", "us-east-1", "us_or_eu", "any_supported"],
  ["sla.uptime", null, null, 99.5, 99.9, 99.95],
  ["support.response_target_hours", "community", 48, 24, "8_business_hours", "1_24_7"],
  ["fair_use.captures_per_cycle", 40, 1200, 6000, 22000, "negotiated"],
  ["no_shared_cache", false, false, false, false, "optional"],

  // ---------------------------------------------------------------------
  // §2's SECOND table — "Entitlement keys that are not live in v1".
  //
  // "These exist so the plan shape is settled before the features land.
  // They are not launch claims and must render nowhere."
  //
  // They carry `null` at every tier rather than a value, because the
  // reference gives them no per-tier row and inventing one would be
  // inventing a claim. `null` already means "not applicable for that tier"
  // in this file's encoding, which is exactly what an unbuilt feature is.
  // The `live: false` flag below is what actually stops them rendering.
  // ---------------------------------------------------------------------
  ["integrations.slack", null, null, null, null, null],
  ["integrations.mcp", null, null, null, null, null],
  ["integrations.cms_connections_max", null, null, null, null, null],
  ["exports.bi_ports", null, null, null, null, null],
  ["sso.saml", null, null, null, null, null],
];

/**
 * §2: the keys that are NOT live in v1, and must render nowhere.
 *
 * `whitelabel.custom_domain` is the one that is easy to get wrong. It is a
 * real matrix row with real per-tier values, and it is ALSO in the not-live
 * table — "live at launch + 30 days". So a key can carry a genuine value and
 * still not be live, which is precisely why the flag is per key rather than
 * a separate list of unbuilt features.
 */
export const NOT_LIVE_KEYS: ReadonlySet<string> = new Set([
  "integrations.slack",
  "integrations.mcp",
  "integrations.cms_connections_max",
  "exports.bi_ports",
  "sso.saml",
  "whitelabel.custom_domain",
]);

/**
 * One entitlement: what the plan grants, and whether the feature is live.
 *
 * THE FLAG IS NOT THE VALUE. A key can be `true` for a tier and still not be
 * live — `whitelabel.custom_domain` on Business is exactly that — so a
 * consumer that reads only the value would advertise a feature that does not
 * exist. Resolution keeps both, and the surfaces gate on `live` first.
 */
export interface Entitlement {
  readonly value: EntitlementValue;
  readonly live: boolean;
}

export const ENTITLEMENT_KEYS: readonly string[] = MATRIX.map((row) => row[0]);

function buildTierEntitlements(tierIndex: number): Record<string, Entitlement> {
  const entitlements: Record<string, Entitlement> = {};
  for (const row of MATRIX) {
    const [key, ...values] = row;
    entitlements[key] = { value: values[tierIndex]!, live: !NOT_LIVE_KEYS.has(key) };
  }
  return entitlements;
}

export const PLAN_ENTITLEMENTS: Record<Tier, Record<string, Entitlement>> = Object.fromEntries(
  TIERS.map((tier, index) => [tier, buildTierEntitlements(index)]),
) as Record<Tier, Record<string, Entitlement>>;

export const PLAN_CATALOG: ReadonlyArray<{
  key: Tier;
  displayName: string;
  monthlyPrice: number;
  annualPrice: number;
  creditsPerCycle: number;
}> = [
  { key: "free", displayName: "Free", monthlyPrice: 0, annualPrice: 0, creditsPerCycle: 60 },
  { key: "starter", displayName: "Starter", monthlyPrice: 49, annualPrice: 490, creditsPerCycle: 450 },
  { key: "growth", displayName: "Growth", monthlyPrice: 129, annualPrice: 1290, creditsPerCycle: 1200 },
  { key: "business", displayName: "Business", monthlyPrice: 349, annualPrice: 3490, creditsPerCycle: 3000 },
  // Enterprise pricing and credit allotment are "custom" / negotiated per
  // plans-and-entitlements.md — 0 here is a placeholder sentinel, not a real
  // price; the entitlements.price.monthly_usd key correctly carries "custom".
  { key: "enterprise", displayName: "Enterprise", monthlyPrice: 0, annualPrice: 0, creditsPerCycle: 0 },
];
