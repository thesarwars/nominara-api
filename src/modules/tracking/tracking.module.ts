import { Module } from "@nestjs/common";
import { CacheModule } from "../../lib/cache/cache.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { RunEstimateService } from "./run-estimate.service.js";
import { TrackingController } from "./tracking.controller.js";
import { TrackingService } from "./tracking.service.js";

// STORY-034 — the tracking bounded area.
//
// CacheModule is imported explicitly for the reason PromptsModule gives: a
// @Global() module is only global once something has loaded it into the
// graph, and this module compiled on its own — as its own spec does — would
// have nothing to resolve CACHE from. The estimate needs it because the L1
// probe is a cache round trip, and a forecast without L1 would report every
// cell as live.
@Module({
  imports: [CacheModule, EntitlementsModule],
  controllers: [TrackingController],
  providers: [TrackingService, RunEstimateService],
})
export class TrackingModule {}
