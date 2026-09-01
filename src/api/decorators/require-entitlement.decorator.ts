import { SetMetadata } from "@nestjs/common";
import type { FeatureFlagKey, StructuralLimitKey } from "../../lib/entitlements/classification.js";

// STORY-069 AC8 — "Decorators declare the required entitlement or feature per
// route, and the guard sits in its documented slot in the chain."
//
// security-and-tenancy.md §5 spells both out by name:
//
//   → EntitlementGuard  @RequireEntitlement('projects.max') | @RequireFeature('integrations.gsc')
//                       → 403 entitlement_exceeded | 403 feature_not_in_plan
//
// Same SetMetadata shape as @RequirePermission()/@Public(), read by
// EntitlementGuard through the Reflector.
//
// TWO DECORATORS, NOT ONE WITH A MODE. §9 gives the two mechanisms different
// codes, different details, and different remediations, and the story's note
// says collapsing any two "produces a dead end". A single decorator taking a
// key would put the choice between them in a lookup at request time, where a
// key classified into the wrong bucket produces the wrong error silently. Two
// decorators with two key TYPES makes it a compile error instead: neither
// accepts the other's keys.

/**
 * A hard structural limit — §9's first row. Refuses with `403
 * entitlement_exceeded` and `details.{key, limit, current}` when the workspace
 * is already at its ceiling.
 *
 * For a per-project key (`prompts.max_per_project`,
 * `competitors.max_per_project`) the route must also carry `@ProjectParam()`,
 * naming where the project id is read from — the guard refuses rather than
 * counting workspace-wide, which would reject a second project's first prompt.
 */
export const REQUIRE_ENTITLEMENT_KEY = "requireEntitlement";
export const RequireEntitlement = (key: StructuralLimitKey): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_ENTITLEMENT_KEY, key);

/**
 * A feature flag — §9's second row. Refuses with `403 feature_not_in_plan` and
 * `details.{key, min_plan}` when the plan does not grant the feature at all.
 *
 * This is also the decorator for AC7's zero-cap case: `exports.pdf_per_cycle`
 * at `0` is a feature the tier does not have, not an exhausted counter, and
 * the remediation is upgrade rather than wait.
 */
export const REQUIRE_FEATURE_KEY = "requireFeature";
export const RequireFeature = (key: FeatureFlagKey): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_FEATURE_KEY, key);
