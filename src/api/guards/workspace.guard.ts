import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Pool } from "pg";
import { PG_POOL } from "../../db/pg-pool.js";
import { isWorkspaceUsable, MembershipService } from "../../modules/workspaces/membership.service.js";
import { WORKSPACE_HEADER_NAME } from "../../tenancy/constants.js";
import {
  EntitlementStaleException,
  NotAMemberException,
  UnauthenticatedWorkspaceException,
  WorkspaceMismatchException,
  WorkspaceSuspendedException,
} from "../../tenancy/errors.js";
import type { TenantContext } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";
import { SKIP_TENANT_CONTEXT_KEY } from "../decorators/skip-tenant-context.decorator.js";
import type { AuthenticatedRequest } from "./auth.guard.js";

// STORY-018 — security-and-tenancy.md §5/§7. Real logic replacing the
// STORY-022 no-op: resolves the target workspace, RE-VERIFIES a live
// workspace_members row on every request (never the token's role claim),
// enforces entitlement-version freshness, and refuses a suspended/pending-
// deletion workspace immediately. Runs BEFORE TenantContextInterceptor,
// which is why the membership/workspace-status reads each open their own
// short-lived context transaction (MembershipService) rather than reusing
// the request's not-yet-open transaction.
//
// Two structurally distinct auth methods branch here, matching
// security-and-tenancy.md §5's `req.authMethod: "session" | "apiKey"`
// marker:
//   - session: workspace comes from the JWT `ws` claim; membership is a
//     live workspace_members row, re-checked (and cached) every request.
//   - apiKey: workspace comes from the X-Nominara-Workspace header, checked
//     against the key's own workspace_id; a key has no membership row to
//     re-verify — its own row's lifecycle (STORY-018-E-1: not built yet, see
//     the story file) is a separate mechanism.

export interface ApiKeyContext {
  readonly id: string;
  readonly workspaceId: string;
}

export interface WorkspaceScopedRequest extends AuthenticatedRequest {
  tenant?: TenantContext;
  membership?: { role: string; projectScope: readonly string[] | null };
  apiKey?: ApiKeyContext;
  /**
   * The LIVE `workspaces.entitlement_version`, as read below.
   *
   * STORY-069 AC4 — EntitlementGuard memoises resolution under this version,
   * and this guard has already paid for the read (it compares the live value
   * against the token's `ent_v` and refuses when they differ). Handing it
   * along means a memo hit costs no database round trip at all, and means the
   * two guards cannot disagree about which version this request is being
   * evaluated against.
   */
  entitlementVersion?: number;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class WorkspaceGuard implements CanActivate {
  private readonly logger = new Logger(WorkspaceGuard.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly membership: MembershipService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // ⚠ STORY-153 — A TENANT-LESS ROUTE IS NOT GATED ON THE TOKEN'S CURRENT
    // WORKSPACE, AND LEAVING THAT OUT DEADLOCKED THE PRODUCT.
    //
    // `@SkipTenantContext()`'s own comment has always said "WorkspaceGuard
    // never populates req.tenant for it (there is no workspace in scope)".
    // That was half-implemented: `TenantContextInterceptor`, `AuditInterceptor`
    // and `discover-routes.ts` all consult the metadata, and this guard —
    // which injects `reflector` — consulted only IS_PUBLIC_KEY. So every
    // tenant-less route still resolved the token's `ws` claim and enforced its
    // `ent_v` against it.
    //
    // THE DEADLOCK. STORY-151 made plan changes possible, and a plan change
    // bumps `workspaces.entitlement_version`. Every existing session for that
    // workspace then carries a stale `ent_v` and gets `EntitlementStaleException`
    // — CORRECTLY, on any route that reads entitlements. But it also fired on:
    //
    //   GET  /v1/workspaces            the client asks this FIRST, to decide
    //                                  whether the user belongs anywhere at all
    //   POST /v1/workspaces/{id}/switch  the ONLY route that re-mints a token
    //                                  carrying the CURRENT ent_v
    //
    // So the recovery could not run and the thing that would have fixed the
    // session was itself refused. Every member of a workspace whose plan
    // changed was locked out, with the exit blocked by the condition it
    // existed to clear. STORY-151's own acceptance criterion — "a plan change
    // does not break every other member of the workspace" — did not hold.
    //
    // ⚠ THIS DOES NOT WEAKEN THE STALENESS CHECK. It still fires on every
    // route that reads tenant data, including `GET /billing/entitlements`,
    // which is NOT tenant-less and is the 401 the client recovers FROM.
    //
    // Safe because each tenant-less route establishes its own authority and
    // none of them reads `req.tenant` (pinned by
    // test/unit/api/skip-tenant-context-routes.spec.ts):
    //   POST /workspaces              no workspace exists yet
    //   GET  /workspaces              scoped by `req.auth.sub`, the caller's own memberships
    //   POST /workspaces/{id}/switch  re-checks the TARGET workspace's status and the
    //                                 caller's membership of it (workspaces.service.ts:448-465,
    //                                 which says in terms that it mirrors assertWorkspaceIsUsable)
    //   POST /workspaces/{id}/invitations/accept  the invitation token is the authority,
    //                                 and the caller is by definition not yet a member
    //
    // Note the shape of the original error: the guard gated these on the
    // token's CURRENT workspace, which is not the workspace any of them is
    // about.
    //
    // ⚠ AND THE SAFETY ARGUMENT IS *NOT* GUARD ORDERING. A first draft of
    // this comment said the early return is safe "because AuthGuard runs
    // first". A review refuted it: both are APP_GUARDs and both run on every
    // non-@Public route whatever the order, so reversing them changes which
    // status code surfaces, not whether the caller is authenticated. The
    // argument was pinned by a test that therefore proved nothing about it,
    // and that test is gone — src/api/api.module.spec.ts already pins the
    // real order by observing runtime canActivate calls rather than reading
    // this file's text.
    //
    // What actually holds: a route may skip tenant context only if it needs
    // NOTHING derived from a validated workspace. That is decidable here and
    // is asserted over Nest's own metadata in
    // test/unit/api/skip-tenant-context-routes.spec.ts — no tenant-less route
    // may carry @RequirePermission, @RequireEntitlement, @RequireFeature,
    // @Meter, @DailyCap or @Credits, because each of those is read by a guard
    // that falls back to the RAW `auth.ws` claim when `req.tenant` is absent
    // (entitlement.guard.ts:82, quota.guard.ts:94, daily-cap.guard.ts:72,
    // credit.guard.ts:140, credit.interceptor.ts:481). That fallback was dead
    // before this change — the guard always set `tenant` — and this early
    // return makes it live, so the decorator pairing is what must not happen.
    const skipsTenantContext = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_CONTEXT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipsTenantContext) {
      return true;
    }

    const req = context.switchToHttp().getRequest<WorkspaceScopedRequest>();

    if (req.authMethod === "apiKey") {
      return this.checkApiKeyRequest(req);
    }
    if (req.authMethod === "session" && req.auth) {
      return this.checkSessionRequest(req);
    }
    throw new UnauthenticatedWorkspaceException();
  }

