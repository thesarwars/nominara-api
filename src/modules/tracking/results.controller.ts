import { Controller, Get, Header, HttpCode, Param, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { reparseResponseSchema, resultDocumentSchema, type ReparseResponse, type ResultDocument } from "../../../contracts/tracking/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { RawDownloadService } from "./raw-download.service.js";
import { ReparseService } from "./reparse.service.js";
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
    private readonly reparses: ReparseService,
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

  // STORY-034 AC9 - `POST /results/{id}/reparse` (owner decision 2026-10-23; FR-PA-08's "Re-parse, free" in the Live Answer drawer).
  //
  //   `tracking:trigger`: it WRITES facts, so it is not a read. The permission matrix has no owner/admin-only tracking permission, so
  //     a scoped manager (who already holds `tracking:trigger`) can re-parse inside their scope too; narrowing it to owner and admin
  //     alone needs a matrix change, which is not this story's to make.
  //   FREE: no `@Credits`, no `@Meter`, no daily cap - a re-parse runs in-house (plans-and-entitlements.md: 0 credits, unmetered).
  //   `@Idempotent()`: a replayed key returns the first diff instead of a second pass.
  //   `@Audit`: records the OUTCOME only. The default would store the whole response, entity labels included; the diff is shown to the
  //     caller and does not belong in the append-only log.
  @Post(":id/reparse")
  @HttpCode(200)
  @Idempotent()
  @RequirePermission("tracking:trigger")
  @ScopedByQuery()
  @Audit({
    action: "result.reparsed",
    resourceType: "result",
    afterState: (body) => {
      const response = body as Partial<ReparseResponse>;
      return { result_id: response.result_id, scoring_version: response.scoring_version, changed: response.changed, credits_charged: response.credits_charged };
    },
  })
  @ApiContract({ operationId: "reparseResult", responseSchema: reparseResponseSchema, requiresIdempotencyKey: true })
  reparse(@Param("id") resultId: string): Promise<ReparseResponse> {
    return this.reparses.reparse(resultId);
  }
}
