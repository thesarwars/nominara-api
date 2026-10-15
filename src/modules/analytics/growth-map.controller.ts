import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  growthMapQuerySchema,
  growthMapResponseSchema,
  type GrowthMapQuery,
  type GrowthMapResponse,
} from "../../../contracts/analytics/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { GrowthMapService } from "./growth-map.service.js";

// STORY-137 — §3's Analytics row, `GET /projects/{id}/growth-map`.
@Controller("projects/:id/growth-map")
export class GrowthMapController {
  constructor(private readonly growthMaps: GrowthMapService) {}

  @Get()
  @RequirePermission("tracking:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectGrowthMap", responseSchema: growthMapResponseSchema })
  growthMap(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(growthMapQuerySchema)) query: GrowthMapQuery,
  ): Promise<GrowthMapResponse> {
    return this.growthMaps.growthMap(projectId, query);
  }
}
