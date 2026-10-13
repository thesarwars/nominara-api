import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthService } from "../../src/modules/health/health.service.js";

// STORY-121 AC 4 — "The health probe's own deadline stays. Removing either
// layer must turn a test red." The connection layer is pinned by
// queue-connection-roles.spec.ts; THIS pins the deadline layer on its own.
//
// A reader that fails fast on its own makes every integration test of
// queueDepths() pass with the deadline deleted (health-and-readiness.spec.ts
// does). So the read is injected here: a getJobCounts() that never settles,
// which is exactly the "future read finds a new way to block" the deadline
// exists for. Fake timers make "answers within the deadline" a measured
// property and make a missing deadline fail in milliseconds instead of
// hanging to the runner's timeout.

const DEADLINE_MS = 2_000; // QUEUE_DEPTH_READ_TIMEOUT_MS in health.service.ts

type FakeQueue = { getJobCounts: (...states: string[]) => Promise<Record<string, number>> };

function serviceWithQueues(queues: Record<string, FakeQueue>): { queueDepths: () => Promise<Array<{ name: string; depth: number }>> } {
  const service = new HealthService(
    undefined as never,
    undefined,
    undefined as never,
    undefined as never,
    undefined as never,
    "test-prefix",
    {} as never,
  );
  // queues() is the seam between the service and BullMQ; substituting it
  // injects the read without a Redis, so nothing else about queueDepths() is
  // replaced.
  vi.spyOn(service as unknown as { queues: () => unknown }, "queues").mockReturnValue(new Map(Object.entries(queues)));
  return service as unknown as { queueDepths: () => Promise<Array<{ name: string; depth: number }>> };
}

describe("STORY-121 AC 4 · HealthService.queueDepths() keeps its own deadline", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // setImmediate stays real: the unhandled-rejection test needs a genuine macrotask turn.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function settle<T>(promise: Promise<T>): Promise<{ settled: boolean; value?: T }> {
    let settled = false;
    let value: T | undefined;
    void promise.then((v) => {
      settled = true;
      value = v;
    });
    await vi.advanceTimersByTimeAsync(0);
    return { get settled() { return settled; }, get value() { return value; } } as { settled: boolean; value?: T };
  }

  it("STORY-121 AC4 · a never-settling queue read still lets the probe answer an empty list at the deadline, and logs it", async () => {
    const service = serviceWithQueues({ capture: { getJobCounts: () => new Promise(() => undefined) } });
    const outcome = await settle(service.queueDepths());

    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);

    expect(outcome.settled, "queueDepths() must answer once the deadline has passed").toBe(true);
    expect(outcome.value).toEqual([]);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0]![0])).toContain(`${DEADLINE_MS}ms`);
  });

  it("STORY-121 AC4 · it does not answer early: the deadline is the bound, not a shortcut around a slow-but-healthy read", async () => {
    const service = serviceWithQueues({ capture: { getJobCounts: () => new Promise(() => undefined) } });
    const outcome = await settle(service.queueDepths());

    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);

    expect(outcome.settled).toBe(false);
  });

  it("STORY-121 AC4 · a read that settles inside the deadline returns its depth and arms no failure", async () => {
    const service = serviceWithQueues({
      capture: { getJobCounts: () => Promise.resolve({ waiting: 2, active: 1, prioritized: 4 }) },
    });
    const outcome = await settle(service.queueDepths());
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome.settled).toBe(true);
    expect(outcome.value).toEqual([{ name: "capture", depth: 7 }]);
    expect(errorLog).not.toHaveBeenCalled();
    expect(vi.getTimerCount(), "the deadline timer is cleared once the read wins").toBe(0);
  });

  it("STORY-121 AC4 · one stuck queue among healthy ones blanks the list rather than blocking the probe", async () => {
    const service = serviceWithQueues({
      capture: { getJobCounts: () => Promise.resolve({ waiting: 1 }) },
      parse: { getJobCounts: () => new Promise(() => undefined) },
    });
    const outcome = await settle(service.queueDepths());

    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);

    expect(outcome.settled).toBe(true);
    expect(outcome.value).toEqual([]);
  });

  it("STORY-121 AC4 · an abandoned read that rejects after the deadline raises no unhandled rejection", async () => {
    let rejectLate: (error: Error) => void = () => undefined;
    const service = serviceWithQueues({
      capture: { getJobCounts: () => new Promise((_resolve, reject) => { rejectLate = reject; }) },
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const outcome = await settle(service.queueDepths());
      await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
      expect(outcome.settled).toBe(true);

      rejectLate(new Error("connection finally closed"));
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
