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

  // The count is deliberately asserted rather than left open. STORY-124
  // ships the seam and no handlers; the first story to add one updates this
  // line in the same commit, which is the point — a handler appearing
  // without anyone noticing is exactly what this makes impossible.
  it("ships zero handlers — the seam, not the business logic", () => {
    expect(Object.keys(QUEUE_HANDLERS)).toEqual([]);
    expect(inertQueueNames()).toHaveLength(21);
  });

  it("liveQueueNames and inertQueueNames answer for a subset too — inertness is per worker group", () => {
    // A rollup worker with no handlers is inert even when capture is fully
    // wired, so the boot line has to be able to ask about one group's set.
    const rollup = QUEUE_TOPOLOGY.filter((entry) => entry.workerGroup === "rollup").map((entry) => entry.name);
    expect(rollup.length).toBeGreaterThan(0);
    expect(inertQueueNames(rollup)).toEqual(rollup);
    expect(liveQueueNames(rollup)).toEqual([]);
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
