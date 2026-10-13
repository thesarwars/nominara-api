import { Module } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { TenancyAccessModule } from "../../tenancy/tenancy-access.module.js";
import {
  REALTIME_PUBLISHER,
  RealtimePublisherProvider,
  type RealtimePublisher,
} from "../../lib/cache/realtime-publisher.js";
import { AuditModule } from "../audit/audit.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { BillingModule } from "../billing/billing.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { WorkspaceSummaryService } from "./workspace-summary.service.js";
import { LocalDekProvisioner } from "./adapters/local-dek-provisioner.js";
import { DEK_PROVISIONER, type DekProvisioner } from "./ports/dek-provisioner.js";
import { WorkspacesController } from "./workspaces.controller.js";
import { WorkspacesService } from "./workspaces.service.js";
import { InvitationsService } from "./invitations.service.js";
import { OwnershipTransferService } from "./ownership-transfer.service.js";
import { OwnershipTransferController } from "./ownership-transfer.controller.js";
import { ApiKeysModule } from "../api-keys/api-keys.module.js";
import { AgencyModule } from "../agency/agency.module.js";

// STORY-022 module registration, extended by STORY-018 (MembershipService/
// MembershipCacheService exported so WorkspaceGuard, an APP_GUARD in
// api.module.ts, can inject them) and now STORY-021: AuditModule for
// AuditChainService (in-service audits — E-12) and IdentityModule for
// SessionService (POST /workspaces/{id}/switch mints its token through the
// existing switchWorkspace seam). DEK_PROVISIONER is the STORY-020-E-3/E-4
// port-plus-local-adapter precedent — swapped for a real KMS-backed adapter
// by a future story without touching WorkspacesService.
// STORY-026 T21 — MembershipService and MembershipCacheService are no longer
// DECLARED here. They come from TenancyAccessModule, which is controller-free
// so the gateway can import it without mounting this module's HTTP surface.
// Both are re-exported, so every existing consumer of WorkspacesModule keeps
// resolving them unchanged — and there is exactly ONE cache instance per
// process, which is what stops a revoked member being served from a second Map
// for thirty seconds (security-and-tenancy.md §7).
//
// STORY-169 (API step 2/3) adds TasksModule: `GET /v1/workspaces/{id}/
// action-items` joins this controller's `workspaces/:id/*` route family
// (members, invitations), and `tasks` is TasksService's table to own
// (coding-standards.md §1 "one table, one owning service") — so this module
// imports the SERVICE rather than querying `tasks` here.
@Module({
  imports: [AuditModule, IdentityModule, TenancyAccessModule, TasksModule, ProjectsModule, BillingModule, ApiKeysModule, AgencyModule],
  controllers: [WorkspacesController, OwnershipTransferController],
  providers: [
    WorkspacesService,
    InvitationsService,
    OwnershipTransferService,
    WorkspaceSummaryService,
    // STORY-026 T22 / D9 — the API process publishes realtime events onto a
    // Valkey channel the gateway reads, never by standing up a socket.io
    // server of its own. (It used @socket.io/redis-emitter until the delivery
    // path moved per-socket; see realtimeFanoutChannel().) Chosen by
    // environment exactly as the cache adapter is.
    {
      provide: REALTIME_PUBLISHER,
      useFactory: (): RealtimePublisher => RealtimePublisherProvider.create(),
    },
    {
      provide: DEK_PROVISIONER,
      useFactory: (): DekProvisioner => {
        const env = loadEnv();
        return new LocalDekProvisioner(Buffer.from(env.WORKSPACE_DEK_WRAPPING_KEY, "base64"), env.WORKSPACE_KMS_KEY_ARN);
      },
    },
  ],
  exports: [WorkspacesService, TenancyAccessModule],
})
export class WorkspacesModule {}
