import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";
import { CompetitorPanelController } from "./competitor-panel.controller.js";
import { CompetitorPanelService } from "./competitor-panel.service.js";
import { GrowthMapController } from "./growth-map.controller.js";
import { GrowthMapService } from "./growth-map.service.js";
import { SourcesController } from "./sources.controller.js";
import { SourcesService } from "./sources.service.js";
import { ScorecardsController } from "./scorecards.controller.js";
import { ScorecardsService } from "./scorecards.service.js";

// STORY-022 scaffolded this module; STORY-136 and STORY-137 give it its
// first two routes.
//
// `AnalyticsController` stays, still routeless. §3's Analytics table has five
// more rows — the competitor panel, displacements, rendering quality,
// sources, topics — and each lands as its own controller beside
// this one rather than as methods on a shared root, for the same reason
// MatrixController is separate: the paths are siblings under `/projects`,
// not children of an `/analytics` prefix that appears nowhere in the spec.
@Module({
  imports: [EntitlementsModule],
  controllers: [
    AnalyticsController,
    ScorecardsController,
    GrowthMapController,
    CompetitorPanelController,
    SourcesController,
  ],
  providers: [AnalyticsService, ScorecardsService, GrowthMapService, CompetitorPanelService, SourcesService],
  // NEW-E-099a — the portal reuses the scorecards and growth-map logic rather than forking it.
  exports: [ScorecardsService, GrowthMapService],
})
export class AnalyticsModule {}
