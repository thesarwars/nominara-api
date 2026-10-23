import { Controller, Get, Param, Query } from "@nestjs/common";
import { resultsListQuerySchema, resultsListResponseSchema, type ResultListItem, type ResultsListQuery } from "../../../contracts/tracking/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ResultsListService } from "./results-list.service.js";

// STORY-034 AC7 - §3's `GET /projects/{id}/results`, "cursor over answer_captures". Its own controller for the reason the matrix has
// one: the path is a sibling of `/projects/{id}/runs`, and `GET /results/{id}` (the document) lives at the root.
@Controller("projects/:id/results")
export class ResultsListController {
  constructor(private readonly results: ResultsListService) {}

  // `tracking:read`. Listing starts nothing and costs nothing.
  @Get()
  @RequirePermission("tracking:read")
  @ProjectParam("id")
  @ApiContract({
    operationId: "listProjectResults",
    querySchema: resultsListQuerySchema,
    responseSchema: resultsListResponseSchema,
    listOf: true,
  })
  list(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(resultsListQuerySchema)) query: ResultsListQuery,
  ): Promise<Page<ResultListItem>> {
    return this.results.list(projectId, query);
  }
}
