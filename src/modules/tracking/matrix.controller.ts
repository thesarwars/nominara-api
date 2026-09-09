import { Controller, Get, Param, Query } from "@nestjs/common";
import { matrixQuerySchema, matrixResponseSchema, type MatrixQuery, type MatrixResponse } from "../../../contracts/tracking/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { MatrixService } from "./matrix.service.js";

// STORY-034 AC8 — §3's `GET /projects/{id}/matrix`.
//
// Its own controller because the path is `/projects/{id}/matrix`, a sibling
// of `/projects/{id}/runs` rather than a child of it. Hanging it off the runs
// controller would need a `..` in the route, which Nest does not resolve and
// which would publish a path nobody could read out of the source.
@Controller("projects/:id/matrix")
export class MatrixController {
  constructor(private readonly matrixes: MatrixService) {}

  // `tracking:read`. Reading the grid starts nothing and costs nothing, which
  // is why analysts and viewers have it and `tracking:trigger` is separate.
  @Get()
  @RequirePermission("tracking:read")
  @ApiContract({ operationId: "getProjectMatrix", responseSchema: matrixResponseSchema })
  matrix(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(matrixQuerySchema)) query: MatrixQuery,
  ): Promise<MatrixResponse> {
    return this.matrixes.matrix(projectId, query);
  }
}
