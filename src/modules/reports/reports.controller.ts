import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  methodologyFooterSchema,
  methodologyQuerySchema,
  type MethodologyFooter,
  type MethodologyQuery,
} from "../../../contracts/reports/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { MethodologyService } from "./methodology.service.js";

// NEW-E-100a — NFR-AGY-05. A read of rollup-derived figures: same permission
// as the scorecards it sits beside, scoped to the project in the path.
@Controller("projects/:id/reports")
export class ReportsController {
  constructor(private readonly methodologies: MethodologyService) {}

  @Get("methodology")
  @RequirePermission("tracking:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectMethodology", responseSchema: methodologyFooterSchema })
  methodology(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(methodologyQuerySchema)) query: MethodologyQuery,
  ): Promise<MethodologyFooter> {
    return this.methodologies.footer(projectId, query);
  }
}
