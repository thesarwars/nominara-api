import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";
import { ScorecardsController } from "./scorecards.controller.js";
import { ScorecardsService } from "./scorecards.service.js";

// STORY-022 scaffolded this module; STORY-136 gives it its first route.
//
// `AnalyticsController` stays, still routeless. §3's Analytics table has six
// more rows — growth-map, the competitor panel, displacements, rendering
// quality, sources, topics — and each lands as its own controller beside
// this one rather than as methods on a shared root, for the same reason
// MatrixController is separate: the paths are siblings under `/projects`,
// not children of an `/analytics` prefix that appears nowhere in the spec.
@Module({
  controllers: [AnalyticsController, ScorecardsController],
  providers: [AnalyticsService, ScorecardsService],
})
export class AnalyticsModule {}
