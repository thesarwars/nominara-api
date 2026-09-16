import { Inject, Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { RunEstimateResponse } from "../../../contracts/tracking/index.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { estimateManualRun, loadManualRunProject, type ManualRunEstimate } from "../../lib/capture/manual-run.js";
import { actionsAffordable, confirmationFor, maxProjectsFrom } from "../../lib/credits/confirmation.js";
import { readWallet } from "../../lib/credits/wallet.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { FeatureNotInPlanError } from "../../api/errors/domain-errors.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-034 AC1 — `POST /projects/{id}/runs/estimate`.
//
// FREE, AND SEPARATE, AND THAT IS THE GUARD RAIL. The story's own note: "a
// client can always show cost before commitment because the price is
// available without committing to anything." Every two-step confirmation in
// the product — the modal that renders "this will cost 200 credits" — rests
// on there being a route that answers the question without answering it
// destructively.
//
// A POST that changes nothing, because §3 says POST. The body carries no
// scope for the same reason the trigger's does not: an estimate for a
// narrower scan than the one that can actually be bought would be an
// estimate for something that cannot happen.
//
// STORY-074 — it now also answers the two questions the cost modal was
// otherwise going to answer for itself: what the wallet looks like either
// side of this action, and whether §7's confirmation is mandatory. Both are
// server-computed for the same reason: a figure the client derives is a
// figure the client can derive differently.
//
// ⚠ STILL FREE, AND STILL RESERVES NOTHING. `readWallet` is a SELECT and the
// threshold arithmetic is pure. AC11's "idempotent and cheap: no reservation
// and no external call" is asserted by scenario 13 in
// `test/integration/estimates-and-confirmation.spec.ts` against a real
// database: two estimates, identical payloads, `reserved` still 0 and no
// ledger row.
//
// ⚠ AND IT RESOLVES ENTITLEMENTS EXACTLY ONCE, ON THE AMBIENT CONNECTION.
// The first version called `EntitlementResolver.resolveForWorkspace` here for
// `projects.max` and the included grant. That takes its OWN connection from
// `PG_POOL` — the resolver's own header says it is built to run in the guard
// chain "before TenantContextInterceptor has opened anything" — while this
// method runs INSIDE the request's transaction, which is already holding one.
// `createPgPool` sets no `connectionTimeoutMillis`, so at `max` concurrent
// estimates the pool deadlocks permanently, and the blast radius is every
// route rather than this one. It also read a second, Valkey-memoised
// snapshot, so one response could quote plan A's price beside plan B's
// thresholds. `estimateManualRun` had already done the resolution one line
// earlier; it hands it back now.

@Injectable()
export class RunEstimateService {
  constructor(@Inject(CACHE) private readonly cache: Cache) {}

  async estimate(projectId: string): Promise<RunEstimateResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RunEstimateService requires an active tenant context");

    const workspaceId = store.context.workspaceId;
    const project = await loadManualRunProject(store.client, projectId);
    const estimate = await estimateManualRun(store.client, this.cache, project);

    const wallet = await readWallet(store.client, workspaceId);

    // ⚠ A WORKSPACE WITH NO WALLET IS NOT A ZERO BALANCE. `provisionWallet`
    // runs on the first priced REQUEST, so a customer who has never triggered
    // a scan has no row yet — and rendering that as "0 available" would tell
    // them they are broke. The entitlement's own included grant stands in: it
    // is what they will have the moment they act.
    //
    // ⚠ AND IT MUST REFUSE RATHER THAN SUBSTITUTE ZERO. `credits.
    // included_per_cycle` is `"custom"` on enterprise, which is not a number
    // — the first version returned 0 for it, so the largest account in the
    // product saw "0 available → −400 after · 0 more scans" and a purchase
    // step, on its very first estimate, which is precisely the failure the
    // paragraph above says this exists to prevent. An unknown grant is not
    // zero; it is unknown, and guessing at it in a billing modal is worse
    // than failing.
    const available = wallet?.available ?? includedGrantOrThrow(estimate.entitlements);
    const confirmation = confirmationFor({
      credits: estimate.credits,
      available,
      // A deep scan is one project's. The parameter exists because §7's
      // cross-project rule does, and the tools that fan out are STORY-081's.
      projectCount: 1,
      maxProjects: maxProjectsFrom(structuralLimitFrom(estimate.entitlements["projects.max"]?.value ?? null)),
    });

    return {
      credits: estimate.credits,
      forecast: {
        planned_cells: estimate.forecast.plannedCells,
        live_cells: estimate.forecast.liveCells,
        cached_cells: estimate.forecast.cachedCells,
        cached_by_layer: estimate.forecast.cachedByLayer,
      },
      prompt_count: estimate.promptCount,
      engine_keys: [...estimate.engineKeys],
      credits_charged: 0,
      wallet: {
        available,
        after: available - estimate.credits,
        // AC9's figure, computed here so no component derives it from a sign.
        shortfall: estimate.credits > available ? estimate.credits - available : null,
        cycle_end: wallet?.cycleEnd ?? (await cycleEndOf(store.client, workspaceId)),
      },
      scans_affordable: actionsAffordable(available, estimate.credits),
      confirmation: { required: confirmation.required, reasons: [...confirmation.reasons] },
    };
  }
}

type Entitlements = ManualRunEstimate["entitlements"];

/**
 * The plan's per-cycle grant, for a workspace whose wallet row does not exist
 * yet.
 *
 * ⚠ THROWS ON A NON-NUMERIC GRANT RATHER THAN RETURNING ZERO. Enterprise
 * carries `"custom"`, negotiated per contract. Reading that as 0 told the
 * biggest account it was broke and offered it a credit pack; reading it as
 * anything invented would put a number in a billing modal that nobody agreed
 * to. `deepScanPriceOrThrow` already refuses `"negotiated"` for the price on
 * this same route, so the failure mode is one a caller already handles.
 */
function includedGrantOrThrow(entitlements: Entitlements): number {
  const value = entitlements["credits.included_per_cycle"]?.value;
  if (typeof value === "number") return value;
  throw new FeatureNotInPlanError({
    message: "this workspace has no credit wallet yet and its plan's included grant is negotiated, not a figure",
    details: { key: "credits.included_per_cycle", min_plan: "enterprise" },
  });
}

/** The cycle this workspace is in, for a customer whose wallet row does not exist yet. */
async function cycleEndOf(tx: ClientBase, workspaceId: string): Promise<string> {
  const { resolveBillingPeriod } = await import("../../lib/usage/billing-period.js");
  const period = await resolveBillingPeriod(tx, workspaceId);
  return period.end;
}
