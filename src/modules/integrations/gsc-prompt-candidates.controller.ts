import { Controller, Get, Param, Query } from "@nestjs/common";
import { gscPromptCandidatesQuerySchema, gscPromptCandidatesSchema, type GscPromptCandidates, type GscPromptCandidatesQuery } from "../../../contracts/integrations/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequireFeature } from "../../api/decorators/require-entitlement.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { GscPromptCandidatesService } from "./gsc-prompt-candidates.service.js";

// STORY-115 AC11 / FR-PA-04 - `GET /projects/{id}/gsc/prompt-candidates`. `project:read` and the Search Console feature; persisted rows only, 0 credits.
@Controller("projects/:id/gsc/prompt-candidates")
export class GscPromptCandidatesController {
  constructor(private readonly candidates: GscPromptCandidatesService) {}

  @Get()
  @RequirePermission("project:read")
  @RequireFeature("integrations.gsc")
  @ProjectParam("id")
  @ApiContract({ operationId: "getGscPromptCandidates", querySchema: gscPromptCandidatesQuerySchema, responseSchema: gscPromptCandidatesSchema })
  read(@Param("id") projectId: string, @Query(new ZodValidationPipe(gscPromptCandidatesQuerySchema)) query: GscPromptCandidatesQuery): Promise<GscPromptCandidates> {
    return this.candidates.read(projectId, query);
  }
}
