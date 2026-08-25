import type { OnModuleDestroy } from "@nestjs/common";
import { MessageBody, ConnectedSocket, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { ROOM_FORBIDDEN_CLOSE_CODE, RoomAuthorizationService, workspaceRoom } from "./room-authorization.service.js";

// The event name clients listen for during a rolling deploy — a plain
// string constant, not hardcoded inline at each use site.
export const SERVER_DRAINING_EVENT = "server.draining";

/** The message a client sends to join its workspace room. */
export const JOIN_WORKSPACE_MESSAGE = "join:workspace";

// STORY-022 stood up the /rt namespace and the shutdown-drain notice.
// STORY-026 T21 adds room authorisation through the SAME guard chain the HTTP
// path uses (system-architecture.md §9), and nothing else: the Valkey adapter,
// coalescing, backpressure and the typed emitters are T22.
@WebSocketGateway({ namespace: "/rt" })
export class RealtimeGateway implements OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly rooms: RoomAuthorizationService) {}

  /**
   * Joins `ws:{workspace_id}` after authorising the socket.
   *
   * A refusal DISCONNECTS rather than replying with an error, because a socket
   * that cannot prove membership has no business staying connected —
   * system-architecture.md §9 specifies close code 4403 for exactly this. An
   * error reply would leave the connection open and let the client retry
   * against every workspace id it liked, turning a refused join into an
   * enumeration oracle.
   *
   * The workspace id is taken from the MESSAGE, not from the token, and then
   * checked against the token — see RoomAuthorizationService. Reading it from
   * the token instead would make the join unfalsifiable: a socket could only
   * ever join the room it was already entitled to, which sounds safe and means
   * the check is never exercised.
   */
  @SubscribeMessage(JOIN_WORKSPACE_MESSAGE)
  async joinWorkspace(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { workspace_id?: unknown },
  ): Promise<{ joined: boolean; room?: string }> {
    const workspaceId = typeof body?.workspace_id === "string" ? body.workspace_id : "";
    if (workspaceId.length === 0) {
      socket.disconnect(true);
      return { joined: false };
    }

    const decision = await this.rooms.authorizeWorkspaceRoom(socket.handshake, workspaceId);
    if (!decision.allowed) {
      // socket.io has no application close code on disconnect(), so the code is
      // sent as a terminal frame first. A client reading `4403` gets the same
      // signal §9 specifies; a client that ignores it is disconnected anyway.
      socket.emit("error", { close_code: decision.closeCode ?? ROOM_FORBIDDEN_CLOSE_CODE });
      socket.disconnect(true);
      return { joined: false };
    }

    const room = workspaceRoom(workspaceId);
    await socket.join(room);
    return { joined: true, room };
  }

  // NFR-ARCH-07 — zero-downtime deploys: "WebSocket clients receive
  // server.draining and reconnect with jitter." Emitted to every connected
  // client in the /rt namespace as this module tears down, ahead of the
  // process actually exiting (src/gateway.ts calls enableShutdownHooks()).
  //
  // The jittered `reconnect_after_ms` payload is T22's — this keeps
  // STORY-022's behaviour unchanged until the emitter that owns the jitter
  // exists, rather than inventing a constant here that T22 would replace.
  onModuleDestroy(): void {
    this.server?.emit(SERVER_DRAINING_EVENT);
  }
}
