import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { ExportService } from "./export.service.js";
import { MethodologyService } from "./methodology.service.js";
import { ReportsController } from "./reports.controller.js";

// NEW-E-100a / NEW-E-100b — registration only.
@Module({
  imports: [EntitlementsModule],
  controllers: [ReportsController],
  providers: [MethodologyService, ExportService],
  exports: [MethodologyService],
})
export class ReportsModule {}
