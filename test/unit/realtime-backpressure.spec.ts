import { describe, expect, it } from "vitest";
import {
  DRAIN_RECONNECT_BASE_MS,
  DRAIN_RECONNECT_JITTER_MS,
  SOCKET_MESSAGE_CAP_PER_SECOND,
  SocketBackpressure,
  drainReconnectAfterMs,
} from "../../src/gateway/backpressure.js";

// STORY-026 T20 row 6 / T22 — AC7: "Overwhelm a slow client → 20 msg/s cap,
// one `resync` directive, NO BACKLOG."
//
// The no-backlog half is the one worth testing hardest, because it is the one
// an implementation drifts away from: buffering feels helpful, and it moves a
// slow consumer's problem into the server's memory where it becomes
// everyone's.

function at(clock: { ms: number }): SocketBackpressure {
  return new SocketBackpressure(() => clock.ms);
}

describe("STORY-026 · the per-socket cap", () => {
  it("is §9's twenty per second", () => {
    expect(SOCKET_MESSAGE_CAP_PER_SECOND).toBe(20);
  });

  it("admits exactly twenty inside one second", () => {
    const clock = { ms: 0 };
    const pressure = at(clock);
    const verdicts = Array.from({ length: 25 }, () => pressure.admit().action);
    expect(verdicts.filter((v) => v === "send")).toHaveLength(20);
  });

  it("sends the resync directive on the twenty-first, not the twentieth", () => {
    const clock = { ms: 0 };
    const pressure = at(clock);
    for (let i = 0; i < 20; i++) expect(pressure.admit().action).toBe("send");
    expect(pressure.admit().action).toBe("resync");
  });

  it("sends the directive ONCE per episode and drops the rest", () => {
    // Telling a saturated socket repeatedly is more traffic for a connection
    // that already cannot keep up.
    const clock = { ms: 0 };
    const pressure = at(clock);
    for (let i = 0; i < 20; i++) pressure.admit();

    const after = Array.from({ length: 50 }, () => pressure.admit().action);
    expect(after.filter((a) => a === "resync")).toHaveLength(1);
    expect(after.filter((a) => a === "drop")).toHaveLength(49);
  });

  it("HOLDS NO BACKLOG — a dropped message is gone, not queued", () => {
    // The property AC7 names explicitly. There is no queue in this module at
    // all; `resync` is what replaces one, and it costs the client one refetch
    // instead of costing the gateway unbounded memory per slow socket.
    const clock = { ms: 0 };
    const pressure = at(clock);
    for (let i = 0; i < 100; i++) pressure.admit();

    clock.ms += 1_000;
    // A fresh second gets the FULL budget, not one reduced by the eighty
    // messages that were dropped. The window resets lazily on the next admit,
    // which is why this is asserted through behaviour rather than by reading
    // the counter before anything has asked it a question.
    const next = Array.from({ length: 25 }, () => pressure.admit().action);
    expect(next.filter((a) => a === "send"), "a new window must not be pre-spent by a backlog").toHaveLength(20);
    expect(pressure.sentThisWindow).toBe(20);
  });
});

describe("STORY-026 · the window", () => {
  it("resets after a full second", () => {
    const clock = { ms: 0 };
    const pressure = at(clock);
    for (let i = 0; i < 20; i++) pressure.admit();
    expect(pressure.admit().action).toBe("resync");

    clock.ms += 1_000;
    expect(pressure.admit().action).toBe("send");
  });

  it("does not reset a millisecond early", () => {
    const clock = { ms: 0 };
    const pressure = at(clock);
    for (let i = 0; i < 21; i++) pressure.admit();

    clock.ms += 999;
    expect(pressure.admit().action).toBe("drop");
  });

  it("issues a NEW directive if the client falls behind again in a later second", () => {
    // Latching the flag forever would tell a client once, in its first bad
    // second, and never again — so a socket that recovered and then saturated
    // an hour later would silently lose messages.
    const clock = { ms: 0 };
    const pressure = at(clock);
    for (let i = 0; i < 21; i++) pressure.admit();

    clock.ms += 1_000;
    for (let i = 0; i < 20; i++) expect(pressure.admit().action).toBe("send");
    expect(pressure.admit().action).toBe("resync");
  });
});

describe("STORY-026 · server.draining reconnect jitter (AC9, NFR-ARCH-07)", () => {
  it("spreads reconnects across a window rather than returning a constant", () => {
    // Without jitter every client reconnects at the same instant after a
    // deploy — a thundering herd against a gateway that has just lost
    // capacity, which turns a rolling deploy into an outage.
    const values = new Set(Array.from({ length: 200 }, () => drainReconnectAfterMs()));
    expect(values.size).toBeGreaterThan(50);
  });

  it("stays inside the documented window at both extremes", () => {
    expect(drainReconnectAfterMs(() => 0)).toBe(DRAIN_RECONNECT_BASE_MS);
    expect(drainReconnectAfterMs(() => 0.999999)).toBeLessThan(DRAIN_RECONNECT_BASE_MS + DRAIN_RECONNECT_JITTER_MS);
  });

  it("never returns zero — an immediate reconnect is the herd it exists to avoid", () => {
    for (let i = 0; i < 100; i++) expect(drainReconnectAfterMs()).toBeGreaterThan(0);
  });

  it("is an integer, because it goes on the wire as milliseconds", () => {
    expect(Number.isInteger(drainReconnectAfterMs(() => 0.5))).toBe(true);
  });
});
