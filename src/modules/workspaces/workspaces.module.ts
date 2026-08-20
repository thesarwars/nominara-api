import { Module } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { MembershipCacheService } from "../../tenancy/membership-cache.js";
import { AuditModule } from "../audit/audit.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { LocalDekProvisioner } from "./adapters/local-dek-provisioner.js";
import { DEK_PROVISIONER, type DekProvisioner } from "./ports/dek-provisioner.js";
import { WorkspacesController } from "./workspaces.controller.js";
import { WorkspacesService } from "./workspaces.service.js";
import { MembershipService } from "./membership.service.js";
import { InvitationsService } from "./invitations.service.js";

// STORY-022 module registration, extended by STORY-018 (MembershipService/
// MembershipCacheService exported so WorkspaceGuard, an APP_GUARD in
// api.module.ts, can inject them) and now STORY-021: AuditModule for
// AuditChainService (in-service audits — E-12) and IdentityModule for
// SessionService (POST /workspaces/{id}/switch mints its token through the
// existing switchWorkspace seam). DEK_PROVISIONER is the STORY-020-E-3/E-4
// port-plus-local-adapter precedent — swapped for a real KMS-backed adapter
// by a future story without touching WorkspacesService.
@Module({
  imports: [AuditModule, IdentityModule],
  controllers: [WorkspacesController],
  providers: [
    WorkspacesService,
    MembershipService,
    MembershipCacheService,
    InvitationsService,
    {
      provide: DEK_PROVISIONER,
      useFactory: (): DekProvisioner => {
        const env = loadEnv();
        return new LocalDekProvisioner(Buffer.from(env.WORKSPACE_DEK_WRAPPING_KEY, "base64"), env.WORKSPACE_KMS_KEY_ARN);
      },
    },
  ],
  exports: [WorkspacesService, MembershipService, MembershipCacheService],
})
export class WorkspacesModule {}
