import { UnrecoverableError, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { attachDeadLetterHandler, buildDlqQueue, type DlqEntry } from "../../src/lib/queue/dead-letter.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { buildWorker } from "../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "../../src/lib/queue/topology.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { TEST_SIGNING_KEYS, fakeClient, jobDataFor, waitFor } from "../support/queue-test-harness.js";

// ⚠ STORY-154 — THE FAILURES THAT NEVER REACHED THE DEAD-LETTER QUEUE.
//
// test/integration/queue-dead-letter.spec.ts already proved that EXHAUSTING A
// RETRY LADDER lands a job in its DLQ. That was the only terminal shape it
// tested, and the handler's guard — `attemptsMade >= attempts` — was correct
// for exactly that shape, so the suite was green while three other terminal
// paths dropped their entries silently.
//
// The one that mattered: `audit-verify.handler.ts:129` throws
// `UnrecoverableError` when the nightly walk detects an audit-chain tamper.
// Its comment explains the choice — skip the retry ladder, so "ONE walk, ONE
// page and ONE dead-letter entry per day". `UnrecoverableError` is precisely
// what made the count read 1 of 4, so the entry count per day was zero. The
// mechanism chosen to guarantee exactly one entry guaranteed none, and the
// detector's only machine-readable output was thrown away by the listener that
// exists to keep it.
//
// These are the paths that guard could not see, each run against a real
// Valkey and a real BullMQ Worker.
describe("STORY-154 · a terminal failure reaches the DLQ however BullMQ decided it was terminal", () => {
  let fixture: ValkeyFixture;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(cleanups.map((fn) => fn()));
    await fixture.stop();
  });

  const auditVerify = QUEUE_TOPOLOGY.find((entry) => entry.name === "audit.verify")!;

  it("audit.verify is still the multi-attempt, UnrecoverableError-throwing queue this test is about", () => {
    // If the ladder were ever shortened to one attempt, the case below would
    // pass for the wrong reason: the count alone would call it terminal.
    expect(auditVerify.retry.delaysMs.length).toBeGreaterThan(0);
    expect(auditVerify.removeOnFail).toEqual(expect.objectContaining({ age: expect.any(Number) }));
  });

  /** A worker + DLQ pair on its own key prefix, torn down with the suite. */
  function harnessFor(entry: QueueTopologyEntry, label: string, throws: () => unknown) {
    const producerConnection = createQueueWorkerConnection(fixture.connectionString);
    const workerConnection = createQueueWorkerConnection(fixture.connectionString);
    const dlqConnection = createQueueWorkerConnection(fixture.connectionString);
    const prefix = queueKeyPrefix(`s154-${label}`);

    const queue = buildQueue(entry, { connection: producerConnection, prefix });
    const dlqQueue = buildDlqQueue(entry, { connection: dlqConnection, prefix });
    const worker = buildWorker(entry, {
      connection: workerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => {
        throw throws();
      },
    });
    attachDeadLetterHandler(worker, dlqQueue, entry);

    let failedEvents = 0;
    worker.on("failed", () => {
      failedEvents++;
    });

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await dlqQueue.close();
      await Promise.all(
        [producerConnection, workerConnection, dlqConnection].map((c) => c.quit().catch(() => undefined)),
      );
    });

    return { queue, dlqQueue, prefix, events: () => failedEvents };
  }

  it("⚠ THE TAMPER PATH — an UnrecoverableError on attempt 1 of many lands in the DLQ with its payload", async () => {
    const h = harnessFor(auditVerify, "unrecoverable", () => new UnrecoverableError("audit chain mismatch in 1 workspace(s)"));

    await enqueueJob(h.queue, auditVerify, jobDataFor(auditVerify, { probe: "s154-unrecoverable" }), {
      idempotencyKey: "s154-unrecoverable",
      priorityVariant: "scheduled",
    });

    await waitFor(async () => (await h.dlqQueue.count()) >= 1, {
      timeoutMs: 20_000,
      label: "audit.verify.dlq to receive the UnrecoverableError job — the tamper alarm's only output",
    });

    const dlqJobs = await h.dlqQueue.getJobs(["waiting", "delayed", "active", "completed"]);
    expect(dlqJobs).toHaveLength(1);
    const written = dlqJobs[0]!.data as DlqEntry;
    expect(written.queue).toBe("audit.verify");
    expect(written.error.name).toBe("UnrecoverableError");
    expect(written.error.message).toContain("audit chain mismatch");
    expect(written.payload).toMatchObject({ probe: "s154-unrecoverable" });

    // ⚠ The count the old guard read, recorded so the regression is legible:
    // one attempt of a four-attempt ladder. `attemptsMade < attempts` was true,
    // and the entry above is the one it discarded.
    expect(written.attemptsMade).toBeLessThan(auditVerify.retry.delaysMs.length + 1);
    expect(h.events()).toBe(1); // no retry ladder was walked — one event, one entry
  }, 30_000);

  it("⚠ a duck-typed UnrecoverableError — name only, no instanceof — lands in the DLQ too", async () => {
    // This is the shape that survives a serialization boundary, where
    // `instanceof` does not. BullMQ treats it identically (job.js:448).
    const h = harnessFor(auditVerify, "ducktyped", () => {
      const error = new Error("tamper, re-thrown across a boundary");
      error.name = "UnrecoverableError";
      return error;
    });

    await enqueueJob(h.queue, auditVerify, jobDataFor(auditVerify, { probe: "s154-ducktyped" }), {
      idempotencyKey: "s154-ducktyped",
      priorityVariant: "scheduled",
    });

    await waitFor(async () => (await h.dlqQueue.count()) >= 1, {
      timeoutMs: 20_000,
      label: "audit.verify.dlq to receive the duck-typed UnrecoverableError job",
    });

    const written = (await h.dlqQueue.getJobs(["waiting", "delayed", "active", "completed"]))[0]!.data as DlqEntry;
    expect(written.error.name).toBe("UnrecoverableError");
    expect(written.payload).toMatchObject({ probe: "s154-ducktyped" });
    expect(h.events()).toBe(1);
  }, 30_000);

  it("⚠ a backoff strategy returning -1 lands in the DLQ — the sentinel worker-factory.ts returns by design", async () => {
    // `adaptBackoffStrategy` translates the backoff ladder's exhausted sentinel
    // into BullMQ's -1. Its own comment calls that defense-in-depth rather than
    // the normal path — but defense-in-depth that silently destroys the record
    // is not defense. Driven here with a raw Worker, because reaching it
    // through buildWorker requires the ladder and `attempts` to disagree.
    const connection = createQueueWorkerConnection(fixture.connectionString);
    const dlqConnection = createQueueWorkerConnection(fixture.connectionString);
    const producerConnection = createQueueWorkerConnection(fixture.connectionString);
    const prefix = queueKeyPrefix("s154-backoff");
    const queue = buildQueue(auditVerify, { connection: producerConnection, prefix });
    const dlqQueue = buildDlqQueue(auditVerify, { connection: dlqConnection, prefix });

    let failedEvents = 0;
    const worker = new Worker(
      auditVerify.name,
      async () => {
        throw new Error("ordinary failure, but the ladder says stop");
      },
      { connection, prefix, settings: { backoffStrategy: () => -1 } },
    );
    attachDeadLetterHandler(worker, dlqQueue, auditVerify);
    worker.on("failed", () => {
      failedEvents++;
    });
    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await dlqQueue.close();
      await Promise.all([connection, dlqConnection, producerConnection].map((c) => c.quit().catch(() => undefined)));
    });

    await queue.add(auditVerify.name, { probe: "s154-backoff" }, { attempts: 4, backoff: { type: "custom" } });

    await waitFor(async () => (await dlqQueue.count()) >= 1, {
      timeoutMs: 20_000,
      label: "audit.verify.dlq to receive the backoff--1 job",
    });

    const written = (await dlqQueue.getJobs(["waiting", "delayed", "active", "completed"]))[0]!.data as DlqEntry;
    expect(written.payload).toMatchObject({ probe: "s154-backoff" });
    expect(written.attemptsMade).toBe(1); // of 4 — invisible to the old guard
    expect(failedEvents).toBe(1);
  }, 30_000);

  it("a job with retries left writes NOTHING until the ladder is actually spent — exactly one entry, not one per attempt", async () => {
    // The other direction, and the reason the fix is a predicate rather than
    // "always write": a DLQ that records every attempt is a DLQ nobody reads.
    const h = harnessFor(auditVerify, "ladder", () => new Error("ordinary transient failure"));
    const expectedAttempts = auditVerify.retry.delaysMs.length + 1;

    await enqueueJob(h.queue, auditVerify, jobDataFor(auditVerify, { probe: "s154-ladder" }), {
      idempotencyKey: "s154-ladder",
      priorityVariant: "scheduled",
    });

    await waitFor(async () => h.events() >= expectedAttempts, {
      timeoutMs: 40_000,
      label: `audit.verify to walk all ${String(expectedAttempts)} attempts`,
    });
    // Settle past the last event so a stray second write would be observed.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(h.events()).toBe(expectedAttempts);
    expect(await h.dlqQueue.count()).toBe(1);
    const written = (await h.dlqQueue.getJobs(["waiting", "delayed", "active", "completed"]))[0]!.data as DlqEntry;
    expect(written.attemptsMade).toBe(expectedAttempts);
  }, 60_000);
});
