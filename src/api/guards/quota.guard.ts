import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ClientBase, Pool } from "pg";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { isFeatureGranted, type FeatureFlagKey } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { StructuralUsage } from "../../lib/entitlements/structural-usage.js";
import { resolveBillingPeriod } from "../../lib/usage/billing-period.js";
import { METRIC_SPECS } from "../../lib/usage/metrics.js";
import { notifyQuotaThresholds } from "../../lib/notifications/thresholds.js";
import { crossedWarningThresholds, provisionUsageCounters, reserveTierCap } from "../../lib/usage/tier-caps.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { METER_KEY, type MeterSpec } from "../decorators/meter.decorator.js";
import { FeatureNotInPlanError, QuotaExceededError } from "../errors/domain-errors.js";
import type { WorkspaceScopedRequest } from "./workspace.guard.js";

// STORY-070 — replaces STORY-022's pass-through no-op. The slot is already
// correct: security-and-tenancy.md §5 puts QuotaGuard after EntitlementGuard
// and before DailyCapGuard and CreditGuard, and api.module.ts has registered
// it there since STORY-022 (AC12). This file adds the logic and touches no
// wiring.
//
// THE ZERO CHECK COMES FIRST, AND THAT IS AC7. "A tier whose cap is zero
// returns the feature failure instead — the remediation differs, and this is
// checked before the counter is touched." §9's note: "a tier whose
// `exports.pdf_per_cycle` is `0` returns `403 feature_not_in_plan`, not `429
// quota_exceeded`. The remediation differs — upgrade versus wait."
//
// "Before the counter is touched" is a literal requirement, not emphasis. A
// zero-limit counter refuses every reservation, so an implementation that
// reserved first would produce the right refusal for the wrong reason and
// would report `quota_exceeded` — telling a customer to wait for a reset that
// will never help them, which the story calls the worst of the three outcomes.

const logger = new Logger("quota-guard");

/** What `provisionUsageCounters` and `limitOf` both read — the resolved map, values only. */
type ResolvedValues = Readonly<Record<string, { readonly value: EntitlementValue }>>;

function metricSpecFor(spec: MeterSpec) {
  return METRIC_SPECS[spec.metric];
}

/**
 * The request's `Idempotency-Key`, used as the reservation's job identifier.
 *
 * api-specification.md §1 requires one "on every billable or external-effect
 * POST", which is every route that would carry `@Meter`, and it is exactly the
 * identifier a retry presents again. Reserving under it means a redelivered
 * request does not consume the cap twice — the same guarantee
 * `IdempotencyInterceptor` gives the handler, one layer earlier, because the
 * reservation happens before the interceptor runs.
 *
 * WITHOUT ONE, NOTHING CAN SETTLE THE RESERVATION. It still counts against the
 * ceiling, so the cap binds correctly, but it stays `reserved` rather than
 * becoming `used` and is only cleared when the period rolls. That is the safe
 * direction for a ceiling and is why this is `undefined` rather than a
 * fabricated id: a job id nothing will ever present again is worse than none,
 * because it makes an unsettleable reservation look settleable.
 *
 * THE OTHER HALF IS NOT BUILT. Committing on success and releasing on failure
 * belongs in an interceptor beside `CreditInterceptor`, which is itself still
 * STORY-022's pass-through scaffold — STORY-072 fills that slot. Until then
 * `used_value` stays at zero for metered routes. No production route carries
 * `@Meter` yet, so nothing is wrong today; the first one to do so must land
 * the settlement with it.
 */
