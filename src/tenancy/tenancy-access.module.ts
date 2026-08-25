import { Module } from "@nestjs/common";
import { MembershipService } from "../modules/workspaces/membership.service.js";
import { MembershipCacheService } from "./membership-cache.js";

// STORY-026 T21 — membership lookup, with NO controller attached.
//
// THE GATEWAY MUST NOT IMPORT WorkspacesModule, AND THIS IS WHY IT DOES NOT
// HAVE TO. Room authorisation needs `MembershipService`, which today is
// provided by `WorkspacesModule`. But `WorkspacesModule` declares
// `WorkspacesController` and imports `IdentityModule`, which declares
// `IdentityController` AND `OauthController`. `src/gateway.ts` boots its
// module as a Fastify application with NO APP_GUARD, no
// TenantContextInterceptor, no AuditInterceptor and no ProblemFilter — every
// one of those lives in `ApiModule`. Importing `WorkspacesModule` into the
// gateway would therefore mount an UNAUTHENTICATED, UNAUDITED tenant-mutation
// surface on GATEWAY_PORT: workspace create and update, member role changes,
// invitations, and the OAuth callback.
//
// The secret surface matters too, and it is not about which environment
// variables must be set — `env.schema.ts` already requires them in every
// process. It is about what the process would CONSTRUCT: importing
// `WorkspacesModule` runs its `DEK_PROVISIONER` factory, materialising a
// `LocalDekProvisioner` that holds the unwrapped DEK-wrapping key, plus
// `SessionService`'s token-minting seam, inside a process that needs neither.
//
// *** ONE INSTANCE PER PROCESS, BY CONSTRUCTION. ***
// This module is the SOLE provider of both services, and `WorkspacesModule`
// imports and re-exports it rather than declaring them itself. If both
// declared them, a process loading both would get TWO `MembershipCacheService`
// instances — two in-memory Maps. `WorkspacesService` invalidates the cache
// synchronously on `removeMember` and `updateMemberRole`; it would clear one
// and leave the other serving a removed member for up to thirty seconds. That
// is precisely the revocation leak `security-and-tenancy.md` §7 exists to
// prevent, and it would be invisible — every test that resolved either
// instance would pass. `test/unit/gateway-structure.spec.ts` asserts the
// identity of the instance reached through both paths.
@Module({
  providers: [MembershipService, MembershipCacheService],
  exports: [MembershipService, MembershipCacheService],
})
export class TenancyAccessModule {}