  private async checkApiKeyRequest(req: WorkspaceScopedRequest): Promise<boolean> {
    const headerWorkspaceId = firstValue(req.headers?.[WORKSPACE_HEADER_NAME]);
    const keyWorkspaceId = req.apiKey?.workspaceId;
    if (!keyWorkspaceId || !headerWorkspaceId || headerWorkspaceId !== keyWorkspaceId) {
      throw new WorkspaceMismatchException();
    }

    await this.assertWorkspaceIsUsable(keyWorkspaceId);

    req.tenant = { workspaceId: keyWorkspaceId, actorId: req.apiKey!.id };
    return true;
  }

  private async checkSessionRequest(req: WorkspaceScopedRequest): Promise<boolean> {
    const workspaceId = req.auth!.ws;
    if (!workspaceId) {
      // No active workspace claimed yet (e.g. pre-onboarding token). Nothing
      // for this guard to resolve — the route itself must be @Public() or
      // @SkipTenantContext(), same fail-closed contract STORY-022-E-3 set up.
      return true;
    }

    const workspace = await this.assertWorkspaceIsUsable(workspaceId);

    const userId = req.auth!.sub;
    const live = await this.membership.getLiveMembership(this.pool, userId, workspaceId);
    if (!live || live.status !== "active") {
      throw new NotAMemberException();
    }

    // Review finding 3: `ws` set with `ent_v: null` is legitimate only for a
    // token minted before any workspace was selected — once a workspace IS
    // selected, nothing enforces that ent_v travels with it, so treat that
    // combination as itself stale rather than silently passing it through.
    const tokenEntV = req.auth!.ent_v;
    if (tokenEntV === null || tokenEntV !== workspace.entitlementVersion) {
      incrementCounter("nominara_identity_entitlement_stale_total", { workspace_id: workspaceId });
      throw new EntitlementStaleException();
    }

    req.tenant =
      live.projectScope && live.projectScope.length > 0
        ? { workspaceId, actorId: userId, scopeProjectIds: live.projectScope }
        : { workspaceId, actorId: userId };
    req.membership = { role: live.role, projectScope: live.projectScope };
    // Only after the freshness check above, so what EntitlementGuard memoises
    // under is a version this request has already been proven to be current for.
    req.entitlementVersion = workspace.entitlementVersion;
    return true;
  }

  private async assertWorkspaceIsUsable(workspaceId: string) {
    const workspace = await this.membership.getWorkspaceStatus(this.pool, workspaceId);
    // Review finding 2: `deleted` is a valid value of the same 7-value CHECK
    // as `suspended`/`pending_deletion` (0002_identity_tenancy_billing.up.sql)
    // and was not refused. `deleted_at IS NOT NULL` is checked too, matching
    // the terminal-state precedent in workers/rollup/retention.ts — RLS on
    // `workspaces` only filters by id, not by status/deleted_at, so this
    // guard is the only thing standing between a deleted workspace id and a
    // request that still names it.
    // Read before the narrowing check: `isWorkspaceUsable` is a type
    // predicate, so in the false branch `workspace` is `never` and its status
    // — the one thing the operator needs to see — is unreadable.
    const observedStatus = workspace?.status ?? "unknown";
    if (!isWorkspaceUsable(workspace)) {
      this.logger.warn({ msg: "workspace access refused", workspace_id: workspaceId, status: observedStatus });
      throw new WorkspaceSuspendedException();
    }
    return workspace;
  }
}
