import { Module } from "@nestjs/common";
import { AgencyModule } from "../agency/agency.module.js";
import { PortalController } from "./portal.controller.js";
import { PortalSessionService } from "./portal-session.service.js";
import { PortalContextInterceptor } from "../../api/interceptors/portal-context.interceptor.js";

// STORY-098 part B — registration only. PortalContextInterceptor is provided here (and exported) so every portal
// controller in this module — STORY-099a's reads — resolves it with ShareTokensService from AgencyModule.
@Module({
  imports: [AgencyModule],
  controllers: [PortalController],
  providers: [PortalSessionService, PortalContextInterceptor],
  exports: [PortalContextInterceptor],
})
export class PortalModule {}
