import { Controller, Get, Param, Query } from "@nestjs/common";
import { gscCorrelationQuerySchema, gscCorrelationSchema, type GscCorrelation, type GscCorrelationQuery } from "../../../contracts/integrations/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequireFeature } from "../../api/decorators/require-entitlement.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { GscCorrelationService } from "./gsc-correlation.service.js";

// STORY-115 - `GET /projects/{id}/gsc/correlation`. `tracking:read` and the Search Console feature; persisted rows only, 0 credits.
@Controller("projects/:id/gsc/correlation")
export class GscCorrelationController {
  constructor(private readonly correlation: GscCorrelationService) {}

  @Get()
  @RequirePermission("tracking:read")
  @RequireFeature("integrations.gsc")
  @ProjectParam("id")
  @ApiContract({ operationId: "getGscCorrelation", querySchema: gscCorrelationQuerySchema, responseSchema: gscCorrelationSchema })
  read(@Param("id") projectId: string, @Query(new ZodValidationPipe(gscCorrelationQuerySchema)) query: GscCorrelationQuery): Promise<GscCorrelation> {
    return this.correlation.read(projectId, query);
  }
}
