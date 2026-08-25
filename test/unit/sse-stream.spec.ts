import { describe, expect, it, vi } from "vitest";
import {
  SSE_DEADLINE_MS,
  SSE_HEADERS,
  SSE_HEARTBEAT_MS,
  SseStream,
  type SseSink,
  type SseTimers,
} from "../../src/api/streaming/sse-stream.js";

// STORY-026 T20 row 7 / T23 — `NFR-API-09`: "Streaming endpoints heartbeat
// every 15 s and terminate at 60 s with a terminal event."
//
// Both numbers are asserted by DRIVING the timers rather than by waiting, which
// is the reason the helper takes them as a dependency. A test that waited sixty
// seconds to check the deadline is a test nobody runs.

interface Harness {
  stream: SseStream;
  written: string[];
  ended: () => number;
  fireHeartbeat: () => void;
  fireDeadline: () => void;
  intervals: number[];
  timeouts: number[];
  cleared: { intervals: number; timeouts: number };
}

function harness(options: { terminalEvent?: string } = {}): Harness {
  const written: string[] = [];
  let endCalls = 0;
  const sink: SseSink = {
    write: (chunk) => written.push(chunk),
    end: () => (endCalls += 1),
  };

  let heartbeatHandler: (() => void) | undefined;
  let deadlineHandler: (() => void) | undefined;
  const intervals: number[] = [];
  const timeouts: number[] = [];
  const cleared = { intervals: 0, timeouts: 0 };

  const timers: SseTimers = {
    setInterval: (handler, ms) => {
      heartbeatHandler = handler;
      intervals.push(ms);
      return "interval";
    },
    setTimeout: (handler, ms) => {
      deadlineHandler = handler;
      timeouts.push(ms);
      return "timeout";
    },
    clearInterval: () => {
      cleared.intervals += 1;
    },
    clearTimeout: () => {
      cleared.timeouts += 1;
    },
  };

  const stream = new SseStream(sink, { terminalEvent: options.terminalEvent ?? "scan.completed", timers });
  return {
    stream,
    written,
    ended: () => endCalls,
    fireHeartbeat: () => heartbeatHandler?.(),
    fireDeadline: () => deadlineHandler?.(),
    intervals,
    timeouts,
    cleared,
  };
}

describe("STORY-026 · NFR-API-09's two numbers", () => {
  it("heartbeats every 15 seconds", () => {
    const h = harness();
    h.stream.open();
    expect(h.intervals).toEqual([SSE_HEARTBEAT_MS]);
    expect(SSE_HEARTBEAT_MS).toBe(15_000);
  });

  it("deadlines at 60 seconds", () => {
    const h = harness();
    h.stream.open();
    expect(h.timeouts).toEqual([SSE_DEADLINE_MS]);
    expect(SSE_DEADLINE_MS).toBe(60_000);
  });
});

describe("STORY-026 · the heartbeat", () => {
  it("writes a COMMENT, not a named event", () => {
    // A named `heartbeat` event reaches application code that must know to
    // ignore it, and any client that did not would render a message it cannot
    // interpret. A comment keeps the connection alive below that layer.
    const h = harness();
    h.stream.open();
    h.fireHeartbeat();
    expect(h.written).toEqual([": ping\n\n"]);
    expect(h.written[0]).not.toContain("event:");
  });

  it("stops once the stream is closed", () => {
    const h = harness();
    h.stream.open();
    h.stream.close();
    h.fireHeartbeat();
    expect(h.written.filter((chunk) => chunk.startsWith(": ping"))).toHaveLength(0);
  });
});

describe("STORY-026 · the deadline", () => {
  it("sends a TERMINAL EVENT before closing, so a client can tell 'done' from 'dropped'", () => {
    // A stream that simply stopped is indistinguishable from a broken
    // connection. The first calls for showing a result; the second for
    // reconnecting. They must not look the same.
    const h = harness({ terminalEvent: "scan.completed" });
    h.stream.open();
    h.fireDeadline();

    expect(h.written.at(-1)).toContain("event: scan.completed");
    expect(h.written.at(-1)).toContain('"reason":"deadline_reached"');
    expect(h.ended()).toBe(1);
  });

  it("clears both timers when it closes, so nothing keeps the process alive", () => {
    const h = harness();
    h.stream.open();
    h.fireDeadline();
    expect(h.cleared).toEqual({ intervals: 1, timeouts: 1 });
  });
});

describe("STORY-026 · frames", () => {
  it("writes a well-formed event frame terminated by a blank line", () => {
    const h = harness();
    h.stream.open();
    h.stream.send("scan.engine_result", { engine: "perplexity", sov: 0.31 });
    expect(h.written.at(-1)).toBe('event: scan.engine_result\ndata: {"engine":"perplexity","sov":0.31}\n\n');
  });

  it("cannot be split by a payload containing a newline", () => {
    // JSON.stringify escapes a newline to \\n, so one `data:` line is always
    // enough and payload content can never terminate the frame early.
    const h = harness();
    h.stream.open();
    h.stream.send("scan.engine_result", { excerpt: "line one\nline two" });
    const frame = h.written.at(-1)!;
    expect(frame.split("\n\n")).toHaveLength(2);
    expect(frame).toContain("line one\\nline two");
  });

  it("ignores a send after close rather than throwing", () => {
    // A producer racing the deadline is normal. Turning that race into an
    // exception would make a correct stream fail at the moment it ended
    // correctly.
    const h = harness();
    h.stream.open();
    h.stream.close();
    expect(() => {
      h.stream.send("late", {});
    }).not.toThrow();
    expect(h.written).toHaveLength(0);
  });

  it("closes only once, however many times close is called", () => {
    const h = harness();
    h.stream.open();
    h.stream.close();
    h.stream.close();
    h.fireDeadline();
    expect(h.ended()).toBe(1);
    expect(h.stream.isClosed).toBe(true);
  });
});

describe("STORY-026 · the response headers", () => {
  it("declares the event-stream type and disables buffering", () => {
    expect(SSE_HEADERS["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(SSE_HEADERS["cache-control"]).toContain("no-transform");
    // A buffering proxy holds the whole stream until it ends, which turns a
    // live stream into a slow single response and defeats the heartbeat
    // entirely.
    expect(SSE_HEADERS["x-accel-buffering"]).toBe("no");
  });
});

describe("STORY-026 · the helper does not reach for real timers when given fakes", () => {
  it("never touches the global clock", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const h = harness();
    h.stream.open();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
