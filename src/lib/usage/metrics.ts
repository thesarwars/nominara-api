// STORY-070 AC1, AC9, AC10 — schemas/billing-and-credits.md's
// `usage_counters`: "**Only four metrics live here, and none of them is
// charged in credits.**"
//
// THIS FILE IS THE ONE PLACE THAT KNOWS THE FOUR, and the boundary it draws
// matters more than the list. §9 keeps `usage_counters` and `credit_wallets`
// apart deliberately: "Conflating them collapses two distinct failure
// conditions — `402 insufficient_credits` and `429 quota_exceeded` — whose
// remediations differ." A metric arriving here that belongs in the wallet
// would produce "wait for the cycle" where the customer needed "buy credits".

export const USAGE_METRICS = ["pdf_exports", "fair_use_captures", "embed_tokens", "arbiter_tokens"] as const;

export type UsageMetric = (typeof USAGE_METRICS)[number];

/**
 * The unlimited sentinel, from §9's reservation SQL and the schema's own
 * comment on `limit_value` (`-1 = unlimited`).
 *
 * Named rather than written as a bare `-1`, because the literal is
 * indistinguishable from a typo at a call site and the failure it guards is
 * silent: without the `limit_value = -1 OR` branch, an unlimited row's
 * comparison reads `used + reserved + n <= -1`, false for every positive
 * request. The sentinel that must NEVER block would block ALWAYS.
 */
export const UNLIMITED_LIMIT = -1;

interface MetricSpec {
  /**
   * The entitlement key the ceiling is resolved from, or `null` for a metric
   * that has no plan-facing limit at all.
   */
  readonly entitlementKey: string | null;
  /**
   * Whether exhausting this counter can produce a refusal a CUSTOMER sees.
   *
   * AC9: the internal-cost metrics are "metered but marked non-billable, so a
   * runaway is visible without ever reaching a customer". They are recorded
   * and never enforced — a `429` for our own embedding spend would be charging
   * the customer for our efficiency.
   */
  readonly customerFacing: boolean;
  /**
   * Whether the ceiling may appear in a refusal.
   *
   * AC10 and `FR-CRD-19`: the fair-use ceiling "is not published — a limit
   * nobody hits adds a dimension and reduces trust at the same time". A `429`
   * carrying `limit: 6000` publishes it to precisely the customer who was
   * about to ask what it is, so the figure is withheld from the details while
   * the refusal itself still names the metric and the reset.
   */
  readonly publishesLimit: boolean;
}

export const METRIC_SPECS: Record<UsageMetric, MetricSpec> = {
  // "A tier throttle. A tier whose cap is zero returns 403 feature_not_in_plan,
  // not 429 quota_exceeded — the remediation differs." The zero case is
  // EntitlementGuard's and QuotaGuard's alike; see quota.guard.ts.
  pdf_exports: { entitlementKey: "exports.pdf_per_cycle", customerFacing: true, publishesLimit: true },

  // "An unmarketed ceiling just above each tier's maximum scheduled envelope.
  // Never binds on legitimate use, and is not published."
  fair_use_captures: { entitlementKey: "fair_use.captures_per_cycle", customerFacing: true, publishesLimit: false },

  // "Internal cost observability. Absorbed, never billed, but metered so a
  // runaway is visible." No entitlement key exists for either, and inventing
  // one would put an internal cost in a customer's plan.
  embed_tokens: { entitlementKey: null, customerFacing: false, publishesLimit: false },
  arbiter_tokens: { entitlementKey: null, customerFacing: false, publishesLimit: false },
};

export function isUsageMetric(value: string): value is UsageMetric {
  return (USAGE_METRICS as readonly string[]).includes(value);
}
