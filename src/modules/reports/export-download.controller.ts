import { Controller, Get, Header, HttpCode, Param, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { exportDownloadParamsSchema, type ExportDownloadParams } from "../../../contracts/reports/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ExportDownloadService } from "./export-download.service.js";

// STORY-180 AC2 - the on-screen report download (owner decision 54 (2)): 302 to a fresh 15-minute presign of the stored key.
// The Location is a credential, so the redirect must never be cached or leaked in a Referer.
@Controller("exports")
export class ExportDownloadController {
  constructor(private readonly downloads: ExportDownloadService) {}

  @Get(":id/download")
  @HttpCode(302)
  @RequirePermission("export:data")
  @ScopedByQuery()
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @ApiContract({ operationId: "downloadExport", redirect: true })
  async download(@Param(new ZodValidationPipe(exportDownloadParamsSchema)) params: ExportDownloadParams, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const { url } = await this.downloads.resolve(params);
    void reply.header("location", url);
  }
}
