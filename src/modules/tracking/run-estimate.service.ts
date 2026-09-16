import { Inject, Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { RunEstimateResponse } from "../../../contracts/tracking/index.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { estimateManualRun, loadManualRunProject } from "../../lib/capture/manual-run.js";
import { actionsAffordable, confirmationFor, maxProjectsFrom } from "../../lib/credits/confirmation.js";
import { readWallet } from "../../lib/credits/wallet.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
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
// ⚠ STILL FREE, AND STILL RESERVES NOTHING. Everything added here is a read —
// `readWallet` is a SELECT, `resolveForWorkspace` is memoised by entitlement
// version, and the threshold arithmetic is pure. AC11's "idempotent and
// cheap: no reservation and no external call" is a property of this method
// and `estimate-is-free.spec.ts` asserts it against a real database.

@Injectable()
export class RunEstimateService {
  constructor(
    @Inject(CACHE) private readonly cache: Cache,
    private readonly resolver: EntitlementResolver,
  ) {}

  async estimate(projectId: string): Promise<RunEstimateResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RunEstimateService requires an active tenant context");

    const workspaceId = store.context.workspaceId;
    const project = await loadManualRunProject(store.client, projectId);
    const estimate = await estimateManualRun(store.client, this.cache, project);

    const wallet = await readWallet(store.client, workspaceId);
    const resolved = await this.resolver.resolveForWorkspace(workspaceId);

    // ⚠ A WORKSPACE WITH NO WALLET IS NOT A ZERO BALANCE. `provisionWallet`
    // runs on the first priced REQUEST, so a customer who has never triggered
    // a scan has no row yet — and rendering that as "0 available" would tell
    // them they are broke. The modal needs a wallet either way, so the
    // entitlement's own included grant stands in: it is what they will have
    // the moment they act.
    const available = wallet?.available ?? includedGrant(resolved.entitlements);
    const confirmation = confirmationFor({
      credits: estimate.credits,
      available,
      // A deep scan is one project's. The parameter exists because §7's
      // cross-project rule does, and the tools that fan out are STORY-081's.
      projectCount: 1,
      maxProjects: maxProjectsFrom(structuralLimitFrom(resolved.entitlements["projects.max"]?.value ?? null)),
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
        included_balance: wallet?.includedBalance ?? 0,
        purchased_balance: wallet?.purchasedBalance ?? 0,
        reserved: wallet?.reserved ?? 0,
        cycle_end: wallet?.cycleEnd ?? (await cycleEndOf(store.client, workspaceId)),
      },
      scans_affordable: actionsAffordable(available, estimate.credits),
      confirmation: { required: confirmation.required, reasons: [...confirmation.reasons] },
    };
  }
}

type Entitlements = Awaited<ReturnType<EntitlementResolver["resolveForWorkspace"]>>["entitlements"];

function includedGrant(entitlements: Entitlements): number {
  const value = entitlements["credits.included_per_cycle"]?.value;
  return typeof value === "number" ? value : 0;
}

/** The cycle this workspace is in, for a customer whose wallet row does not exist yet. */
async function cycleEndOf(tx: ClientBase, workspaceId: string): Promise<string> {
  const { resolveBillingPeriod } = await import("../../lib/usage/billing-period.js");
  const period = await resolveBillingPeriod(tx, workspaceId);
  return period.end;
}
