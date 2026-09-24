import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  structuralLimitFrom,
  wouldExceed,
  isFeatureGranted,
  type FeatureFlagKey,
  type StructuralLimitKey,
} from "../../lib/entitlements/classification.js";
// Value imports, not `import type`: both are DI tokens, and a type-only
// import erases the class at runtime, leaving Nest with `undefined` to
// resolve.
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { scopeOf, StructuralUsage } from "../../lib/entitlements/structural-usage.js";
import { PROJECT_PARAM_KEY } from "../decorators/project-param.decorator.js";
import { REQUIRE_ENTITLEMENT_KEY, REQUIRE_FEATURE_KEY } from "../decorators/require-entitlement.decorator.js";
import { EntitlementExceededError, FeatureNotInPlanError } from "../errors/domain-errors.js";
import type { WorkspaceScopedRequest } from "./workspace.guard.js";

// STORY-069 AC6, AC7, AC8 — replaces STORY-022's pass-through no-op.
//
// The slot is already correct. security-and-tenancy.md §5 puts EntitlementGuard
// after RbacGuard and before QuotaGuard, and api.module.ts has registered it
// there since STORY-022. This file adds the LOGIC; it does not touch the
// composition root, which composition-root.spec.ts locks.
//
// THE TWO CONDITIONS NEVER MEET. A structural refusal carries the key, the
// limit and the current count and points at an add-on or an upgrade; a feature
// refusal carries the key and the minimum tier and points at an upgrade only.
// §9's note is the one to keep in view: "a tier whose `exports.pdf_per_cycle`
// is `0` returns `403 feature_not_in_plan`, not `429 quota_exceeded`. The
// remediation differs — upgrade versus wait — so the error must differ."
//
// A ROUTE MAY DECLARE BOTH, and they are evaluated feature-first. A workspace
// whose plan does not have the feature at all should be told that, not told it
// has used 0 of 0 of something it was never sold.

const logger = new Logger("entitlement-guard");

/**
 * A route needing entitlements outside any workspace, or gated on a feature no
 * tier grants, cannot be answered.
 *
 * Both are configuration errors rather than customer conditions, and both fail
 * CLOSED. Telling a customer to upgrade to reach a feature that exists on no
 * plan is worse than a 500: they would pay and still not have it.
 */
export class EntitlementGuardMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntitlementGuardMisconfiguredError";
  }
}

interface EntitlementScopedRequest extends WorkspaceScopedRequest {
  params?: Record<string, string | undefined>;
}

@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: EntitlementResolver,
    private readonly usage: StructuralUsage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const featureKey = this.reflector.getAllAndOverride<FeatureFlagKey | undefined>(REQUIRE_FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const structuralKey = this.reflector.getAllAndOverride<StructuralLimitKey | undefined>(REQUIRE_ENTITLEMENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (featureKey === undefined && structuralKey === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<EntitlementScopedRequest>();
    // ⚠ NO `?? request.auth?.ws` FALLBACK, AND ITS REMOVAL IS STORY-153's ONE
    // MECHANICAL FIX. That arm was DEAD on every route that should reach here:
    // on a tenant-scoped route carrying a `ws` claim, WorkspaceGuard has
    // already validated it and set `req.tenant`; on one without a claim it
    // yielded `undefined` anyway. It could only ever YIELD A VALUE on a
    // tenant-less route — where the claim has been validated by nothing, and
    // must not be used at all.
    //
    // STORY-153's early return is what made that reachable. A test forbids
    // pairing this decorator with @SkipTenantContext(), but deleting the arm
    // closes it BY CONSTRUCTION rather than by assertion, and demotes that
    // test to defence in depth — which is where a list like it belongs.
    //
    // Verified dead: removed across all five sites with unit and integration
    // both fully green. The refusal below already handles `undefined`.
    const workspaceId = request.tenant?.workspaceId ?? undefined;
    if (!workspaceId) {
      throw new EntitlementGuardMisconfiguredError(
        `route declares @RequireEntitlement/@RequireFeature but no workspace is resolved. ` +
          "An entitlement cannot be evaluated without a plan, so the request is refused rather than allowed.",
      );
    }

    // The version WorkspaceGuard already established for this request — it
    // read the live `entitlement_version` and refused outright if the token's
    // `ent_v` disagreed. Reusing it here is what makes a memo hit cost zero
    // database round trips.
    const resolved =
      request.entitlementVersion === undefined
        ? await this.resolver.resolveForWorkspace(workspaceId)
        : await this.resolver.resolve(workspaceId, request.entitlementVersion);

    if (featureKey !== undefined) {
      await this.assertFeature(featureKey, resolved.entitlements[featureKey]?.value ?? null);
    }

    if (structuralKey !== undefined) {
      await this.assertStructural(structuralKey, resolved.entitlements[structuralKey]?.value ?? null, {
        workspaceId,
        projectId: this.projectIdFor(structuralKey, context, request),
      });
    }

    return true;
  }

  private async assertFeature(key: FeatureFlagKey, value: unknown): Promise<void> {
    if (isFeatureGranted(value as never)) {
      return;
    }

    const minPlan = await this.usage.minimumPlanFor(key);
    if (minPlan === undefined) {
      // §1 rule 5 — a deferred entitlement renders nowhere, so a route should
      // never be gated on one. Reaching here means one is, and there is no
      // truthful `min_plan` to report.
      logger.error({
        message: "route is gated on a feature no plan grants — no upgrade would help the caller",
        entitlementKey: key,
      });
      throw new EntitlementGuardMisconfiguredError(
        `feature '${key}' is granted by no plan, so no upgrade would help the caller. ` +
          "A route gated on a deferred entitlement is a configuration error (plans-and-entitlements.md §1 rule 5).",
      );
    }

    throw new FeatureNotInPlanError({ details: { key, min_plan: minPlan } });
  }

  private async assertStructural(
    key: StructuralLimitKey,
    value: unknown,
    scope: { workspaceId: string; projectId: string | undefined },
  ): Promise<void> {
    const limit = structuralLimitFrom(value as never);
    if (limit === undefined) {
      throw new EntitlementGuardMisconfiguredError(
        `entitlement '${key}' resolved to ${JSON.stringify(value)}, which is not a ceiling. ` +
          "A structural limit must be a number, null/false, or one of the open-ended strings.",
      );
    }
    if (limit.kind === "unlimited") {
      return;
    }

    const current = await this.usage.current(key, scope.workspaceId, scope.projectId);
    if (!wouldExceed(limit, current)) {
      return;
    }

    // `current` is reported as counted, even when it EXCEEDS `limit` after a
    // downgrade. Clamping it to the limit would hide exactly the situation the
    // customer needs to see to act on it.
    throw new EntitlementExceededError({
      message: `${key}: ${String(current)} of ${String(limit.limit)} in use`,
      details: { key, limit: limit.limit, current },
    });
  }

  private projectIdFor(
    key: StructuralLimitKey,
    context: ExecutionContext,
    request: EntitlementScopedRequest,
  ): string | undefined {
    if (scopeOf(key) !== "project") {
      return undefined;
    }
    // The same param the route already declares for RbacGuard's project-scope
    // check — one decorator naming where the project id lives, read by both.
    const paramName = this.reflector.getAllAndOverride<string | undefined>(PROJECT_PARAM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return paramName === undefined ? undefined : request.params?.[paramName];
  }
}
