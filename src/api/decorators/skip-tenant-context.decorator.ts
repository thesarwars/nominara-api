import { SetMetadata } from "@nestjs/common";

// STORY-014 (fixed post-review) — marks a route as session-authenticated but
// genuinely tenant-less: AuthGuard still runs and requires a valid access
// token (this is NOT @Public()), but WorkspaceGuard never populates
// req.tenant for it (there is no workspace in scope), so
// TenantContextInterceptor must not fail-closed the way E-3 requires for
// every OTHER private route. /me/passkeys is the first user of this — a
// user can manage their passkeys before any workspace exists.
export const SKIP_TENANT_CONTEXT_KEY = "skipTenantContext";
export const SkipTenantContext = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_TENANT_CONTEXT_KEY, true);
