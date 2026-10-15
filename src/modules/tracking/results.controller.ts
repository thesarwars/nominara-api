import { Controller, Get, Param } from "@nestjs/common";
import { resultDocumentSchema, type ResultDocument } from "../../../contracts/tracking/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { ResultDocumentService } from "./result-document.service.js";

// STORY-034 AC7 — §3's `GET /results/{id}`, "the full parser document".
//
// Its own controller because §3 puts the path at the root, a sibling of
// `/runs/{id}` rather than a child of it: a result id is globally unique, and
// a client holding one from the matrix does not necessarily know which run
// produced it.
@Controller("results")
export class ResultsController {
  constructor(private readonly documents: ResultDocumentService) {}

  // `tracking:read`. Opening the drawer starts nothing and costs nothing.
  @Get(":id")
  @RequirePermission("tracking:read")
  @ScopedByQuery()
  @ApiContract({ operationId: "getResult", responseSchema: resultDocumentSchema })
  get(@Param("id") resultId: string): Promise<ResultDocument> {
    return this.documents.get(resultId);
  }
}
