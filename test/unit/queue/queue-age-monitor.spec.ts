import { describe, expect, it, vi } from "vitest";
import {
  INTERACTIVE_QUEUES,
  OLDEST_JOB_AGE_METRIC,
  oldestWaitingAgeSeconds,
  queueAgeReader,
} from "../../../src/lib/queue/queue-age-monitor.js";
import { QUEUE_TOPOLOGY } from "../../../src/lib/queue/topology.js";

// STORY-030 AC8 — the oldest-waiting-job-age signal for the interactive queue(s). The fake queue answers
// getWaiting/getPrioritized with the job AT THE HEAD of each structure, which is how BullMQ returns them for asc reads.

const job = (timestamp: number) => ({ timestamp });
function fakeQueue(waiting: number[], prioritized: number[] = []) {
  return {
    getWaiting: vi.fn(async (start = 0, end = -1) => waiting.slice(start, end === -1 ? undefined : end + 1).map(job)),
    getPrioritized: vi.fn(async (start = 0, end = -1) => prioritized.slice(start, end === -1 ? undefined : end + 1).map(job)),
  };
}

describe("STORY-030 AC8 · oldestWaitingAgeSeconds", () => {
  it("is the age of the head of the waiting list, in seconds", async () => {
    expect(await oldestWaitingAgeSeconds(fakeQueue([90_000, 99_000]) as never, 100_000)).toBe(10);
  });

  it("takes the older of the waiting head and the prioritized head", async () => {
    expect(await oldestWaitingAgeSeconds(fakeQueue([95_000], [80_000]) as never, 100_000)).toBe(20);
    expect(await oldestWaitingAgeSeconds(fakeQueue([70_000], [80_000]) as never, 100_000)).toBe(30);
  });

  it("an empty queue is null, never 0: 'nothing is waiting' is not 'a job waited 0 seconds'", async () => {
    expect(await oldestWaitingAgeSeconds(fakeQueue([], []) as never, 100_000)).toBeNull();
  });

  it("a job enqueued this very millisecond is 0, which stays distinct from null", async () => {
    expect(await oldestWaitingAgeSeconds(fakeQueue([100_000]) as never, 100_000)).toBe(0);
  });

  it("a timestamp ahead of the local clock (skew) clamps to 0 rather than going negative", async () => {
    expect(await oldestWaitingAgeSeconds(fakeQueue([100_500]) as never, 100_000)).toBe(0);
  });

  it("reads only the head of each structure, never the whole backlog", async () => {
    const q = fakeQueue([1, 2, 3], [4, 5]);
    await oldestWaitingAgeSeconds(q as never, 10);
    expect(q.getWaiting).toHaveBeenCalledWith(0, 0);
    expect(q.getPrioritized).toHaveBeenCalledWith(0, 0);
  });
});

describe("STORY-030 AC8 · which queues, and the metric name", () => {
  it("lookup.execute (the dedicated interactive pool, system-architecture.md section 4) is interactive, and every name is a real queue", () => {
    expect(INTERACTIVE_QUEUES).toContain("lookup.execute");
    const known = new Set(QUEUE_TOPOLOGY.map((entry) => entry.name));
    for (const name of INTERACTIVE_QUEUES) expect(known.has(name)).toBe(true);
  });

  it("the metric follows nominara_<subsystem>_<measure> with the unit in the name", () => {
    expect(OLDEST_JOB_AGE_METRIC).toBe("nominara_queue_oldest_job_age_seconds");
  });
});

describe("STORY-030 AC8 · queueAgeReader", () => {
  it("reads each interactive queue, and leaves out one it cannot read rather than reporting it empty", async () => {
    const good = fakeQueue([90_000]);
    const bad = { getWaiting: vi.fn(async () => { throw new Error("valkey down"); }), getPrioritized: vi.fn(async () => []) };
    const reader = queueAgeReader(new Map([["lookup.execute", good], ["other", bad]]) as never, () => 100_000);
    const ages = await reader();
    expect(ages.get("lookup.execute")).toBe(10);
    expect(ages.has("other")).toBe(false);
  });
});
