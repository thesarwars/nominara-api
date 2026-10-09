import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  createScheduledReportRequestSchema,
  scheduledReportListQuerySchema,
  scheduledReportListResponseSchema,
  scheduledReportSchema,
  sendScheduledReportNowResponseSchema,
  updateScheduledReportRequestSchema,
  type CreateScheduledReportRequest,
  type ScheduledReport,
  type ScheduledReportDelivery,
  type ScheduledReportListQuery,
  type UpdateScheduledReportRequest,
} from "../../../contracts/reports/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ScheduledReportsService } from "./scheduled-reports.service.js";

const idPipe = new ZodValidationPipe(z.uuid());

// NEW-E-100c — STORY-100 part C. Permission agency:branding on every route.
// No logic here: validation, metering and delivery are the service's.
@Controller("scheduled-reports")
export class ScheduledReportsController {
  constructor(private readonly service: ScheduledReportsService) {}

  @Get()
  @RequirePermission("agency:branding")
  @ApiContract({ operationId: "listScheduledReports", querySchema: scheduledReportListQuerySchema, responseSchema: scheduledReportListResponseSchema, listOf: true })
  list(@Query(new ZodValidationPipe(scheduledReportListQuerySchema)) query: ScheduledReportListQuery): Promise<Page<ScheduledReport>> {
    return this.service.list(query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("agency:branding")
  @Audit({ action: "scheduled_report.created", resourceType: "scheduled_report", resourceIdFrom: "response" })
  @ApiContract({ operationId: "createScheduledReport", requestSchema: createScheduledReportRequestSchema, responseSchema: scheduledReportSchema })
  create(@Body(new ZodValidationPipe(createScheduledReportRequestSchema)) body: CreateScheduledReportRequest): Promise<ScheduledReport> {
    return this.service.create(body);
  }

  @Patch(":id")
  @RequirePermission("agency:branding")
  @Audit({ action: "scheduled_report.updated", resourceType: "scheduled_report" })
  @ApiContract({ operationId: "updateScheduledReport", requestSchema: updateScheduledReportRequestSchema, responseSchema: scheduledReportSchema })
  update(
    @Param("id", idPipe) id: string,
    @Body(new ZodValidationPipe(updateScheduledReportRequestSchema)) body: UpdateScheduledReportRequest,
  ): Promise<ScheduledReport> {
    return this.service.update(id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("agency:branding")
  @Audit({ action: "scheduled_report.deleted", resourceType: "scheduled_report" })
  @ApiContract({ operationId: "deleteScheduledReport", voidResponse: true })
  remove(@Param("id", idPipe) id: string): Promise<void> {
    return this.service.remove(id);
  }

  @Post(":id/send-now")
  @HttpCode(200)
  @RequirePermission("agency:branding")
  @Audit({ action: "scheduled_report.sent_now", resourceType: "scheduled_report" })
  @ApiContract({ operationId: "sendScheduledReportNow", responseSchema: sendScheduledReportNowResponseSchema })
  sendNow(@Param("id", idPipe) id: string): Promise<ScheduledReportDelivery> {
    return this.service.sendNow(id);
  }
}
