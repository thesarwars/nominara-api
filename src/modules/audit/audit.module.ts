import { Module } from "@nestjs/common";
import { AuditLogController } from "./audit-log.controller.js";
import { AuditLogService } from "./audit-log.service.js";
import { AuditChainService } from "./audit-chain.service.js";
import { AuditQueryService } from "./audit-query.service.js";

// STORY-020 — registration only. AuditInterceptor (src/api/interceptors)
// depends on AuditChainService; importing this module into ApiModule is
// what makes that DI edge resolvable.
@Module({
  controllers: [AuditLogController],
  providers: [AuditChainService, AuditQueryService, AuditLogService],
  exports: [AuditChainService, AuditQueryService],
})
export class AuditModule {}
