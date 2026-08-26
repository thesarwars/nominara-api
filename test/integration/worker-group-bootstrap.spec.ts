import { Queue, Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-030 Phase B / Test scenario 10 — "Run a worker with each queue group
// → one image, correct group." `bootstrapWorker()` must construct exactly
// the invoked group's Worker instances and zero others, and an unknown
// group must throw BEFORE any Redis connection is even attempted — asserted
// here by spying on connection.ts's createQueueConnection and requiring it
// is NEVER called on the invalid-group path. A real Valkey testcontainer
// backs the valid-group path so `queuesForGroup`'s output is checked against
// ACTUALLY constructed Worker instances, not merely against the topology
// table again.

const EXPECTED_GROUP_MEMBERSHIP: Record<string, string[]> = {
  capture: ["capture.plan", "capture.execute", "lookup.execute"],
  parse: ["capture.parse", "capture.arbitrate"],
  crawl: ["crawl.discover", "crawl.fingerprint", "crawl.audit", "gsc.sync"],
  embed: ["embed.batch", "topic.cluster"],
  rollup: [
    "rollup.metric_daily",
    "displacement.detect",
    "geo.analyze",
    "task.generate",
    "attribution.rollup",
    "credit.reconcile",
    "notify.dispatch",
    "maintenance.partition",
  ],
  report: ["report.build"],
  deploy: ["deploy.cms"],
};

async function mockConnectionSpy() {
  vi.resetModules();
  vi.doMock("../../src/lib/queue/connection.js", async () => {
    const actual = await vi.importActual<typeof import("../../src/lib/queue/connection.js")>("../../src/lib/queue/connection.js");
    return { ...actual, createQueueConnection: vi.fn(actual.createQueueConnection) };
  });
  return (await import("../../src/lib/queue/connection.js")).createQueueConnection as unknown as ReturnType<typeof vi.fn>;
}

describe("STORY-030 · worker-group-bootstrap — bootstrapWorker() constructs exactly one group's queues/workers", () => {
  let fixture: ValkeyFixture;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    fixture = await startValkeyFixture();
    applyFakeApiEnv();
    process.env.QUEUE_REDIS_URL = fixture.connectionString;
  }, 60_000);

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fixture.stop();
    vi.doUnmock("../../src/lib/queue/connection.js");
    vi.resetModules();
  });

  it.each(Object.entries(EXPECTED_GROUP_MEMBERSHIP))(
    "WORKER_GROUP=%s constructs exactly that group's workers and zero others",
    async (group, expectedNames) => {
      const createQueueConnectionSpy = await mockConnectionSpy();
      process.env.WORKER_GROUP = group;
      const { bootstrapWorker, WORKER_GROUP_WORKERS } = await import("../../src/worker.js");

      const app = await bootstrapWorker();
      try {
        const runtime = app.get<{ workers: readonly { name: string }[] }>(WORKER_GROUP_WORKERS);
        const names = runtime.workers.map((worker) => worker.name).sort();
        expect(names).toEqual([...expectedNames].sort());
        // One connection per worker + one per its DLQ queue.
        expect(createQueueConnectionSpy).toHaveBeenCalledTimes(expectedNames.length * 2);
      } finally {
        await app.close();
      }
    },
    20_000,
  );

  it("an unknown WORKER_GROUP throws before bootstrapWorker() opens any queue connection", async () => {
    const createQueueConnectionSpy = await mockConnectionSpy();
    process.env.WORKER_GROUP = "not-a-real-group";

    const { bootstrapWorker } = await import("../../src/worker.js");

    await expect(bootstrapWorker()).rejects.toThrow();
    expect(createQueueConnectionSpy).not.toHaveBeenCalled();
  });

  // Code-review fix (post Phase B) — a construction failure partway through a
  // group must not leak the queues/workers/connections already built for the
  // entries BEFORE the failing one. "crawl" has 4 queues (discover,
  // fingerprint, audit, gsc.sync); the 3rd createQueueConnection() call is
  // fingerprint's FIRST connection (its DLQ queue's) — so discover's worker
  // and DLQ queue must already exist and must be closed before the rethrow,
  // while fingerprint/audit/gsc.sync never get built at all.
  it("closes every already-built worker/dlqQueue when a later queue in the group fails to construct, then rethrows", async () => {
    vi.resetModules();
    let callCount = 0;
    const injectedError = new Error("STORY-030 injected failure — this queue's connection cannot be created");
    vi.doMock("../../src/lib/queue/connection.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/lib/queue/connection.js")>("../../src/lib/queue/connection.js");
      return {
        ...actual,
        createQueueConnection: vi.fn((url: string) => {
          callCount += 1;
          if (callCount === 3) {
            throw injectedError;
          }
          return actual.createQueueConnection(url);
        }),
      };
    });

    const closed: Array<{ type: "worker" | "queue"; name: string }> = [];
    const originalWorkerClose = Worker.prototype.close;
    const originalQueueClose = Queue.prototype.close;
    const workerCloseSpy = vi.spyOn(Worker.prototype, "close").mockImplementation(function (this: Worker, ...args: unknown[]) {
      closed.push({ type: "worker", name: this.name });
      return originalWorkerClose.apply(this, args as Parameters<typeof originalWorkerClose>);
    });
    const queueCloseSpy = vi.spyOn(Queue.prototype, "close").mockImplementation(function (this: Queue, ...args: unknown[]) {
      closed.push({ type: "queue", name: this.name });
      return originalQueueClose.apply(this, args as Parameters<typeof originalQueueClose>);
    });

    try {
      process.env.WORKER_GROUP = "crawl";
      const { bootstrapWorker } = await import("../../src/worker.js");

      await expect(bootstrapWorker()).rejects.toBe(injectedError);

      expect(closed).toContainEqual({ type: "worker", name: "crawl.discover" });
      expect(closed).toContainEqual({ type: "queue", name: "crawl.discover.dlq" });
      // The failing entry (fingerprint) and everything after it never got built, so nothing for them to close.
      expect(closed.some((c) => c.name.startsWith("crawl.fingerprint"))).toBe(false);
      expect(closed.some((c) => c.name.startsWith("crawl.audit"))).toBe(false);
      expect(closed.some((c) => c.name.startsWith("gsc.sync"))).toBe(false);
      expect(closed).toHaveLength(2); // exactly discover's worker + its dlq queue — nothing else leaked, nothing double-closed
    } finally {
      workerCloseSpy.mockRestore();
      queueCloseSpy.mockRestore();
    }
  }, 20_000);
});
