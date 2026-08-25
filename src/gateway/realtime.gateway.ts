import type { OnModuleDestroy } from "@nestjs/common";
import { MessageBody, ConnectedSocket, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { Logger } from "@nestjs/common";
import { incrementCounter } from "../lib/telemetry/metrics.js";
import { RESYNC_DIRECTIVE, SocketBackpressure, drainReconnectAfterMs } from "./backpressure.js";
import { ROOM_FORBIDDEN_CLOSE_CODE, RoomAuthorizationService, workspaceRoom } from "./room-authorization.service.js";
import { attachValkeyAdapter, type ValkeyAdapterHandle } from "./valkey-adapter.js";

const logger = new Logger("realtime-gateway");

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

  private adapter: ValkeyAdapterHandle | undefined;
  private readonly pressure = new Map<string, SocketBackpressure>();

  constructor(private readonly rooms: RoomAuthorizationService) {}

  /**
   * STORY-026 T22 — AC4. Called by the bootstrap once the server exists.
   *
   * `@WebSocketServer()` on a NAMESPACED gateway injects the Namespace, not
   * the io Server, and `.adapter()` lives on the Server. Reaching through
   * `namespace.server` is what makes the adapter apply to the whole
   * deployment rather than failing with "adapter is not a function" at boot —
   * which is where this first showed up.
   */
  attachAdapter(url: string): void {
    const io = (this.server as unknown as { server?: Server }).server ?? this.server;
    this.adapter = attachValkeyAdapter(io, url);
  }

  /**
   * Sends one event to a socket, honouring §9's twenty-per-second cap.
   *
   * A throttled socket is told ONCE to resync and further messages are
   * DROPPED, never queued — AC7's "no backlog". Buffering would move a slow
   * consumer's problem into the gateway's memory, where it becomes every
   * client's problem, and would eventually deliver a flood of stale state the
   * client must apply in order.
   */
  sendTo(socket: Socket, event: string, payload: unknown): void {
    let budget = this.pressure.get(socket.id);
    if (budget === undefined) {
      budget = new SocketBackpressure();
      this.pressure.set(socket.id, budget);
    }

    const verdict = budget.admit();
    if (verdict.action === "send") {
      socket.emit(event, payload);
      return;
    }
    if (verdict.action === "resync") {
      logger.warn({ message: "socket throttled; resync directive sent", socket_id: socket.id, event });
      incrementCounter("nominara_gateway_resync_directive_total", { event });
      socket.emit(RESYNC_DIRECTIVE, { reason: "rate_limited" });
      return;
    }
    incrementCounter("nominara_gateway_dropped_events_total", { event });
  }

  handleDisconnect(socket: Socket): void {
    this.pressure.delete(socket.id);
  }

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
  async onModuleDestroy(): Promise<void> {
    // STORY-026 T22 — AC9. Each socket gets its OWN jittered delay, computed
    // here rather than left to clients: a client that ignored the advice would
    // be indistinguishable from one that never received it, and every client
    // reconnecting at the same instant is a thundering herd against a gateway
    // that has just lost capacity.
    // `server` here is the /rt Namespace; its connected sockets live on
    // `.sockets`, a Map keyed by socket id.
    const sockets = (this.server as unknown as { sockets?: Map<string, Socket> } | undefined)?.sockets;
    for (const socket of sockets?.values() ?? []) {
      socket.emit(SERVER_DRAINING_EVENT, { reconnect_after_ms: drainReconnectAfterMs() });
    }
    // An unclosed subscriber keeps the process alive and turns a graceful
    // drain into a hung one.
    await this.adapter?.close();
  }
}
