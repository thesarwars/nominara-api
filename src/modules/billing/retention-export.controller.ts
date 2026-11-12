import { Body, Controller, Get, Header, HttpCode, Param, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import {
  retentionExportParamsSchema,
  retentionExportRequestSchema,
  retentionExportSchema,
  retentionExportViewSchema,
  type RetentionExport,
  type RetentionExportParams,
  type RetentionExportRequest,
  type RetentionExportView,
} from "../../../contracts/billing/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { RequireStorage } from "../../api/decorators/require-storage.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { RetentionExportService } from "./retention-export.service.js";

// STORY-185 / owner decision 100 - the full-data export offered while a retention-shortening purge is pending. Owner and admin only (billing:read for
// the view and the download, billing:write for the request). Costs 0 credits and is not the report export: no @Meter, no @Credits, no export:data.
// The request is the ordinary `writes` rate class (60/min) AND structurally limited: one export in flight per workspace, and a ready one is reused,
// so a loop of requests builds nothing more. Audited (`billing.retention_export.requested`, the response id as the resource).
@Controller("billing/retention-export")
export class RetentionExportController {
  constructor(private readonly service: RetentionExportService) {}

  @Get()
  @RequirePermission("billing:read")
  @ApiContract({ operationId: "getRetentionExport", responseSchema: retentionExportViewSchema })
  view(): Promise<RetentionExportView> {
    return this.service.view();
  }

  @Post()
  @HttpCode(202)
  @RequireStorage()
  @RequirePermission("billing:write")
  @Audit({ action: "billing.retention_export.requested", resourceType: "retention_export", resourceIdFrom: "response" })
  @ApiContract({ operationId: "requestRetentionExport", requestSchema: retentionExportRequestSchema, responseSchema: retentionExportSchema })
  request(@Body(new ZodValidationPipe(retentionExportRequestSchema)) _body: RetentionExportRequest): Promise<RetentionExport> {
    return this.service.request();
  }

  // 302 to a fresh 15-minute presign (the same shape as GET /v1/exports/{id}/download, STORY-180). The Location is a credential: never cached, never in a Referer.
  @Get(":id/download")
  @HttpCode(302)
  @RequirePermission("billing:read")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @ApiContract({ operationId: "downloadRetentionExport", redirect: true })
  async download(@Param(new ZodValidationPipe(retentionExportParamsSchema)) params: RetentionExportParams, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.service.resolve(params, (url) => void reply.header("location", url));
  }
}
