import { Module } from "@nestjs/common";
import { AuditChainService } from "./audit-chain.service.js";
import { AuditQueryService } from "./audit-query.service.js";

// STORY-020 — registration only. AuditInterceptor (src/api/interceptors)
// depends on AuditChainService; importing this module into ApiModule is
// what makes that DI edge resolvable.
@Module({
  providers: [AuditChainService, AuditQueryService],
  exports: [AuditChainService, AuditQueryService],
})
export class AuditModule {}
