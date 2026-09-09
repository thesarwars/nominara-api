import { Inject, Injectable } from "@nestjs/common";
import type { RunEstimateResponse } from "../../../contracts/tracking/index.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { estimateManualRun, loadManualRunProject } from "../../lib/capture/manual-run.js";
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

@Injectable()
export class RunEstimateService {
  constructor(@Inject(CACHE) private readonly cache: Cache) {}

  async estimate(projectId: string): Promise<RunEstimateResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RunEstimateService requires an active tenant context");

    const project = await loadManualRunProject(store.client, projectId);
    const estimate = await estimateManualRun(store.client, this.cache, project);

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
    };
  }
}
