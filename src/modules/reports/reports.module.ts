import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { EMAIL_SENDER } from "../identity/ports/email-sender.js";
import { selectEmailSender } from "../identity/identity.module.js";
import { ExportService } from "./export.service.js";
import { MethodologyService } from "./methodology.service.js";
import { ReportsController } from "./reports.controller.js";
import { ScheduledReportsController } from "./scheduled-reports.controller.js";
import { ScheduledReportsService } from "./scheduled-reports.service.js";

// NEW-E-100a / NEW-E-100b / NEW-E-100c — registration only. EMAIL_SENDER is chosen by the same
// selector IdentityModule uses (logging adapter by default), so a scheduled report is "logged", not "delivered".
@Module({
  imports: [EntitlementsModule],
  controllers: [ReportsController, ScheduledReportsController],
  providers: [MethodologyService, ExportService, ScheduledReportsService, { provide: EMAIL_SENDER, useFactory: selectEmailSender }],
  exports: [MethodologyService],
})
export class ReportsModule {}
