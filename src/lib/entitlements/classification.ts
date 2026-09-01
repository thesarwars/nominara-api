import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";

// STORY-069 AC6 and AC7 — plans-and-entitlements.md §9 "The four enforcement
// mechanisms", the two `EntitlementGuard` rows:
//
//   Hard structural limits | projects.max, prompts.max_*, competitors.
//     max_per_project, seats.max, share_tokens.max_active, api.keys_max
//     | 403 entitlement_exceeded + details.{key, limit, current}
//   Feature flags | whitelabel.*, integrations.*, sso.*, scim.*, exports.*,
//     share_links.enabled, optimizer.enabled, drift_sampling.enabled
//     | 403 feature_not_in_plan + details.{key, min_plan}
//
// The story's own note on why this is not pedantry: "'You have used three of
// three projects' leads to an add-on or an upgrade; 'share links are not in
// your plan' leads to an upgrade only; 'you have used your export allowance
// this cycle' leads to waiting. Three different sentences, three different
// actions — and collapsing any two produces a dead end."
//
// CLASSIFICATION IS BY KEY, NOT BY VALUE, and that asymmetry is the whole of
// AC7. `exports.pdf_per_cycle` at 0 is a FEATURE failure — §9: "a tier whose
// `exports.pdf_per_cycle` is `0` returns `403 feature_not_in_plan`, not `429
// quota_exceeded`. The remediation differs — upgrade versus wait". Meanwhile
// `projects.max` at 0 on the free tier stays a STRUCTURAL failure — §3: "No
// project can be created — `403 entitlement_exceeded` naming the tier that
// allows one." Same zero, two codes, because the two keys mean different
// things. A classifier that looked at the value could not tell them apart.

/**
 * `share_tokens.max_active` IS NOT HERE, AND THAT IS DELIBERATE.
 *
 * §9's structural row names it, and no such key exists. §2's matrix — the
 * table the `plans` seed is transcribed from, and the machine-readable source
 * of truth this document's opening paragraph points at — carries
 * `share_links.enabled` with values like `"10_active"` and `"50_active"`, and
 * nothing named `share_tokens.max_active` anywhere.
 *
 * spec-navigation's precedence settles it: a schema beats prose about a table,
 * and §2's matrix is what the schema is generated from. Inventing the key here
 * to satisfy §9's list would put a 51st key in `plans.entitlements` that the
 * reference never specified values for. Recorded as a spec defect in the
 * story rather than papered over in code.
 */
export const STRUCTURAL_LIMIT_KEYS = [
  "projects.max",
  "prompts.max_per_project",
  "prompts.max_total",
  "competitors.max_per_project",
  "seats.max",
  "api.keys_max",
] as const;

export type StructuralLimitKey = (typeof STRUCTURAL_LIMIT_KEYS)[number];

/**
 * §9's feature-flag row, expanded against §2's key set.
 *
 * Written out as literals rather than derived from prefixes at runtime so a
 * decorator's key is checked at COMPILE time — `@RequireFeature("exports.pdf")`
 * should not reach a test to be caught. `entitlement-classification.spec.ts`
 * asserts this list and the prefixes in §9 still agree, so a key added to the
 * matrix under one of those namespaces cannot quietly go unclassified.
 */
export const FEATURE_FLAG_KEYS = [
  "whitelabel.custom_domain",
  "whitelabel.remove_branding",
  "whitelabel.email_digest",
  "integrations.gsc",
  "integrations.slack",
  "integrations.mcp",
  "integrations.cms_connections_max",
  "sso.oidc",
  "sso.saml",
  "scim.provisioning",
  "exports.pdf_per_cycle",
  "exports.csv",
  "exports.bi_ports",
  "share_links.enabled",
  "optimizer.enabled",
  "drift_sampling.enabled",
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

/** §9's namespaces, for the drift check. `audit_log.export` is NOT under `exports.` — it is a different namespace. */
export const FEATURE_FLAG_NAMESPACES = ["whitelabel.", "integrations.", "sso.", "scim.", "exports."] as const;

/**
 * Whether a feature entitlement is granted at all.
 *
 * `false`, `null` and `0` are the three ways the matrix says no — `✗`, `—`,
 * and a zero cap respectively — and the third is the one AC7 turns on. Every
 * other value grants: `true`, and every descriptive string the matrix uses
 * (`"10_active"`, `"unlimited"`, `"weekly"`, `"configurable"`,
 * `"le_20_prompts"`). No string in the feature key set means denial, which
 * `entitlement-classification.spec.ts` asserts against the real seed so a
 * future matrix edit introducing one is a test failure rather than a feature
 * silently switching on.
 */
export function isFeatureGranted(value: EntitlementValue): boolean {
  if (value === null || value === false) {
    return false;
  }
  if (typeof value === "number") {
    return value > 0;
  }
  return true;
}

export type StructuralLimit =
  | { readonly kind: "finite"; readonly limit: number }
  | { readonly kind: "unlimited" };

/**
 * The structural ceiling a resolved value expresses, or `undefined` when the
 * value is not a ceiling at all.
 *
 * `"custom"` and `"negotiated"` resolve to UNLIMITED, which is the one
 * judgement call here. Enterprise carries them for exactly these keys, and
 * they mean "agreed per contract" — the number lives in
 * `workspaces.entitlement_overrides`, which resolution has already applied by
 * the time this runs. So reaching this function with `"custom"` means an
 * enterprise workspace whose contracted figure was never recorded, and the
 * choice is between refusing every action and allowing them. Refusing would
 * take a paying enterprise customer's platform away over a missing row in our
 * own configuration; allowing is what "negotiated" has always meant in the
 * absence of a recorded cap. The absent override is the defect, and it is
 * visible in the resolved payload's `source: "plan"` (AC12).
 */
export function structuralLimitFrom(value: EntitlementValue): StructuralLimit | undefined {
  if (typeof value === "number") {
    return { kind: "finite", limit: Math.max(0, Math.trunc(value)) };
  }
  if (value === null || value === false) {
    // "—" for a tier, or an explicit ✗: no allowance at all. Not "unlimited",
    // and not "unknown" — free carries `null` for prompts.max_per_project
    // because it has no projects to put prompts in.
    return { kind: "finite", limit: 0 };
  }
  if (value === "unlimited" || value === "uncapped" || value === "custom" || value === "negotiated") {
    return { kind: "unlimited" };
  }
  return undefined;
}

/** Whether adding one more of `key`'s thing would exceed the ceiling. */
export function wouldExceed(limit: StructuralLimit, current: number): boolean {
  return limit.kind === "finite" && current >= limit.limit;
}
