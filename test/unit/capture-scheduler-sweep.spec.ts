import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulerSweepRuntime, nextSweepAfter, sweepIdempotencyKey } from "../../src/lib/capture/scheduler-sweep.js";

// NEW-A-13 — the sweep's clock and its dedup identity, with no database.

describe("NEW-A-13 · the sweep fires hourly at :05 UTC", () => {
  it("NEW-A-13 AC4 · nextSweepAfter returns the next :05 UTC strictly after now", () => {
    const at = (iso: string) => nextSweepAfter(new Date(iso)).toISOString();
    expect(at("2026-10-08T10:00:00.000Z")).toBe("2026-10-08T10:05:00.000Z");
    expect(at("2026-10-08T10:04:59.999Z")).toBe("2026-10-08T10:05:00.000Z");
    // Exactly on the boundary the NEXT one is returned, never now: a tick that
    // fires and re-arms on :05:00.000 must not re-arm for the same instant.
    expect(at("2026-10-08T10:05:00.000Z")).toBe("2026-10-08T11:05:00.000Z");
    expect(at("2026-10-08T10:05:00.001Z")).toBe("2026-10-08T11:05:00.000Z");
    expect(at("2026-10-08T23:59:59.000Z")).toBe("2026-10-09T00:05:00.000Z");
    expect(at("2026-12-31T23:30:00.000Z")).toBe("2027-01-01T00:05:00.000Z");
  });

  it("NEW-A-13 AC4 · the schedule is UTC whatever the process time zone", () => {
    const original = process.env.TZ;
    process.env.TZ = "Asia/Kolkata"; // +05:30: a local-time implementation would answer :05 local = :35 UTC
    try {
      expect(nextSweepAfter(new Date("2026-10-08T10:00:00.000Z")).toISOString()).toBe("2026-10-08T10:05:00.000Z");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("NEW-A-13 · dedup key", () => {
  it("NEW-A-13 AC2 · the key is run:{project}:{next_run_at} and changes when next_run_at does", () => {
    const at = new Date("2026-10-08T10:00:00.000Z");
    expect(sweepIdempotencyKey("p1", at)).toBe("run:p1:2026-10-08T10:00:00.000Z");
    expect(sweepIdempotencyKey("p1", at)).toBe(sweepIdempotencyKey("p1", new Date(at)));
    expect(sweepIdempotencyKey("p1", at)).not.toBe(sweepIdempotencyKey("p1", new Date(at.getTime() + 1)));
    expect(sweepIdempotencyKey("p1", at)).not.toBe(sweepIdempotencyKey("p2", at));
  });
});

describe("NEW-A-13 · the in-process runtime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function runtimeAt(iso: string) {
    vi.setSystemTime(new Date(iso));
    const connects: string[] = [];
    const runtime = new SchedulerSweepRuntime({
      connect: async () => {
        connects.push(new Date().toISOString());
        throw new Error("no database in a unit test");
      },
      enqueue: async () => undefined,
    });
    return { runtime, connects };
  }

  it("NEW-A-13 AC1 · start() arms the next :05 UTC, ticks there, and re-arms for the following hour", async () => {
    const { runtime, connects } = runtimeAt("2026-10-08T10:00:00.000Z");
    runtime.start();
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_000);
    expect(connects).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connects).toEqual(["2026-10-08T10:05:00.000Z"]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(connects).toEqual(["2026-10-08T10:05:00.000Z", "2026-10-08T11:05:00.000Z"]);
    runtime.stop();
  });

  it("NEW-A-13 AC1 · stop() cancels the pending tick and start() twice arms only one", async () => {
    const { runtime, connects } = runtimeAt("2026-10-08T10:00:00.000Z");
    runtime.start();
    runtime.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(connects).toHaveLength(1);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(connects).toHaveLength(1);
  });

  it("NEW-A-13 AC1 · a tick that cannot reach the database is best-effort: it does not throw and the next hour still fires", async () => {
    const { runtime, connects } = runtimeAt("2026-10-08T10:00:00.000Z");
    await expect(runtime.tick()).resolves.toBeNull();
    runtime.start();
    await vi.advanceTimersByTimeAsync(65 * 60_000);
    expect(connects.length).toBeGreaterThanOrEqual(2); // the direct tick, then the :05 one
    runtime.stop();
  });
});
