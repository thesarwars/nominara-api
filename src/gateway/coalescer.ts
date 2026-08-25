import {
  REALTIME_COALESCING_MS,
  type RealtimeEventName,
} from "../../contracts/events/event-name.schema.js";

// STORY-026 T22 — AC6: api-specification.md §11's coalescing column.
//
// A TRAILING throttle, not a leading one, and the difference is the whole
// design. Dropping everything inside the window emits the FIRST value and
// discards the rest — so a run that goes 10% → 90% inside 750 ms shows 10%,
// and the client sits on a stale number until the next window. What §11 wants
// is at most one event per window, and for that event to be the CURRENT state.
// So the first is emitted immediately and the latest is held and flushed at
// the window's end.
//
// The key differs by event and that is why REALTIME_COALESCING_MS is a table:
// `run.progress` is per RUN, the `≤ 5 / s` rows are per PROJECT, and
// `engine.degraded` is per ENGINE. One shared budget would coalesce two
// projects' findings against each other, which is a correctness failure
// dressed as a performance optimisation.

export interface CoalescerTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: CoalescerTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface Pending {
  payload: unknown;
  handle: unknown;
}

export type EmitFn = (event: RealtimeEventName, payload: unknown) => void;

export class Coalescer {
  private readonly lastEmittedAt = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly emit: EmitFn,
    private readonly now: () => number = () => Date.now(),
    private readonly timers: CoalescerTimers = REAL_TIMERS,
  ) {}

  /**
   * Submits an event. Emits now, or holds it as the pending latest.
   *
   * `coalesceKey` is what the budget is per — a run id, a project id, an engine
   * key. Passing the wrong one is a correctness bug rather than a tuning one,
   * so it is a required argument with no default.
   */
  submit(event: RealtimeEventName, coalesceKey: string, payload: unknown): void {
    const windowMs = REALTIME_COALESCING_MS[event as keyof typeof REALTIME_COALESCING_MS];
    if (windowMs === undefined) {
      // §11 marks most events uncoalesced. An event without a budget is
      // emitted as-is — never given a default window, which would throttle
      // something the reference says must not be.
      this.emit(event, payload);
      return;
    }

    const slot = `${event}:${coalesceKey}`;
    const last = this.lastEmittedAt.get(slot);
    const now = this.now();

    if (last === undefined || now - last >= windowMs) {
      // Cancel any flush still scheduled for this slot FIRST. The window has
      // passed, so a payload held for it is now older than the one in hand,
      // and a busy event loop can run this submit before an overdue timer
      // callback — emitting the newer value and then the stale one behind it.
      // The client sees progress run backwards, and two events land inside one
      // window against §11's cap of one.
      const stale = this.pending.get(slot);
      if (stale !== undefined) {
        this.timers.clearTimeout(stale.handle);
        this.pending.delete(slot);
      }
      this.lastEmittedAt.set(slot, now);
      this.emit(event, payload);
      return;
    }

    // Inside the window. Replace whatever was pending — the newest state is
    // the only one worth sending, and queueing them would turn coalescing into
    // a delay rather than a reduction.
    const existing = this.pending.get(slot);
    if (existing !== undefined) {
      existing.payload = payload;
      return;
    }

    const handle = this.timers.setTimeout(() => {
      const held = this.pending.get(slot);
      this.pending.delete(slot);
      if (held === undefined) return;
      this.lastEmittedAt.set(slot, this.now());
      this.emit(event, held.payload);
    }, windowMs - (now - last));

    this.pending.set(slot, { payload, handle });
  }

  /** Drops everything held. Called when a socket goes away, so a flush cannot fire into a closed connection. */
  discard(): void {
    for (const { handle } of this.pending.values()) this.timers.clearTimeout(handle);
    this.pending.clear();
    this.lastEmittedAt.clear();
  }
}
