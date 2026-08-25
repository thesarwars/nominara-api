// STORY-026 T23 — the server-sent-events helper.
//
// `NFR-API-09`: "Streaming endpoints heartbeat every 15 s and terminate at 60 s
// with a terminal event."
//
// Written against `reply.raw` rather than Nest's `@Sse()` observable binding,
// deliberately. Both work; only one makes the heartbeat and the deadline
// directly testable. `@Sse()` hides the timing inside Nest's own subscription
// management, and the two numbers above are the whole requirement — a helper
// whose central obligation can only be checked by waiting sixty seconds in a
// real test is a helper nobody checks.
//
// Only the helper ships in this epic. The Visibility Scan endpoint that uses
// it (api-specification.md §9) is STORY-079's.

/** The 15-second heartbeat of `NFR-API-09`. */
export const SSE_HEARTBEAT_MS = 15_000;

/** The 60-second deadline of `NFR-API-09`. */
export const SSE_DEADLINE_MS = 60_000;

/**
 * A comment line, which is what the specification means by a heartbeat.
 *
 * A comment rather than a named event because an EventSource client dispatches
 * named events to handlers: a `heartbeat` event would reach application code
 * that has to know to ignore it, and any client that did not would see a
 * message it cannot interpret. A comment keeps the connection alive through
 * proxies and is invisible above the transport, which is the entire job.
 */
const HEARTBEAT_FRAME = ": ping\n\n";

/** The minimum a writable must offer. Kept to this so a test needs no socket. */
export interface SseSink {
  write(chunk: string): unknown;
  end(): unknown;
}

export interface SseTimers {
  setInterval(handler: () => void, ms: number): unknown;
  setTimeout(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: SseTimers = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface SseStreamOptions {
  /** Emitted once when the deadline is reached, so a client always learns WHY the stream ended. */
  readonly terminalEvent: string;
  readonly heartbeatMs?: number;
  readonly deadlineMs?: number;
  readonly timers?: SseTimers;
}

/**
 * One server-sent-events stream.
 *
 * The deadline sends a TERMINAL EVENT and then closes. A stream that simply
 * stopped would be indistinguishable from a dropped connection, and a client
 * cannot tell "the server is done with you" from "the network failed" — the
 * first calls for showing a result, the second for reconnecting.
 */
export class SseStream {
  private readonly timers: SseTimers;
  private readonly options: Required<Omit<SseStreamOptions, "timers">>;
  private heartbeat: unknown;
  private deadline: unknown;
  private closed = false;

  constructor(
    private readonly sink: SseSink,
    options: SseStreamOptions,
  ) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.options = {
      terminalEvent: options.terminalEvent,
      heartbeatMs: options.heartbeatMs ?? SSE_HEARTBEAT_MS,
      deadlineMs: options.deadlineMs ?? SSE_DEADLINE_MS,
    };
  }

  /** Starts the heartbeat and the deadline. Headers are the caller's — they belong to the reply, not to this. */
  open(): void {
    this.heartbeat = this.timers.setInterval(() => {
      if (!this.closed) this.sink.write(HEARTBEAT_FRAME);
    }, this.options.heartbeatMs);

    this.deadline = this.timers.setTimeout(() => {
      this.send(this.options.terminalEvent, { reason: "deadline_reached", deadline_ms: this.options.deadlineMs });
      this.close();
    }, this.options.deadlineMs);
  }

  /**
   * Writes one named event.
   *
   * Silently ignored after close rather than throwing: a producer racing the
   * deadline is normal, and turning that race into an exception would make a
   * correct stream fail at the moment it ended correctly.
   */
  send(event: string, data: unknown): void {
    if (this.closed) return;
    // `JSON.stringify` can emit a newline inside a string only as `\n`, so one
    // `data:` line is always sufficient and the frame cannot be split by
    // payload content.
    this.sink.write(`event: ${event}\ndata: ${JSON.stringify(data) ?? "null"}\n\n`);
  }

  /** Idempotent — the deadline and an early client disconnect can both reach here. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.timers.clearInterval(this.heartbeat);
    this.timers.clearTimeout(this.deadline);
    this.sink.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** The headers a streaming response must carry, applied by the route before the first write. */
export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Proxies that buffer will hold the whole stream until it ends, which turns
  // a live stream into a slow single response and defeats the heartbeat.
  "x-accel-buffering": "no",
} as const;
