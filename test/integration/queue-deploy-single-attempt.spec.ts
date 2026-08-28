import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { attachDeadLetterHandler, buildDlqQueue, type DlqEntry } from "../../src/lib/queue/dead-letter.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { buildWorker } from "../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { TEST_SIGNING_KEYS, fakeClient, jobDataFor, waitFor } from "../support/queue-test-harness.js";

// STORY-030 Phase B / Test scenario 9 — "Fail a deployment job → no
// automatic retry." `deploy.cms` is a deliberate exception to every other
// queue's retry policy: a single ambiguous failure against a customer's
// production site must be looked at by a human, not retried. `capture.plan`
// (documented 3x exp retry) is the negative control in the SAME test file,
// proving the assertion actually distinguishes "no retry" from "just hasn't
// retried yet".

const deployEntry = QUEUE_TOPOLOGY.find((entry) => entry.name === "deploy.cms")!;
const captureEntry = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.plan")!;

describe("STORY-030 · queue-deploy-single-attempt — deploy.cms fails once with no automatic retry", () => {
  let fixture: ValkeyFixture;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(cleanups.map((fn) => fn()));
    await fixture.stop();
  });

  it("deploy.cms: a failing job is invoked exactly once and lands directly in deploy.cms.dlq", async () => {
    const producerConnection = createQueueWorkerConnection(fixture.connectionString);
    const workerConnection = createQueueWorkerConnection(fixture.connectionString);
    const dlqConnection = createQueueWorkerConnection(fixture.connectionString);
    const prefix = queueKeyPrefix("deploy-single-attempt");

    const queue = buildQueue(deployEntry, { connection: producerConnection, prefix });
    const dlqQueue = buildDlqQueue(deployEntry, { connection: dlqConnection, prefix });

    let invocations = 0;
    const worker = buildWorker(deployEntry, {
      connection: workerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => {
        invocations += 1;
        throw new Error("ambiguous failure against the customer's production CMS");
      },
    });
    attachDeadLetterHandler(worker, dlqQueue, deployEntry);

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await dlqQueue.close();
      await Promise.all(
        [producerConnection, workerConnection, dlqConnection].map((connection) => connection.quit().catch(() => undefined)),
      );
    });

    const data = jobDataFor(deployEntry, { probe: "deploy-single-attempt" });
    await enqueueJob(queue, deployEntry, data, { idempotencyKey: "deploy-single-attempt", priorityVariant: "scheduled" });

    await waitFor(async () => (await dlqQueue.count()) >= 1, {
      timeoutMs: 10_000,
      label: "deploy.cms.dlq to receive the failed job",
    });

    // Settle window — a wrongly-configured retry would show up as a second invocation here.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(invocations).toBe(1);

    const dlqJobs = await dlqQueue.getJobs(["waiting", "delayed", "active", "completed"]);
    expect(dlqJobs).toHaveLength(1);
    const dlqEntry = dlqJobs[0]!.data as DlqEntry;
    expect(dlqEntry.attemptsMade).toBe(1);
  }, 20_000);

  it("negative control — capture.plan (documented 3x exp retry) DOES retry after a failure", async () => {
    const producerConnection = createQueueWorkerConnection(fixture.connectionString);
    const workerConnection = createQueueWorkerConnection(fixture.connectionString);
    const dlqConnection = createQueueWorkerConnection(fixture.connectionString);
    const prefix = queueKeyPrefix("deploy-single-attempt-negative-control");

    const queue = buildQueue(captureEntry, { connection: producerConnection, prefix });
    const dlqQueue = buildDlqQueue(captureEntry, { connection: dlqConnection, prefix });

    let invocations = 0;
    const worker = buildWorker(captureEntry, {
      connection: workerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => {
        invocations += 1;
        if (invocations < 2) {
          throw new Error("transient failure — expected to retry");
        }
      },
    });
    attachDeadLetterHandler(worker, dlqQueue, captureEntry);

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await dlqQueue.close();
      await Promise.all(
        [producerConnection, workerConnection, dlqConnection].map((connection) => connection.quit().catch(() => undefined)),
      );
    });

    const data = jobDataFor(captureEntry, { probe: "negative-control" });
    await enqueueJob(queue, captureEntry, data, { idempotencyKey: "deploy-negative-control", priorityVariant: "scheduled" });

    await waitFor(() => invocations >= 2, { timeoutMs: 15_000, label: "capture.plan to retry after its first failure" });

    expect(invocations).toBeGreaterThanOrEqual(2);
    expect(await dlqQueue.count()).toBe(0);
  }, 20_000);
});
