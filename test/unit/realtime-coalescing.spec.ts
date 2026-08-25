import { describe, expect, it, vi } from "vitest";
import { REALTIME_COALESCING_MS } from "../../contracts/events/event-name.schema.js";
import { Coalescer, type CoalescerTimers } from "../../src/gateway/coalescer.js";

// STORY-026 T20 row 5 / T22 — AC6. §11: `run.progress` is "≤ 1 / 750 ms / run".
//
// Driven through injected timers rather than by waiting, so the window is
// asserted at its exact boundary instead of approximately.

interface Harness {
  coalescer: Coalescer;
  emitted: { event: string; payload: unknown }[];
  clock: { ms: number };
  fireTimer: () => void;
  pendingTimers: number[];
}

function harness(): Harness {
  const emitted: { event: string; payload: unknown }[] = [];
  const clock = { ms: 1_000_000 };
  const pendingTimers: number[] = [];
  let handler: (() => void) | undefined;

  const timers: CoalescerTimers = {
    setTimeout: (fn, ms) => {
      handler = fn;
      pendingTimers.push(ms);
      return "t";
    },
    clearTimeout: () => undefined,
  };

  const coalescer = new Coalescer(
    (event, payload) => emitted.push({ event, payload }),
    () => clock.ms,
    timers,
  );
  return { coalescer, emitted, clock, fireTimer: () => handler?.(), pendingTimers };
}

describe("STORY-026 · run.progress is coalesced to §11's 750 ms per run", () => {
  it("uses the reference's number", () => {
    expect(REALTIME_COALESCING_MS["run.progress"]).toBe(750);
  });

  it("emits the first immediately", () => {
    const h = harness();
    h.coalescer.submit("run.progress", "run-1", { pct: 10 });
    expect(h.emitted).toHaveLength(1);
  });

  it("emits at most ONE per window however many arrive", () => {
    const h = harness();
    for (let pct = 0; pct < 50; pct++) {
      h.coalescer.submit("run.progress", "run-1", { pct });
      h.clock.ms += 5;
    }
    expect(h.emitted, "one leading emit; the rest are held, not sent").toHaveLength(1);
  });

  it("flushes the LATEST value at the end of the window, not the first one held", () => {
    // The reason this is a trailing throttle. A run that goes 10% -> 90% inside
    // one window must show 90% when the window closes; a leading-only throttle
    // would leave the client on 10% until the next window opened.
    const h = harness();
    h.coalescer.submit("run.progress", "run-1", { pct: 10 });
    h.coalescer.submit("run.progress", "run-1", { pct: 40 });
    h.coalescer.submit("run.progress", "run-1", { pct: 90 });

    h.fireTimer();

    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1]!.payload).toEqual({ pct: 90 });
  });

  it("schedules the flush for the REMAINDER of the window, not a fresh one", () => {
    const h = harness();
    h.coalescer.submit("run.progress", "run-1", { pct: 1 });
    h.clock.ms += 700;
    h.coalescer.submit("run.progress", "run-1", { pct: 2 });
    expect(h.pendingTimers).toEqual([50]);
  });

  it("emits again immediately once the window has elapsed", () => {
    const h = harness();
    h.coalescer.submit("run.progress", "run-1", { pct: 1 });
    h.clock.ms += 750;
    h.coalescer.submit("run.progress", "run-1", { pct: 2 });
    expect(h.emitted).toHaveLength(2);
  });

  it("holds at 749 ms — the boundary is not approximate", () => {
    const h = harness();
    h.coalescer.submit("run.progress", "run-1", { pct: 1 });
    h.clock.ms += 749;
    h.coalescer.submit("run.progress", "run-1", { pct: 2 });
    expect(h.emitted).toHaveLength(1);
  });
});

describe("STORY-026 · the budget is per key, not global", () => {
  it("does not coalesce two runs against each other", () => {
    // A shared budget would make one busy run silence another's progress
    // entirely — a correctness failure dressed as a performance optimisation.
    const h = harness();
    h.coalescer.submit("run.progress", "run-1", { pct: 1 });
    h.coalescer.submit("run.progress", "run-2", { pct: 1 });
    expect(h.emitted).toHaveLength(2);
  });

  it("does not coalesce two projects' findings against each other", () => {
    const h = harness();
    h.coalescer.submit("aux.finding_created", "project-1", { id: "a" });
    h.coalescer.submit("aux.finding_created", "project-2", { id: "b" });
    expect(h.emitted).toHaveLength(2);
  });

  it("does not coalesce a run's progress against the same run's completion", () => {
    const h = harness();
    h.coalescer.submit("run.progress", "run-1", { pct: 99 });
    h.coalescer.submit("run.completed", "run-1", { status: "completed" });
    expect(h.emitted).toHaveLength(2);
  });
});

describe("STORY-026 · an event §11 does not coalesce is never throttled", () => {
  it.each(["run.completed", "run.failed", "member.changed", "credits.debited"] as const)(
    "%s passes straight through",
    (event) => {
      const h = harness();
      for (let i = 0; i < 5; i++) h.coalescer.submit(event, "k", { i });
      expect(h.emitted, "giving an uncoalesced event a default window would throttle what §11 says must not be").toHaveLength(5);
    },
  );
});

describe("STORY-026 · discard", () => {
  it("clears held events so a flush cannot fire into a closed socket", () => {
    const h = harness();
    h.coalescer.submit("run.progress", "run-1", { pct: 1 });
    h.coalescer.submit("run.progress", "run-1", { pct: 2 });

    h.coalescer.discard();
    h.fireTimer();

    expect(h.emitted).toHaveLength(1);
  });

  it("clears the timer handle rather than leaving it to fire", () => {
    const cleared = vi.fn();
    const clock = { ms: 0 };
    const coalescer = new Coalescer(
      () => undefined,
      () => clock.ms,
      { setTimeout: () => "t", clearTimeout: cleared },
    );
    coalescer.submit("run.progress", "run-1", {});
    coalescer.submit("run.progress", "run-1", {});
    coalescer.discard();
    expect(cleared).toHaveBeenCalledTimes(1);
  });
});
