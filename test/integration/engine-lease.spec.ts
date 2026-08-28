import { Worker, type Job } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withEngineLease } from "../../src/lib/engines/engine-lease.js";
import { TokenBucket } from "../../src/lib/engines/token-bucket.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { TEST_SIGNING_KEYS, fakeClient, jobDataFor, waitFor } from "../support/queue-test-harness.js";

// STORY-031 Phase B — AC1/Test scenario 1: "Exhaust an engine's bucket →
// Jobs re-delay rather than fail." `withEngineLease` wraps
// `createJobProcessor`'s OUTPUT (D17: it never reorders anything INSIDE
// that function — signature verification still runs, unchanged, the moment
// the wrapped processor is actually invoked).

const ENTRY = QUEUE_TOPOLOGY.find((e) => e.name === "capture.execute")!;

describe("STORY-031 · engine-lease — no lease re-delays via BullMQ's DelayedError, never fails the job", () => {
  let queueFixture: ValkeyFixture;
  let cacheFixture: ValkeyFixture;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    [queueFixture, cacheFixture] = await Promise.all([startValkeyFixture(), startValkeyFixture()]);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  afterAll(async () => {
    await queueFixture.stop();
    await cacheFixture.stop();
  });

  it("a job denied a lease is moved to delayed (not failed), attemptsMade stays 0, and it processes once the bucket refills", async () => {
    const producerConnection = createQueueWorkerConnection(queueFixture.connectionString);
    const workerConnection = createQueueWorkerConnection(queueFixture.connectionString);
    const cacheRedis = createQueueWorkerConnection(cacheFixture.connectionString);
    const prefix = queueKeyPrefix("engine-lease-test-1");

    const queue = buildQueue(ENTRY, { connection: producerConnection, prefix });

    let processedCount = 0;
    const innerProcessor = createJobProcessor(ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => {
        processedCount += 1;
      },
    });

    const tokenBucket = new TokenBucket(cacheRedis);
    // Pre-drain the single-capacity bucket BEFORE the job is ever pulled, so
    // the worker's FIRST attempt is denied a lease deterministically.
    const preDrain = await tokenBucket.tryAcquire("chatgpt", { capacity: 1, refillPerSecond: 5 });
    expect(preDrain.granted).toBe(true);

    const wrapped = withEngineLease(innerProcessor, {
      tokenBucket,
      configFor: () => ({ capacity: 1, refillPerSecond: 5 }),
      resolveEngineKey: () => "chatgpt",
    });

    const worker = new Worker(ENTRY.name, wrapped, { connection: workerConnection, prefix, concurrency: ENTRY.concurrency });

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await producerConnection.quit().catch(() => undefined);
      await workerConnection.quit().catch(() => undefined);
      await cacheRedis.quit().catch(() => undefined);
    });

    const job = await enqueueJob(queue, ENTRY, jobDataFor(ENTRY, {}), {
      idempotencyKey: "engine-lease-denied-then-granted",
      priorityVariant: "interactive",
    });

    // Give the worker a moment to pull it, get denied, and move it to delayed.
    await waitFor(
      async () => {
        const fresh = (await queue.getJob(job.id!)) as Job | undefined;
        return (await fresh?.getState()) === "delayed";
      },
      { timeoutMs: 5_000, label: "job to be moved to delayed after a denied lease" },
    );

    const delayed = (await queue.getJob(job.id!))!;
    expect(delayed.attemptsMade).toBe(0);
    expect(processedCount).toBe(0);

    // The bucket (capacity 1, refill 5/s) refills within ~200ms — well
    // before this job's own re-delay elapses is not guaranteed, but BullMQ
    // re-promotes it automatically once its delay passes, and by THEN the
    // bucket has refilled, so the retried attempt is granted.
    await waitFor(() => processedCount === 1, { timeoutMs: 10_000, label: "job to eventually process once the bucket refills" });

    const completed = (await queue.getJob(job.id!)) as Job | undefined;
    // Never touched the terminal-failure path: no DLQ write, no attempts
    // consumed by the denial itself (BullMQ's own retry-ladder bookkeeping
    // never even saw this as a "failed" attempt).
    expect(completed).toBeDefined();
  }, 20_000);
});
