import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  scorecardsQuerySchema,
  scorecardsResponseSchema,
  type ScorecardsQuery,
  type ScorecardsResponse,
} from "../../../contracts/analytics/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ScorecardsService } from "./scorecards.service.js";

// STORY-136 — §3's Analytics row, `GET /projects/{id}/scorecards`.
//
// Its own controller for the reason MatrixController gives: the path is a
// sibling of `/projects/{id}/matrix`, not a child of anything the analytics
// scaffold owns, and hanging it off a `/analytics` root would publish a path
// that does not appear in the specification.
@Controller("projects/:id/scorecards")
export class ScorecardsController {
  constructor(private readonly scorecards: ScorecardsService) {}

  // `tracking:read` — §3's own column. Reading a score starts nothing and
  // costs nothing, which is why analysts and viewers have it.
  //
  // No `@Audit()`: the AuditInterceptor requires one on every MUTATING
  // method, and a read of aggregate figures is not one. `test/unit/
  // audit-coverage.spec.ts` is the sweep that would catch a mistake here.
  @Get()
  @RequirePermission("tracking:read")
  @ApiContract({ operationId: "getProjectScorecards", responseSchema: scorecardsResponseSchema })
  scorecard(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(scorecardsQuerySchema)) query: ScorecardsQuery,
  ): Promise<ScorecardsResponse> {
    return this.scorecards.scorecards(projectId, query);
  }
}