function idempotencyJobId(request: WorkspaceScopedRequest & { headers?: Record<string, unknown> }): string | undefined {
  const raw = request.headers?.["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 && value.length <= 255 ? value : undefined;
}

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: EntitlementResolver,
    private readonly usage: StructuralUsage,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.getAllAndOverride<MeterSpec | undefined>(METER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (spec === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<WorkspaceScopedRequest>();
    // NEW-E-100b — a route may meter only one variant of itself (a PDF export,
    // not a CSV one). The condition is the route's; the cap logic below is
    // unchanged and still the single place that evaluates a tier cap.
    if (spec.when !== undefined && !spec.when(request)) {
      return true;
    }
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
      throw new Error(
        "route declares @Meter() but no workspace is resolved. " +
        "or the route is @SkipTenantContext(), in which case the workspace claim is deliberately unresolved and these decorators cannot be combined with it. " +
        "A tier cap cannot be evaluated without a plan, " +
          "so the request is refused rather than allowed.",
      );
    }

    const metricSpec = METRIC_SPECS[spec.metric];
    if (!metricSpec.customerFacing) {
      // AC9 — the internal-cost metrics are "metered but marked non-billable,
      // so a runaway is visible without ever reaching a customer". A route
      // that could refuse a request over our own embedding spend would be
      // charging the customer for our efficiency.
      throw new Error(
        `metric '${spec.metric}' is internal-cost observability and must never gate a request. ` +
          "Record it with meterInternalUsage() from the code that spent it.",
      );
    }

    const resolved =
      request.entitlementVersion === undefined
        ? await this.resolver.resolveForWorkspace(workspaceId)
        : await this.resolver.resolve(workspaceId, request.entitlementVersion);

    // AC7, first and separately.
    const entitlementKey = metricSpec.entitlementKey;
    if (entitlementKey !== null && !isFeatureGranted(resolved.entitlements[entitlementKey]?.value ?? null)) {
      const minPlan = await this.usage.minimumPlanFor(entitlementKey as FeatureFlagKey);
      throw new FeatureNotInPlanError({
        details: { key: entitlementKey, min_plan: minPlan ?? resolved.plan_key },
      });
    }

    await this.reserve(workspaceId, spec, resolved.entitlements, idempotencyJobId(request));
    return true;
  }

  private async reserve(
    workspaceId: string,
    spec: MeterSpec,
    entitlements: ResolvedValues,
    jobId: string | undefined,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx: ClientBase) => {
        const period = await resolveBillingPeriod(tx, workspaceId);

        // Provisioning on the request path rather than in a nightly job is what
        // makes AC11's reset need no scheduler: a new period is a new
        // `period_start`, so the first request of a cycle creates rows at zero
        // and every later one updates only the ceiling. Idempotent by
        // construction, and there is no window in which a cycle has begun and
        // its counters do not exist yet.
        await provisionUsageCounters(tx, workspaceId, period.start, entitlements);

        const outcome = await reserveTierCap(tx, {
          workspaceId,
          metric: spec.metric,
          periodStart: period.start,
          quantity: spec.quantity,
          ...(jobId === undefined ? {} : { jobId }),
        });

        if (!outcome.ok) {
          throw new QuotaExceededError({
            message: `this cycle's ${spec.metric} allowance is exhausted`,
            // AC10 — the limit travels only for metrics whose ceiling is
            // published. `FR-CRD-19` keeps fair use out; a PDF cap is a plan
            // figure the customer already sees on their plan page.
            details: metricSpecFor(spec).publishesLimit
              ? {
                  metric: spec.metric,
                  limit: limitOf(entitlements, metricSpecFor(spec).entitlementKey),
                  resets_at: period.end,
                }
              : { metric: spec.metric, resets_at: period.end },
          });
        }

        // AC8 — after the reservation, because a threshold is about what is
        // now committed, not about what was true before this request. Fired
        // once per threshold per period by the `warned_at_NN IS NULL`
        // predicate, not by anything this process remembers.
        const crossed = await crossedWarningThresholds(tx, workspaceId, spec.metric, period.start);
        for (const threshold of crossed) {
          logger.warn({
            message: "usage counter crossed a warning threshold",
            workspaceId,
            metric: spec.metric,
            threshold,
            periodStart: period.start,
          });
        }
        // STORY-068 AC7 — each crossing this statement stamped becomes ONE notification, in this same short transaction
        // (no network I/O: a warning is digest-only, so nothing is enqueued). A request that crosses nothing new writes
        // nothing, however many follow it: "one notification, not one per page view".
        await notifyQuotaThresholds(tx, workspaceId, spec.metric, period.start, crossed);
      });
    } finally {
      client.release();
    }
  }
}

/**
 * The published ceiling, from the resolved entitlements rather than from the
 * counter row.
 *
 * Both hold it, and they agree — `provisionUsageCounters` writes the counter's
 * `limit_value` from this same value moments earlier. Reading it here avoids a
 * second query on a path that is already refusing.
 */
function limitOf(entitlements: ResolvedValues, entitlementKey: string | null): number | undefined {
  if (entitlementKey === null) {
    return undefined;
  }
  const value = entitlements[entitlementKey]?.value;
  return typeof value === "number" ? value : undefined;
}
