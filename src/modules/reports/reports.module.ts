import { Module } from "@nestjs/common";
import { MethodologyService } from "./methodology.service.js";
import { ReportsController } from "./reports.controller.js";

// NEW-E-100a — registration only.
@Module({
  controllers: [ReportsController],
  providers: [MethodologyService],
  exports: [MethodologyService],
})
export class ReportsModule {}
