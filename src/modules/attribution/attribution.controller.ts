import { Controller, Get, Param, Query } from "@nestjs/common";
import { attributionQuerySchema, attributionReportSchema, type AttributionQuery, type AttributionReport } from "../../../contracts/attribution/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { AttributionService } from "./attribution.service.js";

// STORY-114 - `GET /projects/{id}/attribution`. `tracking:read`, like every other analytics read; reads persisted rows, 0 credits.
@Controller("projects/:id/attribution")
export class AttributionController {
  constructor(private readonly attribution: AttributionService) {}

  @Get()
  @RequirePermission("tracking:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectAttribution", querySchema: attributionQuerySchema, responseSchema: attributionReportSchema })
  report(@Param("id") projectId: string, @Query(new ZodValidationPipe(attributionQuerySchema)) query: AttributionQuery): Promise<AttributionReport> {
    return this.attribution.report(projectId, query);
  }
}
