import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueueConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { buildWorker } from "../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { TEST_SIGNING_KEYS, fakeClient, jobDataFor, waitFor } from "../support/queue-test-harness.js";

// STORY-030 Phase B / Test scenario 1 — "Enqueue and process each queue's
// job → success with the documented concurrency." Table-driven over all 21
// QUEUE_TOPOLOGY entries against a REAL Valkey (testcontainers), asserting
// PEAK in-flight jobs equals the documented concurrency exactly (enqueuing
// concurrency+2 jobs so the ceiling is actually reached, not just never
// exceeded).

describe("STORY-030 · queue-topology — every queue processes at exactly its documented concurrency", () => {
  let fixture: ValkeyFixture;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(cleanups.map((fn) => fn()));
    await fixture.stop();
  });

  it.each(QUEUE_TOPOLOGY)("$name processes at exactly its documented concurrency ($concurrency)", async (entry) => {
    const producerConnection = createQueueConnection(fixture.connectionString);
    const workerConnection = createQueueConnection(fixture.connectionString);
    const prefix = queueKeyPrefix(`topology-${entry.name}`);

    const queue = buildQueue(entry, { connection: producerConnection, prefix });

    let inFlight = 0;
    let peak = 0;
    let completed = 0;
    const jobCount = entry.concurrency + 2;

    const worker = buildWorker(entry, {
      connection: workerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 150));
        inFlight -= 1;
        completed += 1;
      },
    });

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await producerConnection.quit().catch(() => undefined);
      await workerConnection.quit().catch(() => undefined);
    });

    for (let i = 0; i < jobCount; i++) {
      await enqueueJob(queue, entry, jobDataFor(entry, { i }), {
        idempotencyKey: `topology-${entry.name}-${i}`,
        priorityVariant: "scheduled",
      });
    }

    await waitFor(() => completed === jobCount, { timeoutMs: 20_000, label: `${entry.name} to finish ${jobCount} jobs` });

    expect(peak).toBe(entry.concurrency);
  }, 30_000);
});
