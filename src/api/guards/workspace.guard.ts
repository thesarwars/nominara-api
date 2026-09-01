import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Pool } from "pg";
import { PG_POOL } from "../../db/pg-pool.js";
import { MembershipService } from "../../modules/workspaces/membership.service.js";
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
    const isUnusable =
      !workspace ||
      workspace.status === "suspended" ||
      workspace.status === "pending_deletion" ||
      workspace.status === "deleted" ||
      workspace.deletedAt !== null;
    if (isUnusable) {
      this.logger.warn({ msg: "workspace access refused", workspace_id: workspaceId, status: workspace?.status ?? "unknown" });
      throw new WorkspaceSuspendedException();
    }
    return workspace;
  }
}
