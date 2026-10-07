import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PermissionDeniedException, ProjectOutOfScopeException } from "../../tenancy/errors.js";
import { evaluatePermission, type Permission } from "../../tenancy/permission-matrix.js";
import { assertStepUpFresh } from "../../tenancy/step-up.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";
import { PROJECT_PARAM_KEY } from "../decorators/project-param.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../decorators/require-permission.decorator.js";
import { SCOPED_BY_QUERY_KEY } from "../decorators/scoped-by-query.decorator.js";
import type { WorkspaceScopedRequest } from "./workspace.guard.js";

// STORY-019 — security-and-tenancy.md §6/§7. Replaces the STORY-022 no-op:
// evaluates @RequirePermission against the §6 matrix (permission-matrix.ts)
// using req.membership.role — the LIVE role WorkspaceGuard re-verified this
// request, never req.auth.role, which §7 calls "a hint for UI rendering
// only". Scope is read from req.membership.projectScope directly, NOT
// req.tenant.scopeProjectIds: that field already collapses an empty scope
// array and an unrestricted (null) one to the same "undefined" shape
// (workspace.guard.ts's ternary), which would silently widen a
// zero-project manager to full access.
//
// Entirely synchronous over fields WorkspaceGuard/AuthGuard already
// populated — adds zero DB/cache lookups of its own (AC "at most one cached
// lookup per request" is satisfied by adding none).
export interface RbacScopedRequest extends WorkspaceScopedRequest {
  params?: Record<string, string | undefined>;
}

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const permission = this.reflector.getAllAndOverride<Permission>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) {
      // No @RequirePermission on this route — nothing for this guard to
      // enforce (matches @Public()/@SkipTenantContext()'s "absent metadata
      // means this guard has no opinion" precedent elsewhere in the chain).
      return true;
    }

    const req = context.switchToHttp().getRequest<RbacScopedRequest>();

    // A request that never selected a workspace (or a route reachable
    // before WorkspaceGuard ever populated req.membership) has no live role
    // to evaluate against — fail closed, cleanly, rather than throwing on
    // an undefined read.
    if (!req.membership) {
      throw new PermissionDeniedException(permission);
    }

    const rule = evaluatePermission(req.membership.role, permission);
    if (rule.access === "deny") {
      throw new PermissionDeniedException(permission);
    }

    if (rule.access === "scoped") {
      this.assertInScope(req, permission, context);
    }

    if (rule.stepUp) {
      this.assertStepUp(req);
    }

    return true;
  }

  private assertInScope(req: RbacScopedRequest, permission: Permission, context: ExecutionContext): void {
    const scope = req.membership!.projectScope;
    // null/undefined = unrestricted (project_scope IS NULL — "all
    // projects"). An empty array is a DISTINCT state — scoped to zero
    // projects — and must refuse every project-scoped request, which is
    // exactly why this reads req.membership.projectScope and not the
    // collapsed req.tenant.scopeProjectIds.
    if (scope === null || scope === undefined) {
      return;
    }

    const paramName = this.reflector.getAllAndOverride<string>(PROJECT_PARAM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (paramName) {
      const projectId = req.params?.[paramName];
      if (!projectId || !scope.includes(projectId)) {
        throw new ProjectOutOfScopeException();
      }
      return;
    }

    // No `@ProjectParam()` — a single-project id to compare `scope` against
    // does not exist on this route. `@ScopedByQuery()` is the one documented
    // exception (see its own comment): the route's query narrows by
    // `app.current_scope_projects()` itself, so a NON-EMPTY scope is let
    // through here rather than refused. `scope.length === 0` is refused
    // regardless — see `@ScopedByQuery()` for why that case must never
    // reach the query.
    //
    // Read from the HANDLER ONLY, deliberately never `getAllAndOverride`
    // against `[handler, class]` — see the decorator's own comment: this is
    // the one metadata key on this guard's path that WIDENS access, so it
    // must never be reachable by putting the decorator on a controller
    // class, only on the one route that opts in.
    const scopedByQuery = this.reflector.get<boolean>(SCOPED_BY_QUERY_KEY, context.getHandler());
    if (scopedByQuery && scope.length > 0) {
      return;
    }
    throw new ProjectOutOfScopeException();
  }

  private assertStepUp(req: RbacScopedRequest): void {
    // The window and its closed edge live in tenancy/step-up.ts (STORY-173
    // moved them there so adding a passkey applies the same rule).
    assertStepUpFresh(req.session?.lastStrongAuthAt ?? null);
  }
}
