import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { reconcileSchedules, schedulerIdFor } from "../../../src/lib/queue/schedule-registrar.js";

// G12 — the registrar decides what actually ticks. Driven against a Queue
// double: what is asserted is which calls it makes, which is exactly the
// contract BullMQ holds it to.
//
// ⚠ THE DOUBLE MUST BEHAVE LIKE THE REAL THING WHERE IT MATTERS, or the test
// cannot fail. `getJobSchedulers` here records its arguments, because BullMQ's
// takes `(start, end)` defaulting to the whole range — a mutation to
// `getJobSchedulers(0, 9)` would silently make stale-removal miss anything
// past the tenth scheduler, and a zero-arg double could never see it.

function fakeQueue(existingKeys: string[] = []) {
  return {
    getJobSchedulers: vi.fn(async (..._args: unknown[]) => existingKeys.map((key) => ({ key }))),
    upsertJobScheduler: vi.fn(async (_id: string, _repeat: unknown, _template?: unknown) => undefined),
    removeJobScheduler: vi.fn(async () => true),
  };
}

const asQueue = (q: ReturnType<typeof fakeQueue>) => q as unknown as Queue;

/** `credit.reconcile`'s topology row: priority 9, doubling(3) → 4 attempts, the global retention. */
const RECONCILE_OPTS = {
  priority: 9,
  attempts: 4,
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 604800 },
  backoff: { type: "custom" },
};

