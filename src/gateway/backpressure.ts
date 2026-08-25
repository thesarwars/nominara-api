// STORY-026 T22 — AC7: a slow client is capped, told to resync, and never
// given a backlog.
//
// system-architecture.md §9's shape: at most 20 messages per second to one
// socket; beyond that the socket is sent ONE `resync` directive and further
// messages are DROPPED rather than queued.
//
// DROPPED, not buffered, and that is the requirement rather than a shortcut.
// Buffering a slow consumer moves the problem into the server's memory and
// makes it everyone's: the gateway holds a growing queue per struggling
// socket, and when the client eventually reads, it receives a flood of stale
// state it must apply in order. `resync` says "refetch, you have missed
// things" — one message that costs the client one query and costs the gateway
// nothing. A backlog is the failure mode this exists to prevent, so this
// module holds no queue at all.

/** system-architecture.md §9 — at most this many messages to one socket per second. */
export const SOCKET_MESSAGE_CAP_PER_SECOND = 20;

/** The directive a throttled client receives, once per overload episode. */
export const RESYNC_DIRECTIVE = "resync";

export type BackpressureVerdict =
  /** Send it. */
  | { readonly action: "send" }
  /** Send the resync directive instead — the first drop of this episode. */
  | { readonly action: "resync" }
  /** Drop it silently: the client has already been told, and telling it again is more traffic for a socket that cannot keep up. */
  | { readonly action: "drop" };

/**
 * One socket's send budget.
 *
 * A fixed one-second window rather than a token bucket, because §9 states a
 * flat per-second cap and nothing about burst here. Using the token bucket
 * from the rate-limit module would import a `burst` concept the reference does
 * not give this surface.
 */
export class SocketBackpressure {
  private windowStartMs: number;
  private sentInWindow = 0;
  private resyncSentThisEpisode = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly capPerSecond: number = SOCKET_MESSAGE_CAP_PER_SECOND,
  ) {
    this.windowStartMs = this.now();
  }

  /** Decides what to do with one outbound message. Call once per message, and honour the answer. */
  admit(): BackpressureVerdict {
    const now = this.now();
    if (now - this.windowStartMs >= 1_000) {
      this.windowStartMs = now;
      this.sentInWindow = 0;
      // A NEW EPISODE. The client got through a whole second inside its
      // budget, so if it falls behind again that is new information and
      // deserves a fresh directive. Latching the flag forever would tell a
      // client once, in its first bad second, and never again.
      this.resyncSentThisEpisode = false;
    }

    if (this.sentInWindow < this.capPerSecond) {
      this.sentInWindow += 1;
      return { action: "send" };
    }

    if (!this.resyncSentThisEpisode) {
      this.resyncSentThisEpisode = true;
      // The directive itself counts against nothing: it is the one message a
      // saturated socket most needs, and charging it to the budget would mean
      // the client that most needs it is the one that cannot receive it.
      return { action: "resync" };
    }

    return { action: "drop" };
  }

  /** For assertions and logging — never used to make a decision. */
  get sentThisWindow(): number {
    return this.sentInWindow;
  }
}

/**
 * `server.draining`'s reconnect delay, jittered per socket.
 *
 * `NFR-ARCH-07`: clients "reconnect with jitter". Without it every client
 * reconnects at the same instant after a deploy — a thundering herd against a
 * gateway that has just lost capacity, which turns a rolling deploy into an
 * outage. The jitter is applied HERE, per socket, rather than being left to
 * clients: a client that ignored the advice would be indistinguishable from
 * one that never received it.
 */
export const DRAIN_RECONNECT_BASE_MS = 1_000;
export const DRAIN_RECONNECT_JITTER_MS = 4_000;

export function drainReconnectAfterMs(random: () => number = Math.random): number {
  return DRAIN_RECONNECT_BASE_MS + Math.floor(random() * DRAIN_RECONNECT_JITTER_MS);
}
