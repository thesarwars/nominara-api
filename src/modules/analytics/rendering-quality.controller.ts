import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  renderingQualityQuerySchema,
  renderingQualityResponseSchema,
  type RenderingQualityQuery,
  type RenderingQualityResponse,
} from "../../../contracts/analytics/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { RenderingQualityService } from "./rendering-quality.service.js";

// NEW-C-11 — §3's Analytics row, `GET /projects/{id}/rendering-quality`
// (`tracking:read`). A read; no @Audit.
@Controller("projects/:id/rendering-quality")
export class RenderingQualityController {
  constructor(private readonly renderingQualityReads: RenderingQualityService) {}

  @Get()
  @RequirePermission("tracking:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectRenderingQuality", responseSchema: renderingQualityResponseSchema })
  renderingQuality(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(renderingQualityQuerySchema)) query: RenderingQualityQuery,
  ): Promise<RenderingQualityResponse> {
    return this.renderingQualityReads.renderingQuality(projectId, query);
  }
}