describe("G12 · reconcileSchedules", () => {
  it("schedules a queue that has a cron, a handler, and is not tenant-scoped", async () => {
    const queue = fakeQueue();

    const result = await reconcileSchedules(new Map([["credit.reconcile", asQueue(queue)]]));

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      schedulerIdFor("credit.reconcile"),
      // ⚠ `tz` IS PART OF THE CONTRACT, not decoration. BullMQ resolves a cron
      // in the process's local zone unless told, so without this every
      // time-of-day schedule means something different per container.
      { pattern: "*/10 * * * *", tz: "UTC" },
      { name: "scheduled", data: {}, opts: RECONCILE_OPTS },
    );
    expect(result.scheduled).toEqual([{ queue: "credit.reconcile", cron: "*/10 * * * *" }]);
  });

  it("⚠ the tick carries the topology's OWN job options, not BullMQ's defaults", async () => {
    // A bare `{ name }` template produces `attempts: 0` and no retention —
    // measured against real Valkey. For this queue that is a ledger change:
    // the handler's first act is a fresh privileged connection, and §4 gives
    // it a 3× exponential ladder. With no attempts a Postgres blip is
    // TERMINAL on the first try and the orphan sweep — the one path that
    // hands credits back to someone never charged — lands in the DLQ.
    const queue = fakeQueue();

    await reconcileSchedules(new Map([["credit.reconcile", asQueue(queue)]]));

    const template = queue.upsertJobScheduler.mock.calls[0]![2] as { opts: Record<string, unknown> };
    expect(template.opts.attempts).toBe(4);
    expect(template.opts.attempts).not.toBe(0);
    expect(template.opts.removeOnComplete).toEqual({ age: 3600, count: 5000 });
    expect(template.opts.priority).toBe(9);
    expect(template.opts.backoff).toEqual({ type: "custom" });
  });

  it("⚠ REFUSES a tenant-scoped queue, however clear its cron and however wired its handler", async () => {
    // `rollup.metric_daily` has `0 * * * *` from §4 AND a handler — the first
    // cut of this registrar scheduled it, and a review reproduced the result:
    // `createJobProcessor` calls `toTenantJob({})` → `{data: undefined}` and
    // `readKid` throws a TypeError before the handler is ever reached. Every
    // hour, straight into the DLQ. A scheduler has no workspace to name and
    // no key to sign with; §4's "cron hourly" for a tenant-scoped queue means
    // a per-project sweep, which is a different producer entirely.
    const queue = fakeQueue();

    const result = await reconcileSchedules(new Map([["rollup.metric_daily", asQueue(queue)]]));

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(result.scheduled).toEqual([]);
    expect(result.skippedTenantScoped).toEqual(["rollup.metric_daily"]);
    // And not misreported as inert — the handler exists; that is the point.
    expect(result.skippedInert).toEqual([]);
  });

  it("⚠ REFUSES a queue whose handler is not wired, however clear its cron", async () => {
    // `attribution.rollup` has `0 * * * *` and no handler (`capture.plan` had
    // the same until NEW-A-10 wired it). A repeatable
    // here would fail every job down the retry ladder into the DLQ on a
    // timer — turning "not built yet" into "tried and failed" in the record
    // an operator reads during an incident. `src/worker.ts` makes the same
    // argument for the workers: inert is a better lie than broken.
    const queue = fakeQueue();

    const result = await reconcileSchedules(new Map([["attribution.rollup", asQueue(queue)]]));

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(result.scheduled).toEqual([]);
    expect(result.skippedInert).toEqual(["attribution.rollup"]);
  });

  it("NEW-A-10 · capture.plan now has a handler but is tenant-scoped, so a bare cron is still refused", async () => {
    const queue = fakeQueue();

    const result = await reconcileSchedules(new Map([["capture.plan", asQueue(queue)]]));

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(result.scheduled).toEqual([]);
    expect(result.skippedInert).toEqual([]);
    expect(result.skippedTenantScoped).toEqual(["capture.plan"]);
  });

  it("⚠ schedules nothing for a queue whose cadence states no time", async () => {
    // `crawl.audit` is on demand only (STORY-140 AC11): a null cron means
    // nothing is registered. (`topic.cluster` stood here until STORY-140 gave it Sunday 05:00.) (`maintenance.partition` stood
    // here until STORY-142 chose an hour for it — deliberately, and for a
    // reason recorded in `schedule.spec.ts`'s divergence list.)
    const queue = fakeQueue();

    const result = await reconcileSchedules(new Map([["crawl.audit", asQueue(queue)]]));

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(result.scheduled).toEqual([]);
    // And it is not reported as inert — the handler is not the reason.
    expect(result.skippedInert).toEqual([]);
    expect(result.skippedTenantScoped).toEqual([]);
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

  it("⚠ NEVER removes a scheduler this table does not own", async () => {
    // Owning the QUEUE is not owning every scheduler on it. The first cut
    // removed everything it found, and a review reproduced 25 unrelated
    // schedulers on `notify.dispatch` wiped by one boot. The real victims are
    // named in the references: §5's per-workspace scheduled reports on
    // `report.build`, and STORY-033's SchedulerService driving `capture.plan`
    // under its own key. Only the `cron:` prefix is ours.
    const queue = fakeQueue(["report:ws-123:weekly", "sched:capture.plan", "cron:credit.reconcile"]);

    const result = await reconcileSchedules(new Map([["credit.reconcile", asQueue(queue)]]));

    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
  });

  it("⚠ leaves foreign keys alone even on a queue it refuses entirely", async () => {
    const queue = fakeQueue(["report:ws-123:weekly", "cron:report.build"]);

    const result = await reconcileSchedules(new Map([["report.build", asQueue(queue)]]));

    expect(queue.removeJobScheduler).toHaveBeenCalledExactlyOnceWith("cron:report.build");
    expect(result.removed).toEqual(["report.build:cron:report.build"]);
  });

  it("⚠ removes EVERY owned scheduler on a queue that has gone inert", async () => {
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

  it("⚠ UPSERTS BEFORE REMOVING, so a crash between them overlaps rather than gaps", async () => {
    // Not symmetric. For an idempotent tick a brief overlap costs a duplicate
    // run; a SIGKILL landing in a gap leaves the queue unscheduled
    // indefinitely with nothing to show it.
    const order: string[] = [];
    const queue = fakeQueue(["cron:stale"]);
    queue.upsertJobScheduler.mockImplementation(async () => void order.push("upsert"));
    queue.removeJobScheduler.mockImplementation(async () => {
      order.push("remove");
      return true;
    });

    await reconcileSchedules(new Map([["credit.reconcile", asQueue(queue)]]));

    expect(order).toEqual(["upsert", "remove"]);
  });

  it("⚠ reads the WHOLE scheduler range, not a default page of it", async () => {
    // BullMQ's `getJobSchedulers(start, end)` defaults to everything. Passing
    // a bounded range would make stale-removal silently miss whatever fell
    // past the page, and nothing else in this file would notice.
    const queue = fakeQueue(["cron:credit.reconcile"]);

    await reconcileSchedules(new Map([["credit.reconcile", asQueue(queue)]]));

    expect(queue.getJobSchedulers).toHaveBeenCalledExactlyOnceWith();
  });

  it("⚠ touches only the queues it was given, and only its own keys on each", async () => {
    // A worker group is one process and passes its own queues. If a group
    // could see another's, each boot would remove the other's schedulers and
    // the two would fight.
    //
    // Two entries, because a one-entry map makes this vacuous: `removed` is
    // empty no matter what the implementation does.
    const mine = fakeQueue(["cron:credit.reconcile"]);
    const alsoMine = fakeQueue(["cron:notify.dispatch", "someone-elses-key"]);

    const result = await reconcileSchedules(
      new Map([
        ["credit.reconcile", asQueue(mine)],
        ["notify.dispatch", asQueue(alsoMine)],
      ]),
    );

    expect(result.scheduled.map((s) => s.queue)).toEqual(["credit.reconcile"]);
    // `notify.dispatch` has no schedule row at all — its owned key goes, its
    // foreign one stays, and nothing touches the other queue.
    expect(mine.removeJobScheduler).not.toHaveBeenCalled();
    expect(alsoMine.removeJobScheduler).toHaveBeenCalledExactlyOnceWith("cron:notify.dispatch");
  });

  it("⚠ one queue's failure never silences the rest", async () => {
    // The queues are walked in topology order, and `upsertJobScheduler`
    // throws on an unparseable pattern. Without per-queue isolation a typo on
    // an earlier queue would leave `credit.reconcile` unscheduled, with the
    // boot log reporting one error about a different queue entirely.
    const broken = fakeQueue();
    broken.getJobSchedulers.mockRejectedValue(new Error("Invalid characters, got value: a"));
    const good = fakeQueue();

    const result = await reconcileSchedules(
      new Map([
        ["rollup.metric_daily", asQueue(broken)],
        ["credit.reconcile", asQueue(good)],
      ]),
    );

    expect(result.failed).toEqual([{ queue: "rollup.metric_daily", reason: "Invalid characters, got value: a" }]);
    expect(result.scheduled).toEqual([{ queue: "credit.reconcile", cron: "*/10 * * * *" }]);
    expect(good.upsertJobScheduler).toHaveBeenCalledOnce();
  });
});

describe("STORY-140 AC11 · the owner's crons meet the registrar", () => {
  it("geo.analyze, gsc.sync and topic.cluster carry a cron but have no handler and are tenant-scoped, so a bare tick is refused and nothing is scheduled", async () => {
    const queue = fakeQueue();

    const result = await reconcileSchedules(
      new Map([
        ["geo.analyze", asQueue(queue)],
        ["gsc.sync", asQueue(queue)],
        ["topic.cluster", asQueue(queue)],
      ]),
    );

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(result.scheduled).toEqual([]);
    expect([...result.skippedInert].sort()).toEqual(["geo.analyze", "gsc.sync", "topic.cluster"]);
  });

  it("STORY-140 AC11 · crawl.audit and report.build never get a scheduler registered, whatever the registrar is given", async () => {
    const queue = fakeQueue();

    const result = await reconcileSchedules(
      new Map([
        ["crawl.audit", asQueue(queue)],
        ["report.build", asQueue(queue)],
      ]),
    );

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(result.scheduled).toEqual([]);
  });
});
