import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueueConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { attachDeadLetterHandler, buildDlqQueue, dlqQueueName, recordDeadLetter, type DlqEntry } from "../../src/lib/queue/dead-letter.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { buildWorker } from "../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "../../src/lib/queue/topology.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { TEST_SIGNING_KEYS, fakeClient, jobDataFor, waitFor } from "../support/queue-test-harness.js";

// STORY-030 Phase B / Test scenario 5 — "Fail a job past its retry ladder →
// lands in its dead-letter queue with payload and error." Exercised against
// a representative sample of queues with a non-trivial retry ladder
// (capture.plan: 3 retries; a non-tenant-scoped queue too, credit.reconcile,
// to prove the DLQ mechanism doesn't depend on tenant scoping).

const REPRESENTATIVE_QUEUES: readonly QueueTopologyEntry[] = QUEUE_TOPOLOGY.filter((entry) =>
  ["capture.plan", "credit.reconcile"].includes(entry.name),
);

describe("STORY-030 · queue-dead-letter — a permanently-failed job lands in {queue}.dlq with its full payload and last error", () => {
  let fixture: ValkeyFixture;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(cleanups.map((fn) => fn()));
    await fixture.stop();
  });

  it.each(REPRESENTATIVE_QUEUES)("$name: exhausting the retry ladder lands the job in $name.dlq with payload + error + attempt count", async (entry) => {
    const producerConnection = createQueueConnection(fixture.connectionString);
    const workerConnection = createQueueConnection(fixture.connectionString);
    const dlqConnection = createQueueConnection(fixture.connectionString);
    const prefix = queueKeyPrefix(`dlq-${entry.name}`);

    const queue = buildQueue(entry, { connection: producerConnection, prefix });
    const dlqQueue = buildDlqQueue(entry, { connection: dlqConnection, prefix });

    const failure = new Error(`STORY-030 dead-letter test — ${entry.name} always fails`);
    const worker = buildWorker(entry, {
      connection: workerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => {
        throw failure;
      },
    });
    attachDeadLetterHandler(worker, dlqQueue, entry);

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await dlqQueue.close();
      await Promise.all(
        [producerConnection, workerConnection, dlqConnection].map((connection) => connection.quit().catch(() => undefined)),
      );
    });

    const data = jobDataFor(entry, { probe: "dead-letter" });
    await enqueueJob(queue, entry, data, { idempotencyKey: `dlq-${entry.name}`, priorityVariant: "scheduled" });

    await waitFor(async () => (await dlqQueue.count()) >= 1, {
      timeoutMs: 20_000,
      label: `${entry.name}.dlq to receive the terminally-failed job`,
    });

    const dlqJobs = await dlqQueue.getJobs(["waiting", "delayed", "active", "completed"]);
    expect(dlqJobs).toHaveLength(1);

    const dlqEntry = dlqJobs[0]!.data as DlqEntry;
    expect(dlqEntry.queue).toBe(entry.name);
    expect(dlqEntry.payload).toEqual(data);
    expect(dlqEntry.error.message).toBe(failure.message);
    expect(dlqEntry.attemptsMade).toBe(entry.retry.delaysMs.length + 1);

    // The original queue itself has nothing left waiting/active/delayed.
    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    expect((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0)).toBe(0);
  }, 30_000);

  it.each(REPRESENTATIVE_QUEUES)("$name.dlq: a DLQ entry is never itself retried", async (entry) => {
    const dlqConnection = createQueueConnection(fixture.connectionString);
    const prefix = queueKeyPrefix(`dlq-noretry-${entry.name}`);
    const dlqQueue = buildDlqQueue(entry, { connection: dlqConnection, prefix });

    cleanups.push(async () => {
      await dlqQueue.close();
      await dlqConnection.quit().catch(() => undefined);
    });

    const fakeJob = {
      id: "fake-job-id",
      data: { probe: true },
      attemptsMade: 4,
      opts: { attempts: 4 },
    } as unknown as Job;

    await recordDeadLetter(dlqQueue, entry, fakeJob, new Error("terminal"));

    const jobs = await dlqQueue.getJobs(["waiting", "delayed", "active", "completed"]);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.opts.attempts).toBe(1);
    expect(job.opts.backoff).toBeUndefined();
    expect(dlqQueueName(entry.name)).toBe(`${entry.name}.dlq`);
  }, 15_000);
});
