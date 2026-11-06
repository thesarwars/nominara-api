import { Controller, Get, Header, HttpCode, Param, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import {
  exportDownloadParamsSchema,
  reportLinkRevokeParamsSchema,
  reportLinkRevokeResponseSchema,
  type ExportDownloadParams,
  type ReportLinkRevokeParams,
  type ReportLinkRevokeResponse,
} from "../../../contracts/reports/index.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ExportDownloadService } from "./export-download.service.js";
import { ReportLinksService } from "./report-links.service.js";

// STORY-180 AC2 - the on-screen report download (owner decision 54 (2)): 302 to a fresh 15-minute presign of the stored key.
// The Location is a credential, so the redirect must never be cached or leaked in a Referer.
@Controller("exports")
export class ExportDownloadController {
  constructor(
    private readonly downloads: ExportDownloadService,
    private readonly links: ReportLinksService,
  ) {}

  @Get(":id/download")
  @HttpCode(302)
  @RequirePermission("export:data")
  @ScopedByQuery()
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @ApiContract({ operationId: "downloadExport", redirect: true })
  async download(@Param(new ZodValidationPipe(exportDownloadParamsSchema)) params: ExportDownloadParams, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.downloads.resolve(params, (url) => void reply.header("location", url));
  }

  // STORY-180 r5 (owner decision 60 (d)) - an owner or admin (agency:branding, the permission that manages scheduled reports) revokes a
  // sent link. Workspace-wide, so no @ScopedByQuery: a project-scoped manager is refused 403 naming the permission. A revoked link's
  // public route then answers token_revoked "This link was revoked." (report-links.service.ts).
  @Post(":id/revoke-link")
  @HttpCode(200)
  @RequirePermission("agency:branding")
  @Audit({ action: "report_link.revoked", resourceType: "report_artifact" })
  @ApiContract({ operationId: "revokeReportLink", responseSchema: reportLinkRevokeResponseSchema })
  revokeLink(@Param(new ZodValidationPipe(reportLinkRevokeParamsSchema)) params: ReportLinkRevokeParams): Promise<ReportLinkRevokeResponse> {
    return this.links.revoke(params);
  }
}
