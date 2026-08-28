import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { buildWorker } from "../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { TEST_SIGNING_KEYS, fakeClient, jobDataFor, waitFor } from "../support/queue-test-harness.js";

// STORY-030 AC8 / Test scenario 8 — "Saturate the scheduled pool → interactive
// latency unaffected." system-architecture.md §4: capture.execute is the
// scheduled pool (concurrency 6); lookup.execute ("API (tools)") is the
// interactive pool with its own dedicated concurrency-8 Worker/connection —
// worker-factory.ts builds one Worker per QUEUE_TOPOLOGY entry, each on its
// OWN connection, so lookup.execute never shares a concurrency slot with
// capture.execute's backlog. This proves that structural isolation holds
// under saturation, not just at rest.
//
// A wall-clock ceiling here is deliberately generous (an ordering proof, not
// the k6 p50<=9s SLO) — the real assertion is that the interactive job
// finishes WHILE the scheduled backlog is still draining, never behind it.

const CAPTURE_EXECUTE = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.execute")!;
const LOOKUP_EXECUTE = QUEUE_TOPOLOGY.find((entry) => entry.name === "lookup.execute")!;

const BACKLOG_JOB_MS = 1_500;
const BACKLOG_SIZE = CAPTURE_EXECUTE.concurrency * 3; // 18 — several full batches at the documented concurrency (6)
const INTERACTIVE_LATENCY_CEILING_MS = 3_000; // generous; full backlog drain is ~(18/6)*1500 = 4_500ms+

describe("STORY-030 · capture.execute saturation does not delay lookup.execute (dedicated interactive pool)", () => {
  let fixture: ValkeyFixture;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(cleanups.map((fn) => fn()));
    await fixture.stop();
  });

  it("a saturated capture.execute backlog does not block a concurrently-enqueued lookup.execute job", async () => {
    const prefix = queueKeyPrefix("interactive-pool-isolation");

    const captureProducerConnection = createQueueWorkerConnection(fixture.connectionString);
    const captureWorkerConnection = createQueueWorkerConnection(fixture.connectionString);
    const lookupProducerConnection = createQueueWorkerConnection(fixture.connectionString);
    const lookupWorkerConnection = createQueueWorkerConnection(fixture.connectionString);

    const captureQueue = buildQueue(CAPTURE_EXECUTE, { connection: captureProducerConnection, prefix });
    const lookupQueue = buildQueue(LOOKUP_EXECUTE, { connection: lookupProducerConnection, prefix });

    let captureActive = 0;
    let captureCompleted = 0;
    const captureWorker = buildWorker(CAPTURE_EXECUTE, {
      connection: captureWorkerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => {
        captureActive += 1;
        await new Promise((resolve) => setTimeout(resolve, BACKLOG_JOB_MS));
        captureActive -= 1;
        captureCompleted += 1;
      },
    });

    let lookupCompleted = false;
    const lookupWorker = buildWorker(LOOKUP_EXECUTE, {
      connection: lookupWorkerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => {
        lookupCompleted = true;
      },
    });

    cleanups.push(async () => {
      await captureWorker.close();
      await lookupWorker.close();
      await captureQueue.close();
      await lookupQueue.close();
      await Promise.all(
        [captureProducerConnection, captureWorkerConnection, lookupProducerConnection, lookupWorkerConnection].map((c) =>
          c.quit().catch(() => undefined),
        ),
      );
    });

    // 1. Saturate the scheduled pool — enqueue a backlog well beyond its documented concurrency.
    for (let i = 0; i < BACKLOG_SIZE; i++) {
      await enqueueJob(captureQueue, CAPTURE_EXECUTE, jobDataFor(CAPTURE_EXECUTE, { i }), {
        idempotencyKey: `interactive-isolation-capture-${i}`,
        priorityVariant: "scheduled",
      });
    }

    await waitFor(() => captureActive === CAPTURE_EXECUTE.concurrency, {
      timeoutMs: 10_000,
      label: "capture.execute to reach its documented concurrency (saturated)",
    });

    // 2. While saturated, enqueue and process one interactive job.
    const lookupEnqueuedAt = Date.now();
    await enqueueJob(lookupQueue, LOOKUP_EXECUTE, jobDataFor(LOOKUP_EXECUTE, { probe: "interactive" }), {
      idempotencyKey: "interactive-isolation-lookup-1",
    });

    await waitFor(() => lookupCompleted, {
      timeoutMs: INTERACTIVE_LATENCY_CEILING_MS,
      label: "lookup.execute job to complete without waiting behind the capture.execute backlog",
    });
    const lookupLatencyMs = Date.now() - lookupEnqueuedAt;

    // The ordering proof: the interactive job finished WHILE the scheduled
    // backlog was still draining — never after it, which would mean they
    // shared a pool.
    expect(captureCompleted).toBeLessThan(BACKLOG_SIZE);
    expect(lookupLatencyMs).toBeLessThan(INTERACTIVE_LATENCY_CEILING_MS);

    await waitFor(() => captureCompleted === BACKLOG_SIZE, {
      timeoutMs: 20_000,
      label: "capture.execute backlog to fully drain",
    });
  }, 40_000);
});
