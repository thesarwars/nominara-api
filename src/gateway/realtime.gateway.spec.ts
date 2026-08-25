import { describe, expect, it, vi } from "vitest";
import { SERVER_DRAINING_EVENT, RealtimeGateway } from "./realtime.gateway.js";
import { DRAIN_RECONNECT_BASE_MS, DRAIN_RECONNECT_JITTER_MS } from "./backpressure.js";

// STORY-022 stood this up asserting a bare namespace-wide emit. STORY-026 T22
// changed the behaviour deliberately: `NFR-ARCH-07` says clients "reconnect
// with jitter", and a jittered delay has to be PER SOCKET — one namespace-wide
// emit necessarily carries one number, which is the thundering herd it exists
// to avoid.

function socketStub(): { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn() };
}

function gatewayWithSockets(count: number): {
  gateway: RealtimeGateway;
  sockets: { emit: ReturnType<typeof vi.fn> }[];
} {
  const sockets = Array.from({ length: count }, () => socketStub());
  const gateway = new RealtimeGateway({} as never);
  const map = new Map(sockets.map((socket, index) => [String(index), socket]));
  (gateway as unknown as { server: unknown }).server = { sockets: map };
  return { gateway, sockets };
}

describe("STORY-022/026 · server.draining on shutdown", () => {
  it("emits to EVERY connected socket", async () => {
    const { gateway, sockets } = gatewayWithSockets(3);
    await gateway.onModuleDestroy();
    for (const socket of sockets) {
      expect(socket.emit).toHaveBeenCalledWith(SERVER_DRAINING_EVENT, expect.anything());
    }
  });

  it("gives each socket its own reconnect delay, inside the documented window", async () => {
    const { gateway, sockets } = gatewayWithSockets(40);
    await gateway.onModuleDestroy();

    const delays = sockets.map(
      (socket) => (socket.emit.mock.calls[0]![1] as { reconnect_after_ms: number }).reconnect_after_ms,
    );
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(DRAIN_RECONNECT_BASE_MS);
      expect(delay).toBeLessThan(DRAIN_RECONNECT_BASE_MS + DRAIN_RECONNECT_JITTER_MS);
    }
    // The whole point: not one shared number.
    expect(new Set(delays).size, "every client reconnecting at once is the herd this avoids").toBeGreaterThan(1);
  });

  it("does not throw when no server was ever attached", async () => {
    const gateway = new RealtimeGateway({} as never);
    await expect(gateway.onModuleDestroy()).resolves.toBeUndefined();
  });
});
