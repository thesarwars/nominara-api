import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { buildWorker } from "../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { TEST_SIGNING_KEYS, fakeClient, jobDataFor, waitFor } from "../support/queue-test-harness.js";

// STORY-030 Phase B / Test scenario 2 — "Replay each job with the same key →
// at most one effect." Table-driven over all 21 QUEUE_TOPOLOGY entries:
// enqueueJob() called TWICE with the SAME idempotencyKey must produce
// exactly one processed effect; called with two DIFFERENT keys must produce
// two.

describe("STORY-030 · queue-idempotency — a replay with the same key produces at most one effect, per queue", () => {
  let fixture: ValkeyFixture;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(cleanups.map((fn) => fn()));
    await fixture.stop();
  });

  it.each(QUEUE_TOPOLOGY)("$name: same idempotency key replayed twice → exactly one effect", async (entry) => {
    const producerConnection = createQueueWorkerConnection(fixture.connectionString);
    const workerConnection = createQueueWorkerConnection(fixture.connectionString);
    const prefix = queueKeyPrefix(`idem-same-${entry.name}`);

    const queue = buildQueue(entry, { connection: producerConnection, prefix });

    let effects = 0;
    const worker = buildWorker(entry, {
      connection: workerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => {
        effects += 1;
      },
    });

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await producerConnection.quit().catch(() => undefined);
      await workerConnection.quit().catch(() => undefined);
    });

    const key = `idem-${entry.name}-same-key`;
    const first = await enqueueJob(queue, entry, jobDataFor(entry, { attempt: 1 }), { idempotencyKey: key, priorityVariant: "scheduled" });
    const second = await enqueueJob(queue, entry, jobDataFor(entry, { attempt: 2 }), { idempotencyKey: key, priorityVariant: "scheduled" });

    // The dedup mechanism returns the SAME underlying job for a colliding key.
    expect(second.id).toBe(first.id);

    await waitFor(() => effects >= 1, { timeoutMs: 15_000, label: `${entry.name} to process the deduplicated job` });
    // Give any wrongly-duplicated second job a chance to also run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(effects).toBe(1);
  }, 30_000);

  it.each(QUEUE_TOPOLOGY)("$name: two DIFFERENT idempotency keys → two effects", async (entry) => {
    const producerConnection = createQueueWorkerConnection(fixture.connectionString);
    const workerConnection = createQueueWorkerConnection(fixture.connectionString);
    const prefix = queueKeyPrefix(`idem-diff-${entry.name}`);

    const queue = buildQueue(entry, { connection: producerConnection, prefix });

    let effects = 0;
    const worker = buildWorker(entry, {
      connection: workerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => {
        effects += 1;
      },
    });

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await producerConnection.quit().catch(() => undefined);
      await workerConnection.quit().catch(() => undefined);
    });

    await enqueueJob(queue, entry, jobDataFor(entry, { i: 1 }), { idempotencyKey: `idem-${entry.name}-key-a`, priorityVariant: "scheduled" });
    await enqueueJob(queue, entry, jobDataFor(entry, { i: 2 }), { idempotencyKey: `idem-${entry.name}-key-b`, priorityVariant: "scheduled" });

    await waitFor(() => effects === 2, { timeoutMs: 15_000, label: `${entry.name} to process both distinct jobs` });

    expect(effects).toBe(2);
  }, 30_000);
});
