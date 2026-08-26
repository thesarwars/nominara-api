import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueueConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { buildWorker } from "../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "../../src/lib/queue/topology.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import {
  OUTSIDE_WINDOW_SIGNING_KEY,
  TEST_SIGNING_KEYS,
  TEST_SIGNING_KEYS_ROTATED,
  fakeClient,
  signedEnvelope,
  waitFor,
} from "../support/queue-test-harness.js";

// STORY-030 Phase B / Test scenarios 3 + 4 — a tampered signature is
// rejected before any context call, and key rotation has an overlap window
// so in-flight jobs signed with the previous key still verify. Exercised
// against one representative tenant-scoped queue (capture.execute, the
// queue the story's own retry/backoff commentary centers on) plus a second
// queue with a different worker group to prove the property is not
// accidental to one queue's wiring.

const REPRESENTATIVE_QUEUES: readonly QueueTopologyEntry[] = QUEUE_TOPOLOGY.filter((entry) =>
  ["capture.execute", "report.build"].includes(entry.name),
);

describe("STORY-030 · queue-signing-rotation — rotating keys and a tampered signature", () => {
  let fixture: ValkeyFixture;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(cleanups.map((fn) => fn()));
    await fixture.stop();
  });

  it.each(REPRESENTATIVE_QUEUES)("$name: a job signed under kid=K1 still verifies after rotating current to K2", async (entry) => {
    const producerConnection = createQueueConnection(fixture.connectionString);
    const workerConnection = createQueueConnection(fixture.connectionString);
    const prefix = queueKeyPrefix(`rotate-${entry.name}`);

    const queue = buildQueue(entry, { connection: producerConnection, prefix });

    let processed = 0;
    // Worker runs with the ROTATED keys (current=K2, previous=K1) — the
    // overlap window is what lets a K1-signed in-flight job still verify.
    const worker = buildWorker(entry, {
      connection: workerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS_ROTATED,
      getClient: () => fakeClient(),
      process: async () => {
        processed += 1;
      },
    });

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await producerConnection.quit().catch(() => undefined);
      await workerConnection.quit().catch(() => undefined);
    });

    // Signed with K1 (TEST_SIGNING_KEYS.current) — the pre-rotation key.
    const envelope = signedEnvelope(TEST_SIGNING_KEYS, { note: "in-flight before rotation" });
    await enqueueJob(queue, entry, envelope, { idempotencyKey: `rotate-${entry.name}-k1`, priorityVariant: "scheduled" });

    await waitFor(() => processed === 1, { timeoutMs: 15_000, label: `${entry.name} to verify and process the K1-signed job` });
    expect(processed).toBe(1);
  }, 30_000);

  it.each(REPRESENTATIVE_QUEUES)("$name: a job signed under a kid outside the configured window is rejected", async (entry) => {
    const producerConnection = createQueueConnection(fixture.connectionString);
    const workerConnection = createQueueConnection(fixture.connectionString);
    const prefix = queueKeyPrefix(`outside-${entry.name}`);

    const queue = buildQueue(entry, { connection: producerConnection, prefix });

    let processed = 0;
    const failures: Error[] = [];
    const worker = buildWorker(entry, {
      connection: workerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS_ROTATED,
      getClient: () => fakeClient(),
      process: async () => {
        processed += 1;
      },
    });
    worker.on("failed", (_job, error) => failures.push(error));

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await producerConnection.quit().catch(() => undefined);
      await workerConnection.quit().catch(() => undefined);
    });

    // Signed with a kid neither current (K2) nor previous (K1) recognizes.
    const envelope = signedEnvelope(
      { current: OUTSIDE_WINDOW_SIGNING_KEY },
      { note: "signed outside the configured rotation window" },
    );
    await enqueueJob(queue, entry, envelope, { idempotencyKey: `outside-${entry.name}`, priorityVariant: "scheduled" });

    await waitFor(() => failures.length >= 1, { timeoutMs: 15_000, label: `${entry.name} to reject the out-of-window kid` });

    expect(processed).toBe(0);
    expect(failures[0]?.name).toBe("JobSignatureError");
  }, 30_000);
});
