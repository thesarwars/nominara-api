import { Controller, Get, Query } from "@nestjs/common";
import {
  auditLogListResponseSchema,
  auditLogQuerySchema,
  type AuditLogEntry,
  type AuditLogQuery,
} from "../../../contracts/trust/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { AuditLogService } from "./audit-log.service.js";

// NEW-D-3 — api-specification.md §3. Owner and admin only (`audit_log:read`).
@Controller("audit-log")
export class AuditLogController {
  constructor(private readonly service: AuditLogService) {}

  @Get()
  @RequirePermission("audit_log:read")
  @ApiContract({ operationId: "listAuditLog", listOf: true, querySchema: auditLogQuerySchema, responseSchema: auditLogListResponseSchema })
  list(@Query(new ZodValidationPipe(auditLogQuerySchema)) query: AuditLogQuery): Promise<Page<AuditLogEntry>> {
    return this.service.list(query);
  }
}
