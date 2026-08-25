import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CanActivate } from "@nestjs/common";
import type { Pool } from "pg";
import { AuthGuard } from "../api/guards/auth.guard.js";
import { RbacGuard } from "../api/guards/rbac.guard.js";
import { WorkspaceGuard } from "../api/guards/workspace.guard.js";
import { PG_POOL } from "../db/pg-pool.js";
import { incrementCounter } from "../lib/telemetry/metrics.js";
import { MembershipService } from "../modules/workspaces/membership.service.js";
import { executionContextForSocket, requestFromHandshake, type HandshakeLike } from "./ws-execution-context.js";

// STORY-026 T21 — room authorisation.
//
// system-architecture.md §9: "Room join is authorised by the same
// `WorkspaceGuard` + `RbacGuard` chain as REST; a socket that cannot prove
// membership is disconnected with code `4403`."
//
// "The same chain" is meant literally. The guards are injected here as the
// instances Nest resolved, and invoked through a synthesised ExecutionContext
// — not reimplemented, not subclassed, not copied. A second implementation of
// "is this caller a member" is a second place for the answer to drift, and the
// drift would be silent in exactly the direction that matters.

const logger = new Logger("room-authorization");

/** system-architecture.md §9's close code. A WebSocket application close code, not an HTTP status. */
export const ROOM_FORBIDDEN_CLOSE_CODE = 4403;

export interface RoomAuthorizationResult {
  readonly allowed: boolean;
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly closeCode?: number;
  readonly reason?: string;
}

/** `ws:{workspace_id}` and `proj:{project_id}` — §11's two room forms. */
export function workspaceRoom(workspaceId: string): string {
  return `ws:${workspaceId}`;
}

export function projectRoom(projectId: string): string {
  return `proj:${projectId}`;
}

@Injectable()
export class RoomAuthorizationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly membership: MembershipService,
    private readonly authGuard: AuthGuard,
    private readonly workspaceGuard: WorkspaceGuard,
    private readonly rbacGuard: RbacGuard,
  ) {}

  /**
   * The guards, in the order the HTTP chain runs them.
   *
   * Exposed so `realtime-guard-parity.spec.ts` can assert these are the SAME
   * INSTANCES the container provides, rather than trusting a comment saying
   * they are. "We reuse the guards" is exactly the kind of claim that quietly
   * stops being true.
   */
  get chain(): readonly CanActivate[] {
    return [this.authGuard, this.workspaceGuard, this.rbacGuard];
  }

  /**
   * Authorises a socket for a workspace room.
   *
   * The guards are injected, not constructed — the same classes the API
   * process registers as APP_GUARDs, resolved from this process's container.
   *
   * Membership is read LIVE at join, not from the token's claims. A token is
   * valid for fifteen minutes; a membership can be revoked in the middle of
   * that, and `security-and-tenancy.md` §7 is explicit that revocation must not
   * wait for a token to expire. `MembershipService.getLiveMembership` is the
   * same call `WorkspaceGuard` makes on the HTTP path, through the same
   * single-instance cache.
   */
  async authorizeWorkspaceRoom(handshake: HandshakeLike, workspaceId: string): Promise<RoomAuthorizationResult> {
    const request = requestFromHandshake(handshake);
    const context = executionContextForSocket(request);

    for (const guard of this.chain) {
      try {
        const allowed = await guard.canActivate(context);
        if (allowed !== true) {
          return this.refuse(workspaceId, undefined, "guard_refused");
        }
      } catch (error) {
        // A guard REFUSING is the expected path for an unauthorised socket, and
        // it refuses by throwing. The reason is deliberately not put on the
        // wire: the close code is all a client gets, because distinguishing
        // "not a member" from "workspace suspended" over an unauthenticated
        // channel would answer a question the caller has not earned.
        return this.refuse(workspaceId, undefined, error instanceof Error ? error.name : "guard_threw");
      }
    }

    const auth = request.auth as { sub?: string; ws?: string | null } | undefined;
    const userId = auth?.sub;
    if (userId === undefined) {
      return this.refuse(workspaceId, undefined, "unauthenticated");
    }

    // THE TOKEN'S OWN WORKSPACE CLAIM IS NOT ENOUGH, AND IS NOT WHAT IS
    // CHECKED. A token is pinned to one workspace (`ws`), so a socket
    // presenting a token for workspace A must not join workspace B's room even
    // if the caller is a member of both — that is what "a token is never valid
    // for two tenants" means, and it is checked here rather than assumed from
    // the guards, which authorised the token rather than this room.
    if (auth?.ws !== workspaceId) {
      return this.refuse(workspaceId, userId, "token_pinned_to_another_workspace");
    }

    const live = await this.membership.getLiveMembership(this.pool, userId, workspaceId);
    if (live === null || live.status !== "active") {
      return this.refuse(workspaceId, userId, "not_an_active_member");
    }

    incrementCounter("nominara_gateway_room_join_total", { outcome: "allowed" });
    return { allowed: true, workspaceId, userId };
  }

  private refuse(workspaceId: string, userId: string | undefined, reason: string): RoomAuthorizationResult {
    incrementCounter("nominara_gateway_room_join_total", { outcome: "refused" });
    // coding-standards.md §7 — the workspace ID, never the workspace name.
    logger.warn({
      message: "room join refused",
      workspace_id: workspaceId,
      user_id: userId ?? null,
      reason,
      close_code: ROOM_FORBIDDEN_CLOSE_CODE,
    });
    return { allowed: false, closeCode: ROOM_FORBIDDEN_CLOSE_CODE, reason };
  }
}
