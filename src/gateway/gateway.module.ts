import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { TenancyAccessModule } from "../tenancy/tenancy-access.module.js";
import { AuthGuard } from "../api/guards/auth.guard.js";
import { WorkspaceGuard } from "../api/guards/workspace.guard.js";
import { RbacGuard } from "../api/guards/rbac.guard.js";
import { RoomAuthorizationService } from "./room-authorization.service.js";
import { RealtimeGateway } from "./realtime.gateway.js";

// STORY-026 T21 — the gateway process's module graph.
//
// *** WHAT IS NOT IMPORTED IS THE POINT. ***
// `WorkspacesModule` is absent, and must stay absent. It declares
// `WorkspacesController` and imports `IdentityModule`, which declares
// `IdentityController` and `OauthController`. `src/gateway.ts` boots this
// module as a Fastify application with NO APP_GUARD, no
// TenantContextInterceptor, no AuditInterceptor and no ProblemFilter — those
// all live in `ApiModule`. Importing it here would mount an unauthenticated,
// unaudited tenant-mutation surface on GATEWAY_PORT: workspace create and
// update, member role changes, invitations, and the OAuth callback.
// `gateway-has-no-http-routes.spec.ts` locks that shut.
//
// `@Global()` DOES NOT SELF-REGISTER. `CacheModule` and any other global module
// only becomes ambient once something in the graph imports it, and this module
// imports nothing by default — so `DbModule` and `TenancyAccessModule` are
// listed explicitly. Without them the gateway fails to resolve `PG_POOL` at
// boot, which is a crash at startup rather than a subtle fault, but a crash on
// deploy all the same.
//
// The three guards are registered as ORDINARY PROVIDERS, not APP_GUARDs. They
// must not run against this process's (empty) HTTP surface; they exist here so
// RoomAuthorizationService can invoke the very same instances the API process
// uses on every request.
@Module({
  imports: [DbModule, TenancyAccessModule],
  providers: [AuthGuard, WorkspaceGuard, RbacGuard, RoomAuthorizationService, RealtimeGateway],
  exports: [RoomAuthorizationService],
})
export class RealtimeModule {}
