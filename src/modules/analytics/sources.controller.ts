import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  playbookQuerySchema,
  playbookResponseSchema,
  sourceIndexQuerySchema,
  sourceIndexResponseSchema,
  type PlaybookQuery,
  type PlaybookResponse,
  type SourceIndexQuery,
  type SourceIndexResponse,
} from "../../../contracts/analytics/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { SourcesService } from "./sources.service.js";

// NEW-C-7 — §3's Analytics row `GET /projects/{id}/sources`, plus the
// playbook read (not in the spec; NEW-C-7 plan). Nominara produces the brief;
// a human executes it. No route here writes to anything.
@Controller("projects/:id/sources")
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get()
  @RequirePermission("aux:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectSources", responseSchema: sourceIndexResponseSchema })
  sourceIndex(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(sourceIndexQuerySchema)) query: SourceIndexQuery,
  ): Promise<SourceIndexResponse> {
    return this.sources.sourceIndex(projectId, query);
  }

  @Get(":domain/playbook")
  @RequirePermission("aux:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getSourcePlaybook", responseSchema: playbookResponseSchema })
  playbook(
    @Param("id") projectId: string,
    @Param("domain") domain: string,
    @Query(new ZodValidationPipe(playbookQuerySchema)) query: PlaybookQuery,
  ): Promise<PlaybookResponse> {
    return this.sources.playbook(projectId, domain, query);
  }
}
