import { describe, expect, it, vi } from "vitest";
import { RealtimeGateway, SERVER_DRAINING_EVENT } from "./realtime.gateway.js";

// STORY-022 — NFR-ARCH-07: "WebSocket clients receive server.draining ...
// on shutdown." The connection-drain window and client-side reconnect
// jitter are ECS/ALB-level behavior; this gateway's own responsibility,
// exercised here, is emitting the drain notice as the module tears down.
describe("STORY-022 · RealtimeGateway shutdown draining", () => {
  it("emits server.draining to the /rt namespace on module destroy", () => {
    const gateway = new RealtimeGateway();
    gateway.server = { emit: vi.fn() } as never;

    gateway.onModuleDestroy();

    expect(gateway.server.emit).toHaveBeenCalledWith(SERVER_DRAINING_EVENT);
  });

  it("does not throw when torn down before the server is attached", () => {
    const gateway = new RealtimeGateway();

    expect(() => gateway.onModuleDestroy()).not.toThrow();
  });
});
