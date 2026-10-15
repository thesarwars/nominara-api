import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  competitorPanelQuerySchema,
  competitorPanelResponseSchema,
  type CompetitorPanelQuery,
  type CompetitorPanelResponse,
} from "../../../contracts/analytics/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { CompetitorPanelService } from "./competitor-panel.service.js";

// NEW-C-1 — `GET /projects/{id}/competitors/panel`, `api-specification.md` §3.
//
// Its own controller for the reason ScorecardsController gives: a sibling path
// under `/projects`, not a child of an `/analytics` root the spec never names.
@Controller("projects/:id/competitors/panel")
export class CompetitorPanelController {
  constructor(private readonly panel: CompetitorPanelService) {}

  // `tracking:read`, no `@Audit()`: a read starts nothing and costs nothing.
  @Get()
  @RequirePermission("tracking:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectCompetitorPanel", responseSchema: competitorPanelResponseSchema })
  competitorPanel(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(competitorPanelQuerySchema)) query: CompetitorPanelQuery,
  ): Promise<CompetitorPanelResponse> {
    return this.panel.panel(projectId, query);
  }
}
