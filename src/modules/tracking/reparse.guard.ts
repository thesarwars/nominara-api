import { createParamDecorator, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import type { WorkspaceScopedRequest } from "../../api/guards/workspace.guard.js";
import { PermissionDeniedException } from "../../tenancy/errors.js";
import { ReparseService, type ReparseSource } from "./reparse.service.js";

// STORY-034 AC9 - the route guard of `POST /results/{id}/reparse`. It does two things, in this order, and both must happen before the
// request's transaction exists (a route guard runs ahead of every interceptor, TenantContextInterceptor included).
//
//   1. OWNERS AND ADMINS ONLY (owner decision 2026-10-23, recorded 2026-10-26). The permission matrix has no owner-and-admin-only
//      tracking permission, and adding one is a change to security-and-tenancy.md section 6 that the permission-matrix spec pins at 34
//      rows. `tracking:trigger` (RbacGuard, which runs first) still gates the route, and this narrows it by the caller's LIVE role,
//      which WorkspaceGuard re-verified this request (never the token's role claim). A scoped manager holds `tracking:trigger` and is
//      refused here. An API key has no membership, so RbacGuard has already refused it.
//   2. READ THE RAW OBJECT, with no transaction open, so the handler can parse and write in one transaction without ever awaiting
//      object storage inside it (NFR-ARCH-04). See `ReparseService.prefetchSource`.

/** What the guard leaves on the request for the handler. */
export interface ReparseRequest extends WorkspaceScopedRequest {
  params?: Record<string, string | undefined>;
  reparseSource?: ReparseSource | undefined;
}

@Injectable()
export class ReparseGuard implements CanActivate {
  constructor(private readonly reparses: ReparseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ReparseRequest>();
    const role = req.membership?.role;
    if (role !== "owner" && role !== "admin") {
      incrementCounter("nominara_tracking_reparse_refused_total", { reason: "role" });
      throw new PermissionDeniedException("tracking:trigger", "re-parsing a result is limited to workspace owners and admins");
    }
    // Fail closed: no tenant means no workspace to read the object for.
    if (req.tenant === undefined) throw new PermissionDeniedException("tracking:trigger");
    const resultId = req.params?.id;
    if (resultId === undefined) throw new PermissionDeniedException("tracking:trigger");
    req.reparseSource = await this.reparses.prefetchSource(req.tenant, resultId);
    return true;
  }
}

/** The raw object `ReparseGuard` read for this request, or undefined when the capture has none. */
export const PrefetchedReparseSource = createParamDecorator((_data: unknown, context: ExecutionContext): ReparseSource | undefined => {
  return context.switchToHttp().getRequest<ReparseRequest>().reparseSource;
});
