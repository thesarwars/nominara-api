import { Injectable, Logger } from "@nestjs/common";
import type { CanActivate } from "@nestjs/common";
import { AuthGuard } from "../api/guards/auth.guard.js";
import { RbacGuard } from "../api/guards/rbac.guard.js";
import { WorkspaceGuard } from "../api/guards/workspace.guard.js";
import { incrementCounter } from "../lib/telemetry/metrics.js";
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
    private readonly authGuard: AuthGuard,
    private readonly workspaceGuard: WorkspaceGuard,
    private readonly rbacGuard: RbacGuard,
  ) {}

  /**
   * The guards, in the order the HTTP chain runs them.
   *
   * Exposed so `test/unit/gateway-structure.spec.ts` can assert these are the SAME
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
   * Membership is read LIVE by WorkspaceGuard, not taken from the token's
   * claims — a token is valid for fifteen minutes and a membership can be
   * revoked inside that, which `security-and-tenancy.md` §7 says must not
   * wait. Running the guard rather than reimplementing its check is what makes
   * that true here without a second implementation to keep in step.
   */
  async authorizeWorkspaceRoom(handshake: HandshakeLike, workspaceId: string): Promise<RoomAuthorizationResult> {
    // SYNTHESIS INSIDE THE REFUSAL PATH. This sat outside the guard loop's
    // try/catch, so anything thrown while building the request escaped as a
    // generic exception frame — no 4403, no disconnect, no refusal metric —
    // rather than as the refusal every other failure here produces. A
    // malformed cookie value was enough to reach it. Fail closed: a handshake
    // we cannot even parse is a handshake we cannot authorise.
    let request: ReturnType<typeof requestFromHandshake>;
    try {
      request = requestFromHandshake(handshake);
    } catch {
      return this.refuse(workspaceId, undefined, "malformed_handshake");
    }
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

    // MEMBERSHIP IS NOT RE-READ HERE, AND THAT IS DELIBERATE.
    //
    // There was a `getLiveMembership` call at this point. Mutation testing
    // removed it and every test stayed green — because WorkspaceGuard, which
    // ran three lines above, already re-reads live membership for
    // `req.auth.ws`, and the pin check immediately above guarantees that is
    // the workspace being joined. The re-read was dead weight that LOOKED
    // load-bearing, which is worse than absent: a reader would assume it was
    // the thing enforcing revocation and reason from that.
    //
    // Revocation IS enforced, by the guard, and there is a test for it —
    // "refuses a member whose membership was revoked AFTER the token was
    // minted" in realtime-room-authorization.spec.ts. That is what §9's "the
    // same WorkspaceGuard + RbacGuard chain as REST" buys, and duplicating the
    // check here would have been a second implementation to keep in step.

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
