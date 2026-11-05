import { Module } from "@nestjs/common";
import { StorageModule } from "../../lib/storage/storage.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { EMAIL_SENDER } from "../identity/ports/email-sender.js";
import { selectEmailSender } from "../identity/identity.module.js";
import { ExportService } from "./export.service.js";
import { MethodologyService } from "./methodology.service.js";
import { ReportLinksController } from "./report-links.controller.js";
import { ReportLinksService } from "./report-links.service.js";
import { ReportsController } from "./reports.controller.js";
import { ScheduledReportsController } from "./scheduled-reports.controller.js";
import { ScheduledReportsService } from "./scheduled-reports.service.js";

// NEW-E-100a / NEW-E-100b / NEW-E-100c / STORY-180 — registration only (StorageModule imported where storage is used). EMAIL_SENDER is chosen by the same
// selector IdentityModule uses (logging adapter by default), so a scheduled report is "logged", not "delivered".
@Module({
  imports: [EntitlementsModule, StorageModule],
  controllers: [ReportsController, ScheduledReportsController, ReportLinksController],
  providers: [MethodologyService, ExportService, ScheduledReportsService, ReportLinksService, { provide: EMAIL_SENDER, useFactory: selectEmailSender }],
  exports: [MethodologyService],
})
export class ReportsModule {}
