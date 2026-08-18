import { Module } from "@nestjs/common";
import { MembershipCacheService } from "../../tenancy/membership-cache.js";
import { WorkspacesController } from "./workspaces.controller.js";
import { WorkspacesService } from "./workspaces.service.js";
import { MembershipService } from "./membership.service.js";

// STORY-022 module registration, extended by STORY-018: MembershipService/
// MembershipCacheService are exported so WorkspaceGuard (an APP_GUARD
// declared in api.module.ts's own providers) can inject them, since
// ApiModule imports this module.
@Module({
  controllers: [WorkspacesController],
  providers: [WorkspacesService, MembershipService, MembershipCacheService],
  exports: [WorkspacesService, MembershipService, MembershipCacheService],
})
export class WorkspacesModule {}
