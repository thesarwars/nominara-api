import { Module } from "@nestjs/common";
import { AgencyModule } from "../agency/agency.module.js";
import { AnalyticsModule } from "../analytics/analytics.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { ReportsModule } from "../reports/reports.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PortalEmailCodesService } from "./portal-email-codes.service.js";
import { PortalReadsController } from "./portal-reads.controller.js";
import { PortalReadsService } from "./portal-reads.service.js";
import { PortalTelemetryController } from "./portal-telemetry.controller.js";
import { PortalTelemetryService } from "./portal-telemetry.service.js";
import { PortalController } from "./portal.controller.js";
import { PortalSessionService } from "./portal-session.service.js";
import { PortalContextInterceptor } from "../../api/interceptors/portal-context.interceptor.js";

// STORY-098 part B / NEW-E-099a — registration only. PortalContextInterceptor is provided here (and exported) so every portal
// controller in this module — STORY-099a's reads — resolves it with ShareTokensService from AgencyModule.
@Module({
  imports: [AgencyModule, IdentityModule, AnalyticsModule, ReportsModule, ProjectsModule, WorkspacesModule, TasksModule],
  controllers: [PortalController, PortalReadsController, PortalTelemetryController],
  providers: [PortalSessionService, PortalEmailCodesService, PortalTelemetryService, PortalReadsService, PortalContextInterceptor],
  exports: [PortalContextInterceptor],
})
export class PortalModule {}
