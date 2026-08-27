import { Inject, type OnApplicationShutdown, type OnModuleDestroy } from "@nestjs/common";
import { MessageBody, ConnectedSocket, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { Logger } from "@nestjs/common";
import { incrementCounter } from "../lib/telemetry/metrics.js";
import { RESYNC_DIRECTIVE, SocketBackpressure, drainReconnectAfterMs } from "./backpressure.js";
import { Coalescer } from "./coalescer.js";
import { REALTIME_DELIVERY_BUDGET, type BudgetedEventName } from "../../contracts/events/event-name.schema.js";
import type { RealtimeFanoutMessage } from "../lib/cache/realtime-publisher.js";
import {
  ROOM_FORBIDDEN_CLOSE_CODE,
  RoomAuthorizationService,
  projectRoom,
  workspaceRoom,
} from "./room-authorization.service.js";
import { Redis } from "ioredis";
import { memberChangedEventSchema } from "../../contracts/events/platform-events.schema.js";
import { attachValkeyAdapter, type ValkeyAdapterHandle } from "./valkey-adapter.js";
import { MembershipCacheService } from "../tenancy/membership-cache.js";

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

/** The message a client sends to join a project room — AC1's `proj:{project_id}`. */
export const JOIN_PROJECT_MESSAGE = "join:project";

// STORY-022 stood up the /rt namespace and the shutdown-drain notice.
// STORY-026 T21 adds room authorisation through the SAME guard chain the HTTP
// path uses (system-architecture.md §9), and nothing else: the Valkey adapter,
// coalescing, backpressure and the typed emitters are T22.
/**
 * The value this event's budget is counted per, read from its own payload.
 *
 * `undefined` means "spend no budget on this" — either §11 gives the event
 * none, or it gives it one and the payload is missing the field it is counted
 * per. Both go straight through: substituting a constant would put every run —
 * or every project — into ONE budget and coalesce them against each other,
 * losing one tenant's events to another's. Better one event too many than the
 * wrong client's.
 */
function budgetKeyFor(event: string, payload: unknown): string | undefined {
  const budget = REALTIME_DELIVERY_BUDGET[event as BudgetedEventName] as { keyField: string } | undefined;
  if (budget === undefined) return undefined;
  const value = (payload as Record<string, unknown> | null | undefined)?.[budget.keyField];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

@WebSocketGateway({ namespace: "/rt" })
export class RealtimeGateway implements OnModuleDestroy, OnApplicationShutdown {
  @WebSocketServer()
  server!: Server;

  private adapter: ValkeyAdapterHandle | undefined;
  private control: Redis | undefined;
  private fanout: Redis | undefined;
  private readonly pressure = new Map<string, SocketBackpressure>();

  /**
   * One coalescer per SOCKET, not one per gateway.
   *
   * §11's budget is a promise about what a client receives, so it has to be
   * counted where the client is. A single shared coalescer would let two
   * sockets' events consume one budget, so a busy workspace would starve a
   * quiet client of its own updates.
   */
  private readonly coalescers = new Map<string, Coalescer>();

  /** §11's per-project budgets, one per (socket, project) — keyed together so one project cannot spend another's. */
  private readonly projectBudgets = new Map<string, SocketBackpressure>();

  /**
   * Who is on each socket, recorded at join.
   *
   * Needed because a revocation names a USER and a WORKSPACE, and closing the
   * right sockets means knowing which ones those are. socket.io can find a
   * ROOM's members; it cannot answer "which of these is user X".
   */
  private readonly joined = new Map<string, { userId: string; workspaceId: string }>();

  /** Project rooms this socket holds, so the periodic re-check can re-authorise each. */
  private readonly joinedProjects = new Map<string, Set<string>>();
  private readonly revalidations = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly rooms: RoomAuthorizationService,
    /** §7's bound. Zero disables it, which is how row 3a proves the EVENT closes the socket rather than the timer. */
    @Inject(SOCKET_REVALIDATION_INTERVAL) private readonly revalidationMs: number = SOCKET_REVALIDATION_MS,
    /**
     * THIS process's membership cache — a different Map from the API's.
     *
     * `MembershipService` invalidates the API process's copy when it mutates a
     * membership. Nothing invalidates the gateway's, so without this the close
     * below manufactures the re-join it exists to prevent. Optional so the
     * existing two-argument construction in the unit suite keeps working.
     */
    private readonly memberships?: MembershipCacheService,
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
      socket.emit(RESYNC_DIRECTIVE, { reason: "rate_limited", scope: "socket", project_id: null });
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
  /**
   * Subscribes to the channel client events travel on, and delivers them
   * HERE rather than letting the adapter broadcast them.
   *
   * This is what makes AC6 and AC7 possible at all. `Adapter.broadcast`
   * encodes a packet once and writes it straight to every matching socket's
   * engine; its only per-socket hook, `notifyOutgoingListeners`, is
   * observational and cannot drop or delay anything. So a room broadcast can
   * honour neither §11's per-run coalescing nor §9's per-socket cap. Every
   * gateway instance receives every event on this channel and emits to its own
   * local sockets, which needs no sticky sessions — the actual requirement
   * behind "broadcast goes through the Valkey adapter" — and puts both budgets
   * where the socket is.
   */
  attachFanoutChannel(url: string, channel: string): void {
    const subscriber = new Redis(url, { maxRetriesPerRequest: 2 });
    this.fanout = subscriber;
    subscriber.on("error", (error: Error) => {
      logger.error({ message: "fanout channel error", error: error.name });
    });
    // Never an unhandled rejection: subscribing can fail while Valkey is still
    // coming up, and in a gateway process that is a crash rather than a
    // degraded subscription.
    subscriber.subscribe(channel).catch((error: unknown) => {
      logger.error({
        message: "fanout channel subscribe failed; this instance will deliver no client events",
        error: error instanceof Error ? error.name : "unknown",
      });
    });
    subscriber.on("message", (_channel: string, raw: string) => {
      this.deliverFanout(raw);
    });
  }

  /** Exposed for tests: delivers one fan-out message without a Valkey in the middle. */
  deliverFanout(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const message = parsed as Partial<RealtimeFanoutMessage>;
    if (typeof message.workspaceId !== "string" || typeof message.event !== "string") return;

    const room = workspaceRoom(message.workspaceId);
    // `@WebSocketServer()` on a NAMESPACED gateway injects the Namespace, not
    // the io Server — the same mismatch attachAdapter() works around at the
    // other end. `Namespace.sockets` is the Map of sockets connected to THIS
    // instance, which is exactly the set this instance is responsible for.
    const local = (this.server as unknown as { sockets: Map<string, Socket> }).sockets;
    for (const socket of local.values()) {
      // LOCAL sockets only. Every instance subscribes, so asking the adapter
      // for the room's cluster-wide membership would deliver each event once
      // per instance to every client.
      if (!socket.rooms.has(room)) continue;

      const key = budgetKeyFor(message.event, message.payload);
      const budget = REALTIME_DELIVERY_BUDGET[message.event as BudgetedEventName] as
        | { kind: "replace_latest" }
        | { kind: "rate_limit"; perSecond: number }
        | undefined;

      if (budget === undefined || key === undefined) {
        this.sendTo(socket, message.event, message.payload);
        continue;
      }

      if (budget.kind === "replace_latest") {
        // A client wants the CURRENT percentage, not every percentage —
        // superseded values are meant to be dropped.
        this.coalescerFor(socket).submit(message.event, key, message.payload);
        continue;
      }

      this.deliverRateLimited(socket, message.event, key, message.payload, budget.perSecond);
    }
  }

  /**
   * §11's "≤ 5 / s / project" — a real budget, not a throttle.
   *
   * These events carry DISTINCT ids: a finding, a task, a displacement. Under
   * the replace-latest throttle they used to share, twenty findings in a
   * second delivered about five and the client never learned of the other
   * fifteen — silently. Last-write-wins on a CREATION event is data loss
   * wearing a throttle's clothes. A per-second budget also permits the burst
   * §11 allows: "5 / s" means five at once, which 200 ms spacing never did.
   *
   * When the budget is spent the client is told ONCE, scoped to the project it
   * missed rows in, and the rest are dropped rather than queued. A backlog
   * would move the problem into this process's memory and eventually deliver a
   * flood of stale rows the client must apply in order.
   */
  private deliverRateLimited(
    socket: Socket,
    event: string,
    projectId: string,
    payload: unknown,
    perSecond: number,
  ): void {
    const slot = `${socket.id}:${projectId}`;
    let budget = this.projectBudgets.get(slot);
    if (budget === undefined) {
      budget = new SocketBackpressure(undefined, perSecond);
      this.projectBudgets.set(slot, budget);
    }

    const verdict = budget.admit();
    if (verdict.action === "send") {
      this.sendTo(socket, event, payload);
      return;
    }
    if (verdict.action === "resync") {
      incrementCounter("nominara_gateway_resync_directive_total", { event, scope: "project" });
      // Emitted DIRECTLY rather than through sendTo. A resync is one message
      // whose whole purpose is to survive the overload that provoked it;
      // spending it against §9's socket budget could see the one notice a
      // client needs dropped by the very cap it is reporting.
      socket.emit(RESYNC_DIRECTIVE, { reason: "rate_limited", scope: "project", project_id: projectId });
      return;
    }
    incrementCounter("nominara_gateway_dropped_events_total", { event, scope: "project" });
  }

  /** This socket's coalescer, whose emit is the backpressure-honouring send. */
  private coalescerFor(socket: Socket): Coalescer {
    let coalescer = this.coalescers.get(socket.id);
    if (coalescer === undefined) {
      coalescer = new Coalescer((event, payload) => {
        this.sendTo(socket, event, payload);
      });
      this.coalescers.set(socket.id, coalescer);
    }
    return coalescer;
  }

  attachControlChannel(url: string, channel: string): void {
    const subscriber = new Redis(url, { maxRetriesPerRequest: 2 });
    this.control = subscriber;
    subscriber.on("error", (error: Error) => {
      logger.error({ message: "control channel error", error: error.name });
    });
    // A rejection here must not become an unhandled one: the subscribe can
    // fail while Valkey is still coming up, and an unhandled rejection in a
    // gateway process is a crash rather than a degraded subscription.
    subscriber.subscribe(channel).catch((error: unknown) => {
      logger.error({
        message: "control channel subscribe failed; revocation falls back to the re-validation timer",
        error: error instanceof Error ? error.name : "unknown",
      });
    });
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

    // INVALIDATE BEFORE THE CLIENT COMES BACK, and note this runs whether or
    // not a socket was found — a gateway holding a stale entry but no socket
    // still authorises the next join from it.
    //
    // socket.io clients reconnect automatically by default. Closing the socket
    // without clearing this process's membership cache means the client is
    // back within about a second, `getLiveMembership` answers from a Map that
    // still says `active`, and the re-join succeeds — so the forced close
    // manufactured exactly the re-join it exists to prevent, and the real
    // revocation bound became the 30s cache TTL plus the 60s timer rather than
    // `security-and-tenancy.md` §7's sixty seconds. Reproduced by the
    // dangerous-area audit against a real socket and a real database; every
    // existing test missed it because they all set `reconnection: false`.
    this.memberships?.invalidate(event.data.user_id, event.data.workspace_id);
  }

  private socketById(socketId: string): Socket | undefined {
    const sockets = (this.server as unknown as { sockets?: Map<string, Socket> } | undefined)?.sockets;
    return sockets?.get(socketId);
  }

  private forget(socketId: string): void {
    this.pressure.delete(socketId);
    // Drop what is held BEFORE forgetting the socket: a scheduled flush would
    // otherwise fire into a closed connection.
    this.coalescers.get(socketId)?.discard();
    this.coalescers.delete(socketId);
    for (const slot of this.projectBudgets.keys()) {
      if (slot.startsWith(`${socketId}:`)) this.projectBudgets.delete(slot);
    }
    this.joined.delete(socketId);
    this.joinedProjects.delete(socketId);
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
      socket.emit("error", { close_code: decision.closeCode ?? ROOM_FORBIDDEN_CLOSE_CODE, reason: null });
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
   * Joins `proj:{project_id}` — AC1's second room form.
   *
   * Refuses the same way `join:workspace` does, and for the same reason: a
   * socket asking for a room it cannot have is disconnected rather than told
   * no, so a refusal cannot be used to enumerate project ids.
   *
   * This is the join that makes `workspace_members.project_scope` mean
   * something on the realtime path. `project:read` is scoped for manager and
   * viewer in §6's matrix, so RbacGuard's `assertInScope` runs here and
   * refuses a project outside the caller's own scope list.
   */
  @SubscribeMessage(JOIN_PROJECT_MESSAGE)
  async joinProject(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { project_id?: unknown },
  ): Promise<{ joined: boolean; room?: string }> {
    const projectId = typeof body?.project_id === "string" ? body.project_id : "";
    if (projectId.length === 0) {
      socket.disconnect(true);
      return { joined: false };
    }

    const decision = await this.rooms.authorizeProjectRoom(socket.handshake, projectId);
    if (!decision.allowed) {
      socket.emit("error", { close_code: decision.closeCode ?? ROOM_FORBIDDEN_CLOSE_CODE, reason: null });
      socket.disconnect(true);
      return { joined: false };
    }

    const room = projectRoom(projectId);
    await socket.join(room);
    // Recorded so the periodic re-check below can re-authorise it. A scope
    // NARROWED after the join is the same class of revocation as a membership
    // removed after one, and the workspace re-check cannot see it.
    const rooms = this.joinedProjects.get(socket.id) ?? new Set<string>();
    rooms.add(projectId);
    this.joinedProjects.set(socket.id, rooms);
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
    // One interval per socket, always. `revalidations` is keyed by socket id,
    // so setting a second handle over the first ORPHANS it: `forget()` can
    // only ever clear the last one, and `onModuleDestroy` iterates the same
    // Map. Every orphan then runs the whole guard chain — a session read, a
    // workspace-status read, a membership read — once a minute for the life of
    // the process, and it outlives the socket that created it. `join:workspace`
    // is a client-controlled message with no arrival limit, so a client that
    // re-joins on every route change (or in a loop) leaves permanent
    // per-minute database load behind it. Found in the STORY-026 review.
    const running = this.revalidations.get(socket.id);
    if (running !== undefined) clearInterval(running);
    const timer = setInterval(() => {
      void this.revalidate(socket, workspaceId);
    }, this.revalidationMs);
    // Never hold the process open for a periodic check.
    timer.unref?.();
    this.revalidations.set(socket.id, timer);
  }

  /**
   * One re-check: the workspace room, then every project room this socket
   * holds.
   *
   * The project half is not decoration. A membership REVOKED after the join
   * is caught by the workspace check; a `project_scope` NARROWED after the
   * join is not — the member is still active in the workspace, so that check
   * passes while the socket keeps receiving a project it no longer has. Both
   * are the same class of change and §7 bounds both the same way.
   */
  private async revalidate(socket: Socket, workspaceId: string): Promise<void> {
    const close = (reason: string): void => {
      incrementCounter("nominara_gateway_forced_reauth_total", { reason });
      socket.emit("error", { close_code: ROOM_FORBIDDEN_CLOSE_CODE, reason });
      socket.disconnect(true);
      this.forget(socket.id);
    };

    const workspace = await this.rooms.authorizeWorkspaceRoom(socket.handshake, workspaceId);
    if (!workspace.allowed) {
      close("revalidation_failed");
      return;
    }

    for (const projectId of this.joinedProjects.get(socket.id) ?? []) {
      const project = await this.rooms.authorizeProjectRoom(socket.handshake, projectId);
      if (!project.allowed) {
        close("project_scope_revalidation_failed");
        return;
      }
    }
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
    this.control?.disconnect();
    for (const timer of this.revalidations.values()) clearInterval(timer);
  }

  /**
   * Quits the adapter's two Valkey connections. An unclosed subscriber keeps
   * the process alive and turns a graceful drain into a hung one.
   *
   * DELIBERATELY NOT `onModuleDestroy`, and the ordering is the whole point.
   * Nest runs `onModuleDestroy` -> `beforeApplicationShutdown` -> CLOSE THE
   * SERVER -> `onApplicationShutdown`, and closing the server is what makes
   * socket.io call `RedisAdapter.close()` on every namespace. That method
   * issues `subClient.punsubscribe(...)` and `subClient.unsubscribe([...])`
   * and does not catch the promises ioredis returns
   * (`@socket.io/redis-adapter@8.3.0` dist/index.js:679-698). Quitting the
   * clients in `onModuleDestroy` therefore closed them BEFORE the unsubscribes
   * were issued, and every one of those uncaught promises rejected with
   * "Connection is closed" as an UNHANDLED REJECTION.
   *
   * That was previously recorded in this repository as unavoidable
   * library-internal teardown noise. It was neither: it was a lifecycle
   * ordering bug on this side, and it made `pnpm test:integration` exit 1 with
   * 573 of 573 tests passing — a gate command that always failed, which is
   * strictly worse than a loud one. Unsubscribing first, on connections that
   * are still open, leaves nothing to reject.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.adapter?.close();
  }
}
