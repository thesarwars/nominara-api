import { Controller, Get, Param, Query } from "@nestjs/common";
import { projectEngineHealthQuerySchema, projectEngineHealthResponseSchema, type ProjectEngineHealthEntry, type ProjectEngineHealthQuery } from "../../../contracts/engines/index.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { HealthService } from "./health.service.js";

// STORY-090 AC7/AC8 - per-project engine health for the status pip and the filter bar (persisted, not only the realtime push). `tracking:read`, like the other
// project reads; the body names engines, never tenant data beyond which engines the project runs.
@Controller("projects/:id/engine-health")
export class ProjectEngineHealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @RequirePermission("tracking:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectEngineHealth", querySchema: projectEngineHealthQuerySchema, responseSchema: projectEngineHealthResponseSchema, listOf: true })
  engineHealth(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(projectEngineHealthQuerySchema)) query: ProjectEngineHealthQuery,
  ): Promise<Page<ProjectEngineHealthEntry>> {
    return this.health.projectEngineHealth(projectId, query);
  }
}
