import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  geoAnalysisSchema,
  geoDigestSchema,
  geoInsightsQuerySchema,
  geoSlugSchema,
  type GeoAnalysis,
  type GeoDigest,
  type GeoInsightsQuery,
  type GeoSlug,
} from "../../../contracts/analytics/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { GeoService } from "./geo.service.js";

// STORY-062 — `GET /projects/{id}/geo-insights[/{analysis}]`. Reads persisted
// rows; 0 credits, no meter. `tracking:read`, like every other analytics read.
@Controller("projects/:id/geo-insights")
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Get()
  @RequirePermission("tracking:read")
  @ApiContract({ operationId: "getProjectGeoInsights", responseSchema: geoDigestSchema })
  digest(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(geoInsightsQuerySchema)) query: GeoInsightsQuery,
  ): Promise<GeoDigest> {
    return this.geo.digest(projectId, query);
  }

  @Get(":analysis")
  @RequirePermission("tracking:read")
  @ApiContract({ operationId: "getProjectGeoAnalysis", responseSchema: geoAnalysisSchema })
  analysis(
    @Param("id") projectId: string,
    @Param("analysis", new ZodValidationPipe(geoSlugSchema)) analysis: GeoSlug,
    @Query(new ZodValidationPipe(geoInsightsQuerySchema)) query: GeoInsightsQuery,
  ): Promise<GeoAnalysis> {
    return this.geo.analysis(projectId, analysis, query);
  }
}
