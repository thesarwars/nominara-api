import { Queue, Worker } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { queueKeyPrefix } from "../../src/lib/queue/connection.js";

// STORY-030 Phase B / Test scenario 10 — "Run a worker with each queue group
// → one image, correct group." `bootstrapWorker()` must construct exactly
// the invoked group's Worker instances and zero others, and an unknown
// group must throw BEFORE any Redis connection is even attempted — asserted
// here by spying on connection.ts's createQueueWorkerConnection and requiring it
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
    return {
      ...actual,
      createQueueWorkerConnection: vi.fn(actual.createQueueWorkerConnection),
      createQueueReaderConnection: vi.fn(actual.createQueueReaderConnection),
    };
  });
  const mod = await import("../../src/lib/queue/connection.js");
  return {
    worker: mod.createQueueWorkerConnection as unknown as ReturnType<typeof vi.fn>,
    reader: mod.createQueueReaderConnection as unknown as ReturnType<typeof vi.fn>,
  };
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
      const spies = await mockConnectionSpy();
      process.env.WORKER_GROUP = group;
      const { bootstrapWorker, WORKER_GROUP_WORKERS } = await import("../../src/worker.js");

      const app = await bootstrapWorker();
      try {
        const runtime = app.get<{ workers: readonly { name: string }[] }>(WORKER_GROUP_WORKERS);
        const names = runtime.workers.map((worker) => worker.name).sort();
        expect(names).toEqual([...expectedNames].sort());
        // One connection per worker + one per its DLQ queue. Nothing else may
        // take a WORKER connection.
        expect(spies.worker).toHaveBeenCalledTimes(expectedNames.length * 2);
        // ⚠ EXACTLY ONE READER CONNECTION, SHARED BY EVERY SCHEDULE QUEUE, and
        // it must be the READER factory (G12). Two assertions in one:
        //
        // The COUNT — a Worker blocks on Redis and needs its own connection; a
        // producer-side Queue does not, and giving each of these one would
        // have multiplied every worker process's connection count to Valkey
        // for schedulers upserted once at boot. If this ever grows with the
        // group size, someone has stopped sharing it.
        //
        // The FACTORY — the worker factory sets `maxRetriesPerRequest: null`,
        // so a read through it against an unreachable Valkey never rejects and
        // never resolves. These Queues ask questions and must answer. An
        // earlier cut used the worker factory here and needed a bespoke
        // timeout to escape the hang it caused.
        expect(spies.reader).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
    20_000,
  );

  // ⚠ G12 — THE ONLY TESTS THAT PROVE THE SCHEDULER IS WIRED AT ALL.
  //
  // Everything else in this file is satisfied by construction. A review
  // mutated the reconcile call out of `src/worker.ts` entirely — keeping the
  // connection and the Queues — and all nine tests passed, boot log reading
  // "scheduled: none". The whole feature could have been a no-op in
  // production with the suite green. These read the REAL Valkey the boot just
  // wrote to, which is the only place the truth lives.
  async function schedulersIn(group: string): Promise<{ key: string; pattern: string; next: number }[]> {
    process.env.WORKER_GROUP = group;
    const { bootstrapWorker } = await import("../../src/worker.js");
    const app = await bootstrapWorker();
    try {
      const probe = new Queue("credit.reconcile", {
        connection: { url: fixture.connectionString },
        prefix: queueKeyPrefix(process.env.NODE_ENV ?? "test"),
      });
      try {
        const found = await probe.getJobSchedulers();
        return found.map((entry) => ({
          key: String(entry.key),
          pattern: String(entry.pattern),
          next: Number(entry.next),
        }));
      } finally {
        await probe.close();
      }
    } finally {
      await app.close();
    }
  }

  it("⚠ WORKER_GROUP=rollup actually writes credit.reconcile's scheduler to Valkey", async () => {
    await mockConnectionSpy();

    const found = await schedulersIn("rollup");

    expect(found).toHaveLength(1);
    expect(found[0]!.key).toBe("cron:credit.reconcile");
    expect(found[0]!.pattern).toBe("*/10 * * * *");
  }, 20_000);

  it("⚠ and the cron PARSES to the cadence §4 states, not merely to the string we wrote twice", async () => {
    // Both `schedule.ts` and `schedule.spec.ts` are hand transcriptions from
    // the same head, so a typo that survives one survives both. A dropped
    // field is not a syntax error — cron-parser accepts `*/10 * * *` and
    // reads it as every minute during one hour of the day. Asserting the
    // PARSED fire time is what catches that, and it goes through BullMQ's own
    // parser, which is the one that will actually run.
    await mockConnectionSpy();

    const found = await schedulersIn("rollup");

    const next = new Date(found[0]!.next);
    expect(next.getUTCSeconds()).toBe(0);
    expect(next.getUTCMinutes() % 10).toBe(0);
    // Within the next ten minutes — a four-field misread fires within one.
    expect(found[0]!.next - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  }, 20_000);

  it("⚠ WORKER_GROUP=parse writes NOTHING — the reconcile is scoped to the group that owns the queue", async () => {
    // The scoping decision, asserted against Redis rather than against a
    // one-entry map that could not have failed.
    await mockConnectionSpy();

    const found = await schedulersIn("parse");

    expect(found).toEqual([]);
  }, 20_000);

  it("⚠ WORKER_GROUP=rollup also schedules maintenance.partition, daily", async () => {
    // STORY-142. The queue had a handler and a cadence the moment that story
    // landed, and neither is worth anything if the boot does not register the
    // repeatable — which is exactly the gap a review found in STORY-140, where
    // the whole feature could be deleted from `src/worker.ts` with the suite
    // green. Asserted against the real Valkey the boot wrote to.
    await mockConnectionSpy();
    process.env.WORKER_GROUP = "rollup";
    const { bootstrapWorker } = await import("../../src/worker.js");
    const app = await bootstrapWorker();
    try {
      const probe = new Queue("maintenance.partition", {
        connection: { url: fixture.connectionString },
        prefix: queueKeyPrefix(process.env.NODE_ENV ?? "test"),
      });
      try {
        const found = await probe.getJobSchedulers();
        expect(found).toHaveLength(1);
        expect(found[0]!.key).toBe("cron:maintenance.partition");
        expect(found[0]!.pattern).toBe("20 3 * * *");
        // ⚠ THE TIMEZONE IS THE ASSERTION, and it must be asserted DIRECTLY
        // rather than inferred from the next fire time. BullMQ resolves a cron
        // in the process's local zone unless told, so `20 3 * * *` means 03:20
        // wherever the container thinks it is — found here on a UTC+6 machine,
        // where the boot produced a 21:20 UTC fire. A next-fire-time check
        // alone would pass on a UTC runner no matter what, which is precisely
        // how this would have reached production and then behaved differently
        // there than in CI.
        expect((found[0] as { tz?: string }).tz).toBe("UTC");
        // And the parsed instant agrees, which also catches a dropped cron
        // field — accepted silently by the parser and meaning something else.
        const next = new Date(Number(found[0]!.next));
        expect(next.getUTCHours()).toBe(3);
        expect(next.getUTCMinutes()).toBe(20);
      } finally {
        await probe.close();
      }
    } finally {
      await app.close();
    }
  }, 20_000);

  it("⚠ rollup does NOT schedule its tenant-scoped queues, however wired their handlers", async () => {
    // `rollup.metric_daily` has a cron in §4 AND a handler, and a bare tick
    // cannot drive it: the tenant processor throws on the empty envelope
    // before the handler is reached, once an hour, into the DLQ forever.
    await mockConnectionSpy();
    process.env.WORKER_GROUP = "rollup";
    const { bootstrapWorker } = await import("../../src/worker.js");
    const app = await bootstrapWorker();
    try {
      const probe = new Queue("rollup.metric_daily", {
        connection: { url: fixture.connectionString },
        prefix: queueKeyPrefix(process.env.NODE_ENV ?? "test"),
      });
      try {
        expect(await probe.getJobSchedulers()).toEqual([]);
      } finally {
        await probe.close();
      }
    } finally {
      await app.close();
    }
  }, 20_000);

  it("an unknown WORKER_GROUP throws before bootstrapWorker() opens any queue connection", async () => {
    const spies = await mockConnectionSpy();
    process.env.WORKER_GROUP = "not-a-real-group";

    const { bootstrapWorker } = await import("../../src/worker.js");

    await expect(bootstrapWorker()).rejects.toThrow();
    expect(spies.worker).not.toHaveBeenCalled();
    expect(spies.reader).not.toHaveBeenCalled();
  });

  // Code-review fix (post Phase B) — a construction failure partway through a
  // group must not leak the queues/workers/connections already built for the
  // entries BEFORE the failing one. "crawl" has 4 queues (discover,
  // fingerprint, audit, gsc.sync); the 3rd createQueueWorkerConnection() call is
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
        createQueueWorkerConnection: vi.fn((url: string) => {
          callCount += 1;
          if (callCount === 3) {
            throw injectedError;
          }
          return actual.createQueueWorkerConnection(url);
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
