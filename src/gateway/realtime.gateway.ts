import { Inject, type OnModuleDestroy } from "@nestjs/common";
import { MessageBody, ConnectedSocket, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { Logger } from "@nestjs/common";
import { incrementCounter } from "../lib/telemetry/metrics.js";
import { RESYNC_DIRECTIVE, SocketBackpressure, drainReconnectAfterMs } from "./backpressure.js";
import { ROOM_FORBIDDEN_CLOSE_CODE, RoomAuthorizationService, workspaceRoom } from "./room-authorization.service.js";
import { Redis } from "ioredis";
import { memberChangedEventSchema } from "../../contracts/events/platform-events.schema.js";
import { attachValkeyAdapter, type ValkeyAdapterHandle } from "./valkey-adapter.js";

const logger = new Logger("realtime-gateway");

/** security-and-tenancy.md §7 — the longest a revoked membership may keep a socket. */
export const SOCKET_REVALIDATION_MS = 60_000;

/**
 * DI token for the interval above.
 *
 * A token rather than a `useFactory` registration of the gateway itself, and
 * the reason is not style: Nest discovers WebSocket gateways from a provider's
 * METATYPE, which a factory-provided instance does not have. Registering
 * `RealtimeGateway` through `useFactory` silently produced a process with no
 * `/rt` namespace at all — every socket connection failed at the handshake,
 * and nothing in the module said why.
 */
export const SOCKET_REVALIDATION_INTERVAL = Symbol("SOCKET_REVALIDATION_INTERVAL");

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
  private control: Redis | undefined;
  private readonly pressure = new Map<string, SocketBackpressure>();

  /**
   * Who is on each socket, recorded at join.
   *
   * Needed because a revocation names a USER and a WORKSPACE, and closing the
   * right sockets means knowing which ones those are. socket.io can find a
   * ROOM's members; it cannot answer "which of these is user X".
   */
  private readonly joined = new Map<string, { userId: string; workspaceId: string }>();
  private readonly revalidations = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly rooms: RoomAuthorizationService,
    /** §7's bound. Zero disables it, which is how row 3a proves the EVENT closes the socket rather than the timer. */
    @Inject(SOCKET_REVALIDATION_INTERVAL) private readonly revalidationMs: number = SOCKET_REVALIDATION_MS,
  ) {}

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

  /**
   * STORY-026 T22 — the gateway side of `member.changed`.
   *
   * §11 says the event "forces socket re-auth", and that has to happen HERE:
   * an event delivered only to clients relies on the client to disconnect
   * itself, which is not a security control. The API publishes to a control
   * channel every gateway process subscribes to, and each process closes the
   * sockets it owns.
   */
  attachControlChannel(url: string, channel: string): void {
    const subscriber = new Redis(url, { maxRetriesPerRequest: 2 });
    this.control = subscriber;
    subscriber.on("error", (error: Error) => {
      logger.error({ message: "control channel error", error: error.name });
    });
    void subscriber.subscribe(channel);
    subscriber.on("message", (_channel: string, raw: string) => {
      this.onMemberChanged(raw);
    });
  }

  /** Exposed for tests: applies one control message without a Valkey in the middle. */
  onMemberChanged(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const event = memberChangedEventSchema.safeParse(parsed);
    if (!event.success) return;

    // EVERY membership change closes the socket, not only a removal. A demotion
    // leaves an already-authorised socket over-privileged for whatever it was
    // authorised to see, and the cheapest correct answer is to make it
    // re-authorise from scratch. A reconnect costs one handshake; getting the
    // "which changes matter" judgement wrong costs a leak.
    for (const [socketId, who] of this.joined) {
      if (who.userId !== event.data.user_id || who.workspaceId !== event.data.workspace_id) continue;
      const socket = this.socketById(socketId);
      incrementCounter("nominara_gateway_forced_reauth_total", { reason: event.data.status });
      logger.warn({
        message: "membership changed; closing socket for re-auth",
        workspace_id: event.data.workspace_id,
        status: event.data.status,
      });
      socket?.emit("error", { close_code: ROOM_FORBIDDEN_CLOSE_CODE, reason: "membership_changed" });
      socket?.disconnect(true);
      this.forget(socketId);
    }
  }

  private socketById(socketId: string): Socket | undefined {
    const sockets = (this.server as unknown as { sockets?: Map<string, Socket> } | undefined)?.sockets;
    return sockets?.get(socketId);
  }

  private forget(socketId: string): void {
    this.pressure.delete(socketId);
    this.joined.delete(socketId);
    const timer = this.revalidations.get(socketId);
    if (timer !== undefined) clearInterval(timer);
    this.revalidations.delete(socketId);
  }

  handleDisconnect(socket: Socket): void {
    this.forget(socket.id);
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
    this.joined.set(socket.id, { userId: decision.userId!, workspaceId });
    this.startRevalidation(socket, workspaceId);
    return { joined: true, room };
  }

  /**
   * The SECOND path that closes a revoked socket: a periodic re-check.
   *
   * `member.changed` closes it immediately, and this closes it eventually. Both
   * exist because they fail differently — a dropped control message, a gateway
   * that started after the event, a membership changed directly in the database
   * by an operator. Sixty seconds is the bound §7 puts on how long a revoked
   * session may persist, and this is what makes that bound true rather than
   * best-effort.
   */
  private startRevalidation(socket: Socket, workspaceId: string): void {
    if (this.revalidationMs <= 0) return;
    const timer = setInterval(() => {
      void this.rooms.authorizeWorkspaceRoom(socket.handshake, workspaceId).then((decision) => {
        if (decision.allowed) return;
        incrementCounter("nominara_gateway_forced_reauth_total", { reason: "revalidation" });
        socket.emit("error", { close_code: ROOM_FORBIDDEN_CLOSE_CODE, reason: "revalidation_failed" });
        socket.disconnect(true);
        this.forget(socket.id);
      });
    }, this.revalidationMs);
    // Never hold the process open for a periodic check.
    timer.unref?.();
    this.revalidations.set(socket.id, timer);
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
    await this.control?.quit();
    for (const timer of this.revalidations.values()) clearInterval(timer);
  }
}
