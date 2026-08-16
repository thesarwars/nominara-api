import type { OnModuleDestroy } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server } from "socket.io";

// The event name clients listen for during a rolling deploy — a plain
// string constant, not hardcoded inline at each use site.
export const SERVER_DRAINING_EVENT = "server.draining";

// STORY-022 — src/gateway/ (project-structure.md §2: "socket.io namespace,
// room authorisation, event emitters"). Room authorisation and per-channel
// event emitters belong to the realtime layer's own future story
// (system-architecture.md §9) — this story only stands up the /rt
// namespace and the NFR-ARCH-07 shutdown-drain notice.
@WebSocketGateway({ namespace: "/rt" })
export class RealtimeGateway implements OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  // NFR-ARCH-07 — zero-downtime deploys: "WebSocket clients receive
  // server.draining and reconnect with jitter." Emitted to every connected
  // client in the /rt namespace as this module tears down, ahead of the
  // process actually exiting (src/gateway.ts calls enableShutdownHooks()).
  onModuleDestroy(): void {
    this.server?.emit(SERVER_DRAINING_EVENT);
  }
}
