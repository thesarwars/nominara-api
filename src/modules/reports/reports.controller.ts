import { Body, Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import {
  exportRequestSchema,
  exportResponseSchema,
  methodologyFooterSchema,
  methodologyQuerySchema,
  type ExportRequest,
  type ExportResponse,
  type MethodologyFooter,
  type MethodologyQuery,
} from "../../../contracts/reports/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { Meter } from "../../api/decorators/meter.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { isMeteredPdfExport } from "./export-metering.js";
import { ExportService } from "./export.service.js";
import { MethodologyService } from "./methodology.service.js";

// NEW-E-100a — NFR-AGY-05. A read of rollup-derived figures: same permission
// as the scorecards it sits beside, scoped to the project in the path.
@Controller("projects/:id/reports")
export class ReportsController {
  constructor(
    private readonly methodologies: MethodologyService,
    private readonly exports: ExportService,
  ) {}

  @Get("methodology")
  @RequirePermission("tracking:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectMethodology", responseSchema: methodologyFooterSchema })
  methodology(
    @Param("id") projectId: string,
    @Query(new ZodValidationPipe(methodologyQuerySchema)) query: MethodologyQuery,
  ): Promise<MethodologyFooter> {
    return this.methodologies.footer(projectId, query);
  }

  // NEW-E-100b — STORY-100. export:data (step-up for owner/admin, scoped for a
  // manager - the matrix's rule, enforced by RbacGuard). 0 credits; a PDF
  // consumes one pdf_exports unit (QuotaGuard reserves, the service commits);
  // a CSV is gated by exports.csv in the service.
  @Post("export")
  @RequirePermission("export:data")
  @ProjectParam("id")
  @Meter("pdf_exports", 1, isMeteredPdfExport)
  @Idempotent()
  @Audit({ action: "report.exported", resourceType: "report_artifact", resourceIdFrom: "response", responseIdPath: "export_id" })
  @ApiContract({ operationId: "exportProjectReport", requestSchema: exportRequestSchema, responseSchema: exportResponseSchema })
  export(
    @Param("id") projectId: string,
    @Body(new ZodValidationPipe(exportRequestSchema)) body: ExportRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ): Promise<ExportResponse> {
    return this.exports.export(projectId, body, idempotencyKey);
  }
}
