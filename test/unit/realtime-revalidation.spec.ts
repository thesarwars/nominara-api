import { describe, expect, it, vi } from "vitest";
import { RealtimeGateway, SOCKET_REVALIDATION_MS } from "../../src/gateway/realtime.gateway.js";
import { ROOM_FORBIDDEN_CLOSE_CODE } from "../../src/gateway/room-authorization.service.js";

// STORY-026 T20 rows 3a and 3b — SPLIT DELIBERATELY.
//
// The story's own wording is "closes on the next re-validation OR on the change
// event", which a single test could satisfy by exercising the timer alone —
// leaving untested the path that shortens the revocation window from sixty
// seconds to immediate. That path is the one that matters: sixty seconds is a
// long time to keep serving a removed member.
//
// So row 3a runs with the timer DISABLED, which is why the interval is a
// constructor argument. If the event path regresses, this file goes red rather
// than passing a second later on the timer.

const WS = "0192f1a0-0000-7000-8000-00000000000a";
const USER = "0192f1a0-0000-7000-8000-0000000000ff";

function socketStub(id: string): { id: string; emit: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; handshake: unknown } {
  return { id, emit: vi.fn(), disconnect: vi.fn(), handshake: { headers: {} } };
}

/** A gateway with a joined socket, and the timer off unless a test asks for it. */
function gatewayWithJoinedSocket(revalidationMs = 0): {
  gateway: RealtimeGateway;
  socket: ReturnType<typeof socketStub>;
} {
  const socket = socketStub("sock-1");
  const gateway = new RealtimeGateway({} as never, revalidationMs);
  (gateway as unknown as { server: unknown }).server = { sockets: new Map([[socket.id, socket]]) };
  (gateway as unknown as { joined: Map<string, unknown> }).joined.set(socket.id, {
    userId: USER,
    workspaceId: WS,
  });
  return { gateway, socket };
}

const changed = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({ workspace_id: WS, user_id: USER, role: "analyst", status: "removed", ...patch });

describe("STORY-026 · row 3a — the socket closes ON THE EVENT, with no timer running", () => {
  it("disconnects a removed member immediately", () => {
    const { gateway, socket } = gatewayWithJoinedSocket(0);
    gateway.onMemberChanged(changed());

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.emit).toHaveBeenCalledWith("error", {
      close_code: ROOM_FORBIDDEN_CLOSE_CODE,
      reason: "membership_changed",
    });
  });

  it("closes on a ROLE CHANGE too, not only a removal", () => {
    // A demotion leaves an already-authorised socket over-privileged for
    // whatever it was authorised to see. Re-authorising costs one handshake;
    // getting "which changes matter" wrong costs a leak.
    const { gateway, socket } = gatewayWithJoinedSocket(0);
    gateway.onMemberChanged(changed({ status: "active", role: "viewer" }));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("leaves OTHER users' sockets alone", () => {
    const { gateway, socket } = gatewayWithJoinedSocket(0);
    gateway.onMemberChanged(changed({ user_id: "0192f1a0-0000-7000-8000-0000000000ee" }));
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("leaves the same user's sockets in OTHER workspaces alone", () => {
    // One human can hold sockets in several workspaces. Being removed from one
    // says nothing about the others, and closing them all would make a routine
    // membership change look like an outage.
    const { gateway, socket } = gatewayWithJoinedSocket(0);
    gateway.onMemberChanged(changed({ workspace_id: "0192f1a0-0000-7000-8000-00000000000b" }));
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("forgets the socket, so a later event cannot act on it twice", () => {
    const { gateway, socket } = gatewayWithJoinedSocket(0);
    gateway.onMemberChanged(changed());
    socket.disconnect.mockClear();
    gateway.onMemberChanged(changed());
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("ignores a malformed control message rather than throwing on the subscriber", () => {
    // A throw here would take down the subscription for every socket on this
    // process, so one bad message would silently disable revocation for all of
    // them.
    const { gateway, socket } = gatewayWithJoinedSocket(0);
    expect(() => {
      gateway.onMemberChanged("not json");
    }).not.toThrow();
    expect(() => {
      gateway.onMemberChanged(JSON.stringify({ workspace_id: WS }));
    }).not.toThrow();
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

describe("STORY-026 · row 3b — the timer is the second path, and it is bounded by §7", () => {
  it("re-validates at security-and-tenancy.md §7's sixty seconds", () => {
    expect(SOCKET_REVALIDATION_MS).toBe(60_000);
  });

  it("closes a socket whose authorisation has stopped holding", async () => {
    // The event path and the timer fail differently — a dropped control
    // message, a gateway that started after the event, a membership changed
    // directly in the database. Neither alone makes §7's bound true.
    vi.useFakeTimers();
    try {
      const socket = socketStub("sock-1");
      const rooms = { authorizeWorkspaceRoom: vi.fn().mockResolvedValue({ allowed: false }) };
      const gateway = new RealtimeGateway(rooms as never, 60_000);
      (gateway as unknown as { server: unknown }).server = { sockets: new Map([[socket.id, socket]]) };

      (gateway as unknown as { startRevalidation: (s: unknown, w: string) => void }).startRevalidation(socket, WS);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(rooms.authorizeWorkspaceRoom).toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a still-authorised socket connected", async () => {
    vi.useFakeTimers();
    try {
      const socket = socketStub("sock-1");
      const rooms = { authorizeWorkspaceRoom: vi.fn().mockResolvedValue({ allowed: true, userId: USER }) };
      const gateway = new RealtimeGateway(rooms as never, 60_000);
      (gateway as unknown as { server: unknown }).server = { sockets: new Map([[socket.id, socket]]) };

      (gateway as unknown as { startRevalidation: (s: unknown, w: string) => void }).startRevalidation(socket, WS);
      await vi.advanceTimersByTimeAsync(180_000);

      expect(socket.disconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no timer at all when the interval is disabled", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const { gateway } = gatewayWithJoinedSocket(0);
    (gateway as unknown as { startRevalidation: (s: unknown, w: string) => void }).startRevalidation(
      socketStub("s"),
      WS,
    );
    expect(spy, "row 3a's assertions must not be able to ride on a timer").not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
