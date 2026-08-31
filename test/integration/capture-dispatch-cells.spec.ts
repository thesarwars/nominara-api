import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { buildQueue } from "../../src/lib/queue/queue-factory.js";
import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "../../src/lib/queue/topology.js";
import {
  CADENCE_JITTER_MAX_MS,
  cellJitterMs,
  dispatchCaptureCells,
  type DispatchCell,
  type ProjectCadence,
} from "../../src/lib/capture/dispatch-cells.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-032 AC13 — one batch, per-cell jitter.
//
// The load argument for jitter is the obvious one and would announce itself
// as vendor 429s. The ACCURACY argument is the one worth testing: §5 warns
// that capturing everything at once "systematically samples one diurnal
// slice", which has no symptom at all — every tenant's numbers drawn from
// the same moment of the day, and a dataset that quietly describes midnight
// rather than the day. A per-RUN delay would move that spike rather than
// remove it, and would pass any test that only checked "a delay was set".
const ENTRY: QueueTopologyEntry = QUEUE_TOPOLOGY.find((e) => e.name === "capture.plan")!;

describe("STORY-032 · dispatching live cells", () => {
  let fixture: ValkeyFixture;
  const connections: Redis[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 180_000);

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
    for (const c of connections.splice(0)) await c.quit().catch(() => undefined);
  });

  afterAll(async () => {
    await fixture.stop();
  });

  function newQueue(prefix: string) {
    const connection = createQueueWorkerConnection(fixture.connectionString);
    connections.push(connection);
    const queue = buildQueue(ENTRY, { connection, prefix });
    cleanups.push(async () => {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    });
    return queue;
  }

  function cells(count: number): DispatchCell[] {
    return Array.from({ length: count }, (_, i) => ({
      promptId: randomUUID(),
      engineKey: "perplexity",
      sampleIndex: 0,
      payload: { probe: i },
      idempotencyKey: `cap:${randomUUID()}:${String(i)}`,
    }));
  }

  it("enqueues every cell in ONE addBulk, not one call per cell", async () => {
    const queue = newQueue(queueKeyPrefix(`dispatch-batch-${randomUUID().slice(0, 8)}`));
    let bulkCalls = 0;
    let singleAdds = 0;
    const counting = new Proxy(queue, {
      get(target, property, receiver) {
        if (property === "addBulk") {
          return (...args: unknown[]) => {
            bulkCalls += 1;
            return (target.addBulk as (...a: unknown[]) => unknown)(...args);
          };
        }
        if (property === "add") {
          return (...args: unknown[]) => {
            singleAdds += 1;
            return (target.add as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const jobs = await dispatchCaptureCells(counting, ENTRY, cells(30), { cadence: "weekly" });

    expect(jobs).toHaveLength(30);
    expect(bulkCalls, "30 cells must cost one round trip").toBe(1);
    expect(singleAdds, "and no per-cell add").toBe(0);
  }, 60_000);

  // THE PROPERTY A PER-RUN DELAY WOULD FAIL. Every cell must draw its own.
  it("gives each cell its OWN jitter, not one delay shared by the run", async () => {
    const queue = newQueue(queueKeyPrefix(`dispatch-jitter-${randomUUID().slice(0, 8)}`));

    const jobs = await dispatchCaptureCells(queue, ENTRY, cells(40), { cadence: "weekly" });
    const delays = jobs.map((job) => job.opts.delay ?? 0);

    expect(
      new Set(delays).size,
      "40 cells sharing one delay is the spike this exists to remove, moved rather than removed",
    ).toBeGreaterThan(1);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay, "§5's weekly row is 0-3600s").toBeLessThanOrEqual(CADENCE_JITTER_MAX_MS.weekly);
    }
  }, 60_000);

  // A manual run is someone waiting for an answer. Spreading it across an
  // hour to protect a diurnal sample nobody is measuring would trade a real
  // user's time for nothing.
  it("a manual run is dispatched immediately, with no jitter at all", async () => {
    const queue = newQueue(queueKeyPrefix(`dispatch-manual-${randomUUID().slice(0, 8)}`));

    const jobs = await dispatchCaptureCells(queue, ENTRY, cells(10), { cadence: "manual" });

    expect(jobs.every((job) => (job.opts.delay ?? 0) === 0)).toBe(true);
  }, 60_000);

  it("keeps each cell's deduplication identity, so a replayed plan enqueues no second job", async () => {
    const queue = newQueue(queueKeyPrefix(`dispatch-dedup-${randomUUID().slice(0, 8)}`));
    const batch = cells(5);

    await dispatchCaptureCells(queue, ENTRY, batch, { cadence: "weekly" });
    await dispatchCaptureCells(queue, ENTRY, batch, { cadence: "weekly" });

    const counts = await queue.getJobCounts("waiting", "prioritized", "delayed", "active");
    const total = (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
    expect(total, "the same five cells, dispatched twice, are still five jobs").toBe(5);
  }, 60_000);

  it("dispatches nothing, and asks nothing, for a run with no live cells", async () => {
    const queue = newQueue(queueKeyPrefix(`dispatch-empty-${randomUUID().slice(0, 8)}`));
    let bulkCalls = 0;
    const counting = new Proxy(queue, {
      get(target, property, receiver) {
        if (property === "addBulk") {
          return (...args: unknown[]) => {
            bulkCalls += 1;
            return (target.addBulk as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    expect(await dispatchCaptureCells(counting, ENTRY, [], { cadence: "weekly" })).toEqual([]);
    expect(bulkCalls, "a fully cache-served run must not touch the queue").toBe(0);
  }, 60_000);

  // The bounds, asserted against §5's table directly rather than through a
  // sampled draw — a random() that always returned 0 would pass every test
  // above.
  it.each([
    ["hourly", 300_000],
    ["daily", 900_000],
    ["twice_weekly", 3_600_000],
    ["weekly", 3_600_000],
    ["manual", 0],
  ] as const)("§5's jitter for %s tops out at %ims", (cadence, max) => {
    expect(CADENCE_JITTER_MAX_MS[cadence as ProjectCadence]).toBe(max);
    expect(cellJitterMs(cadence as ProjectCadence, () => 0)).toBe(0);
    expect(cellJitterMs(cadence as ProjectCadence, () => 0.999_999)).toBeLessThanOrEqual(max);
    expect(cellJitterMs(cadence as ProjectCadence, () => 1)).toBe(max);
  });
});
