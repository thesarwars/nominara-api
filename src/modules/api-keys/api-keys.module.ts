import { Module } from "@nestjs/common";
import { ApiKeysController } from "./api-keys.controller.js";
import { ApiKeysService } from "./api-keys.service.js";

// NEW-D-4 — registration only. The audit rows come from AuditInterceptor.
@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
})
export class ApiKeysModule {}
