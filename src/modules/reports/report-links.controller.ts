import { Controller, Get, Header, HttpCode, Param, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { reportLinkParamsSchema, type ReportLinkParams } from "../../../contracts/reports/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ReportLinksService } from "./report-links.service.js";

// STORY-180 AC3 - the emailed 7-day report link (owner decision 54 (3)). Public (the recipient has no session) and tenant-less (the
// service discovers nothing: the workspace is in the path and only selects row-level security). 302 to a 15-minute presigned URL.
// The Location is a credential, so the redirect must never be cached or leaked in a Referer.
@Controller("report-links")
export class ReportLinksController {
  constructor(private readonly links: ReportLinksService) {}

  @Get(":workspaceId/:token")
  @HttpCode(302)
  @Public()
  @SkipTenantContext()
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @ApiContract({ operationId: "openReportLink", redirect: true })
  async open(@Param(new ZodValidationPipe(reportLinkParamsSchema)) params: ReportLinkParams, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const { url } = await this.links.resolve(params);
    void reply.header("location", url);
  }
}
