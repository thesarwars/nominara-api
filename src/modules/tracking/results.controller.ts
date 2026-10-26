import { Controller, Get, Header, HttpCode, Param, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { resultDocumentSchema, type ResultDocument } from "../../../contracts/tracking/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { RawDownloadService } from "./raw-download.service.js";
import { ResultDocumentService } from "./result-document.service.js";

// STORY-034 AC7 — §3's `GET /results/{id}`, "the full parser document".
//
// Its own controller because §3 puts the path at the root, a sibling of
// `/runs/{id}` rather than a child of it: a result id is globally unique, and
// a client holding one from the matrix does not necessarily know which run
// produced it.
@Controller("results")
export class ResultsController {
  constructor(
    private readonly documents: ResultDocumentService,
    private readonly rawDownloads: RawDownloadService,
  ) {}

  // `tracking:read`. Opening the drawer starts nothing and costs nothing.
  @Get(":id")
  @RequirePermission("tracking:read")
  @ScopedByQuery()
  @ApiContract({ operationId: "getResult", responseSchema: resultDocumentSchema })
  get(@Param("id") resultId: string): Promise<ResultDocument> {
    return this.documents.get(resultId);
  }

  // STORY-181 AC4 - `GET /results/{id}/raw`: 302 to a 60-second signed URL for the verbatim raw object (api-specification.md
  // section 3). The redirect is the `Location` header; the body is the ordinary envelope with `data: null`, because section 1 puts the
  // envelope on every response and `@NoEnvelope()` is reserved for the health probes (envelope-scope-and-probe-exemption.spec.ts). The URL
  // is a credential, so the redirect must never be cached. Minting it is a local signature (no network call), which is why a request
  // handler may.
  @Get(":id/raw")
  @RequirePermission("tracking:read")
  @ScopedByQuery()
  @HttpCode(302)
  @Header("Cache-Control", "no-store")
  @ApiContract({ operationId: "getResultRaw", redirect: true })
  async raw(@Param("id") resultId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const { url } = await this.rawDownloads.signedUrl(resultId);
    void reply.header("location", url);
  }
}
