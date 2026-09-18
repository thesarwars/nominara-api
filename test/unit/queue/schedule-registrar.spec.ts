import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { reconcileSchedules, schedulerIdFor } from "../../../src/lib/queue/schedule-registrar.js";

// G12 — the registrar decides what actually ticks. Driven against a Queue
// double: what is asserted is which calls it makes, which is exactly the
// contract BullMQ holds it to.

function fakeQueue(existingKeys: string[] = []) {
  return {
    getJobSchedulers: vi.fn(async () => existingKeys.map((key) => ({ key }))),
    upsertJobScheduler: vi.fn(async () => undefined),
    removeJobScheduler: vi.fn(async () => true),
  };
}

const asQueue = (q: ReturnType<typeof fakeQueue>) => q as unknown as Queue;

describe("G12 · reconcileSchedules", () => {
  it("schedules a queue that has a cron AND a handler", async () => {
    const queue = fakeQueue();

    const result = await reconcileSchedules(new Map([["credit.reconcile", asQueue(queue)]]));

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      schedulerIdFor("credit.reconcile"),
      { pattern: "*/10 * * * *" },
      { name: "scheduled" },
    );
    expect(result.scheduled).toEqual([{ queue: "credit.reconcile", cron: "*/10 * * * *" }]);
  });

  it("⚠ REFUSES a queue whose handler is not wired, however clear its cron", async () => {
    // `capture.plan` has `5 * * * *` from §6.1 and no handler. A repeatable
    // here would fail every job down the retry ladder into the DLQ on a
    // timer — turning "not built yet" into "tried and failed" in the record
    // an operator reads during an incident. `src/worker.ts` makes the same
    // argument for the workers: inert is a better lie than broken.
    const queue = fakeQueue();

    const result = await reconcileSchedules(new Map([["capture.plan", asQueue(queue)]]));

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(result.scheduled).toEqual([]);
    expect(result.skippedInert).toEqual(["capture.plan"]);
  });

  it("⚠ schedules nothing for a queue whose cadence states no time", async () => {
    // `maintenance.partition` says "cron monthly" and no date. Scheduling it
    // would mean inventing one.
    const queue = fakeQueue();

    const result = await reconcileSchedules(new Map([["maintenance.partition", asQueue(queue)]]));

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(result.scheduled).toEqual([]);
    // And it is not reported as inert — the handler is not the reason.
    expect(result.skippedInert).toEqual([]);
  });

  it("⚠ REMOVES a scheduler that should no longer fire", async () => {
    // BullMQ job schedulers live in Redis, not in the source. Deleting a row
    // from the table leaves the old scheduler firing against a deployment
    // that no longer expects it, and nothing in the code would show it.
    const queue = fakeQueue(["cron:credit.reconcile", "cron:something-we-removed"]);

    const result = await reconcileSchedules(new Map([["credit.reconcile", asQueue(queue)]]));

    expect(queue.removeJobScheduler).toHaveBeenCalledExactlyOnceWith("cron:something-we-removed");
    expect(result.removed).toEqual(["credit.reconcile:cron:something-we-removed"]);
  });

  it("⚠ removes EVERY scheduler on a queue that has gone inert", async () => {
    // A handler being deleted must stop the timer, not leave it producing
    // jobs nothing can process.
    const queue = fakeQueue(["cron:capture.plan"]);

    await reconcileSchedules(new Map([["capture.plan", asQueue(queue)]]));

    expect(queue.removeJobScheduler).toHaveBeenCalledWith("cron:capture.plan");
  });

  it("leaves the wanted scheduler in place rather than churning it", async () => {
    const queue = fakeQueue(["cron:credit.reconcile"]);

    await reconcileSchedules(new Map([["credit.reconcile", asQueue(queue)]]));

    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
    // Still upserted — that is what makes two replicas converge on one.
    expect(queue.upsertJobScheduler).toHaveBeenCalledOnce();
  });

  it("⚠ touches only the queues it was given", async () => {
    // A worker group is one process and passes its own queues. If a group
    // could see another's, each boot would remove the other's schedulers and
    // the two would fight.
    const mine = fakeQueue();
    const result = await reconcileSchedules(new Map([["credit.reconcile", asQueue(mine)]]));

    expect(result.scheduled.map((s) => s.queue)).toEqual(["credit.reconcile"]);
    expect(result.removed).toEqual([]);
  });
});
