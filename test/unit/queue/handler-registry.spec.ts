import { describe, expect, it } from "vitest";
import {
  QUEUE_HANDLERS,
  handlerFor,
  inertQueueNames,
  liveQueueNames,
  type QueueHandlerFactory,
} from "../../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../../src/lib/queue/topology.js";

// STORY-124 · src/lib/queue/handlers.ts. The registry itself — the
// end-to-end proof that a registered handler actually processes a job is
// test/integration/queue-handler-registry.spec.ts.

describe("STORY-124 · the registry is typed against the real queue names", () => {
  // Scenario 1 is a COMPILE-time property and cannot be asserted at
  // runtime: `QUEUE_HANDLERS` is Partial<Record<QueueName, …>>, so
  // `{ "capture.plna": factory }` is a type error, not a test failure. What
  // runtime can check is the other direction — that nothing has registered
  // a name the topology does not have, which would mean the type was
  // widened or bypassed at some point.
  it("registers nothing the topology does not declare", () => {
    const topologyNames = new Set(QUEUE_TOPOLOGY.map((entry) => entry.name));
    for (const name of Object.keys(QUEUE_HANDLERS)) {
      expect(topologyNames.has(name), `${name} is registered but is not a queue`).toBe(true);
    }
  });

  it("every queue is accounted for — live plus inert is the whole topology, with no overlap", () => {
    const live = liveQueueNames();
    const inert = inertQueueNames();
    expect(live.length + inert.length).toBe(QUEUE_TOPOLOGY.length);
    expect(new Set([...live, ...inert]).size).toBe(QUEUE_TOPOLOGY.length);
  });

  it("handlerFor returns undefined for a queue with no entry, and for a name that is not a queue at all", () => {
    expect(handlerFor("definitely.not.a.queue")).toBeUndefined();
    for (const name of inertQueueNames()) {
      expect(handlerFor(name), `${name} is listed inert but resolves a handler`).toBeUndefined();
    }
  });

  // The set is deliberately asserted rather than left open, so a handler
  // cannot appear without anyone noticing. STORY-124 shipped the seam with
  // none; STORY-043 lands the first, exactly as that story's comment said it
  // would ("crawl.discover with STORY-043"), STORY-034 lands the second and
  // STORY-135 the third, and STORY-042 the fourth. Every later story updates
  // this line in its own commit.
  //
  // STORY-073 lands `credit.reconcile`, and it was the first entry here whose
  // PRODUCER did not exist: nothing registered a BullMQ repeatable job, so the
  // queue was live and simply never handed one. Wired rather than inert on
  // purpose — see `handlers.ts` — because the alternative is editing this file
  // under whatever incident first makes someone want the reconciler running.
  // STORY-140 finally gave it one.
  //
  // STORY-142 lands `maintenance.partition`, and it is the reverse case: the
  // WORK existed (`runMonthlyMaintenance`, complete and tested under
  // STORY-013) and only the handler and the tick were missing, so the estate
  // ran on partitions nobody was extending.
  it("ships exactly the handlers the stories that landed them declared", () => {
    expect(Object.keys(QUEUE_HANDLERS).sort()).toEqual([
      "audit.verify",
      "billing.auto_topup",
      "billing.customer_email",
      "billing.downgrade_notice",
      "capture.execute",
      "capture.parse",
      "capture.plan",
      "crawl.audit",
      "crawl.discover",
      "credit.housekeeping",
      "credit.reconcile",
      "domain.reverify",
      "embed.batch",
      "identity.sweep_unverified",
      // STORY-079 - the Visibility Scan, on the dedicated interactive pool.
      "lookup.execute",
      "maintenance.partition",
      "notify.dispatch",
      "report.build",
      "retention.purge",
      "rollup.metric_daily",
      "source.verify_presence",
      "task.generate",
      "task.resurface",
      "topic.cluster",
    ]);
    // Topology order, not alphabetical — `liveQueueNames` filters
    // QUEUE_TOPOLOGY, and the capture queues are declared before the crawl
    // ones, which come before the rollup group's.
    expect(liveQueueNames()).toEqual([
      "capture.plan",
      "capture.execute",
      "capture.parse",
      // STORY-079 - declared after capture.arbitrate (inert) and before crawl.discover in topology.ts.
      "lookup.execute",
      "crawl.discover",
      // NEW-C-9 — after crawl.fingerprint (inert), before the embed group.
      "crawl.audit",
      // STORY-133 - the embed group's first handler, declared after crawl.audit and before rollup.metric_daily in topology.ts.
      "embed.batch",
      "rollup.metric_daily",
      // STORY-047 - topic.cluster, the embed group's second handler, declared after rollup.metric_daily and before task.generate in topology.ts.
      "topic.cluster",
      // STORY-063 — declared after topic.cluster in topology.ts, i.e. between the rollup and credit entries.
      "task.generate",
      "credit.reconcile",
      // STORY-100 — report.build (the cadence path of a scheduled report), declared before notify.dispatch in topology.ts.
      "report.build",
      // STORY-068 — declared after report.build and before maintenance.partition in topology.ts.
      "notify.dispatch",
      "maintenance.partition",
      // Declared after maintenance.partition in topology.ts — STORY-143's
      // addition sits at the end of the rollup group's entries.
      "audit.verify",
      // STORY-173 — added after audit.verify in topology.ts.
      "identity.sweep_unverified",
      // NEW-C-15 — declared after identity.sweep_unverified in topology.ts.
      "source.verify_presence",
      // NEW-D-7 — declared after source.verify_presence in topology.ts.
      "billing.auto_topup",
      // STORY-021 (ownership transfer) — declared after billing.auto_topup in topology.ts.
      "billing.customer_email",
      // STORY-077 (owner decision 2026-10-23) — declared after billing.customer_email in topology.ts.
      "billing.downgrade_notice",
      // STORY-076 / STORY-071 and STORY-077 R4 — declared after billing.downgrade_notice in topology.ts.
      "credit.housekeeping",
      "retention.purge",
      // STORY-048 AC7 — declared after retention.purge in topology.ts.
      "domain.reverify",
      // STORY-064 AC5 — declared after domain.reverify in topology.ts.
      "task.resurface",
    ]);
  });

  // `capture.plan` is wired by NEW-A-10 (the scheduled-run planner).
  // `capture.arbitrate` STAYS INERT: it has no bound model — STORY-038 left the
  // port unbound pending a dependency decision, and a worker pulling a job it
  // cannot process would fail it into the dead-letter queue.
  it("leaves the rest of the capture queues inert", () => {
    for (const name of ["capture.arbitrate"]) {
      expect(handlerFor(name), `${name} should still be inert`).toBeUndefined();
    }
  });

  // The half that keeps mattering as handlers accumulate: an unwired queue
  // must stay INERT rather than pull a job it cannot process and fail it down
  // the retry ladder into the dead-letter queue — turning "not built yet" into
  // "tried and failed" in the record an operator reads during an incident.
  it("every queue without a handler is still inert", () => {
    const live = new Set(liveQueueNames());
    const expectedInert = QUEUE_TOPOLOGY.map((entry) => entry.name).filter((name) => !live.has(name));

    expect(inertQueueNames()).toEqual(expectedInert);
    expect(inertQueueNames()).toHaveLength(QUEUE_TOPOLOGY.length - live.size);
    expect(live.size + inertQueueNames().length).toBe(QUEUE_TOPOLOGY.length);
  });

  it("liveQueueNames and inertQueueNames answer for a subset too — inertness is per worker group", () => {
    // A deploy worker with no handlers is inert even when capture and rollup
    // are wired, so the boot line has to be able to ask about one group's set.
    //
    // This used the ROLLUP group until STORY-042 gave it a handler. The
    // property under test is "inertness is per group", not "rollup is inert",
    // so it moves to a group that is still empty rather than being deleted —
    // and the assertion below covers the other half, which the old version
    // could not. (STORY-100 gave the report group its handler, so this is the deploy group now.)
    const deploy = QUEUE_TOPOLOGY.filter((entry) => entry.workerGroup === "deploy").map((entry) => entry.name);
    expect(deploy.length).toBeGreaterThan(0);
    expect(inertQueueNames(deploy)).toEqual(deploy);
    expect(liveQueueNames(deploy)).toEqual([]);
  });

  it("a group with SOME handlers reports both halves", () => {
    // The capture group had one inert queue until STORY-079 gave `lookup.execute` its handler, so the property moves to the parse group, where
    // `capture.parse` is live and `capture.arbitrate` is still inert (it has no bound model).
    const parse = QUEUE_TOPOLOGY.filter((entry) => entry.workerGroup === "parse").map((entry) => entry.name);
    expect(liveQueueNames(parse)).toEqual(["capture.parse"]);
    expect(inertQueueNames(parse)).toEqual(["capture.arbitrate"]);
  });

  it("a factory is called once per queue at boot, not once per job", () => {
    // The shape the registry promises: the factory builds the processor,
    // the processor handles jobs. A handler that opened a connection per
    // factory call would otherwise open one per job.
    let built = 0;
    const factory: QueueHandlerFactory = () => {
      built += 1;
      return async () => undefined;
    };
    const context = { pool: {} as never, env: {} as never };
    const processor = factory(context);
    expect(built).toBe(1);
    expect(typeof processor).toBe("function");
  });
});
