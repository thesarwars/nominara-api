import { applyDecorators, createParamDecorator, SetMetadata, UseInterceptors, type ExecutionContext } from "@nestjs/common";
import type { PortalSessionPolicy } from "../../modules/agency/share-tokens.service.js";
import type { PortalFacts } from "../../lib/portal/portal-facts.js";
import { ProjectOutOfScopeError } from "../errors/domain-errors.js";
import { PortalContextInterceptor } from "../interceptors/portal-context.interceptor.js";
import { Public } from "./public.decorator.js";
import { SkipTenantContext } from "./skip-tenant-context.decorator.js";

// STORY-098 part B — marks a route as a PORTAL route: authenticated by the portal session cookie and by nothing
// else, running its queries as `nominara_portal` inside PortalContextInterceptor's transaction.
//
// `@Public()` and `@SkipTenantContext()` are applied here because the session AuthGuard and TenantContextInterceptor
// speak for the agency's users; a portal visitor has neither a session nor a membership, and the app pool's tenant
// transaction must not open for them. The portal's own interceptor is the replacement, not an addition: a portal
// route that ran BOTH would hold two transactions and two identities.
export const PORTAL_ROUTE_KEY = "portalRoute";

export const PortalRoute = (): MethodDecorator & ClassDecorator =>
  applyDecorators(Public(), SkipTenantContext(), SetMetadata(PORTAL_ROUTE_KEY, true), UseInterceptors(PortalContextInterceptor));

/** The scope a portal request runs with. Every field comes from the decrypted cookie; none from the request. */
export interface PortalSessionContext {
  readonly tokenId: string;
  readonly workspaceId: string;
  readonly scopeProjectIds: readonly string[];
  readonly scopeTabs: readonly string[];
  readonly themeId: string | null;
  /** Owner decision 71 (c) — the `share_token_views` row this session opened, from the cookie; null for a session minted before view ids existed. */
  readonly viewId: string | null;
  /** NEW-E-099a — the token row's serving policy, re-read on every request (never from the cookie or the request). */
  readonly policy: PortalSessionPolicy;
  /** NEW-E-099a — workspace facts read on the app pool in the same per-request step (the portal role cannot read them). */
  readonly facts: PortalFacts;
}

export interface PortalRequest {
  portal?: PortalSessionContext;
}

export const PortalSession = createParamDecorator((_data: unknown, context: ExecutionContext): PortalSessionContext => {
  const session = context.switchToHttp().getRequest<PortalRequest>().portal;
  // Unreachable behind @PortalRoute(): the interceptor refuses before the handler runs. Fail closed if it ever is.
  if (session === undefined) throw new Error("PortalSession used on a route without @PortalRoute()");
  return session;
});

/**
 * `?project=` is a SELECTOR intersected with the cookie scope, never a grant: an id outside the scope is a
 * 403 `project_out_of_scope` (contracts/portal/portal-read.schema.ts). A project id in the path or a header is not
 * read at all. The database narrows independently (portal_scope_* policies), so this is the readable half.
 */
export function selectPortalProject(session: PortalSessionContext, requested: string): string {
  if (!session.scopeProjectIds.includes(requested)) throw new ProjectOutOfScopeError();
  return requested;
}
