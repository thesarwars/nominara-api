import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { attachDeadLetterHandler, buildDlqQueue, dlqEntrySchema } from "../../src/lib/queue/dead-letter.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { buildWorker } from "../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "../../src/lib/queue/topology.js";
import type { QueueJobEnvelope, TenantScopedPayload } from "../../src/lib/queue/envelope.js";
import { AdminService, DlqReplayError } from "../../src/modules/admin/admin.service.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import {
  OUTSIDE_WINDOW_SIGNING_KEY,
  TEST_SIGNING_KEYS,
  TEST_SIGNING_KEYS_ROTATED,
  fakeClient,
  jobDataFor,
  signedEnvelope,
  waitFor,
} from "../support/queue-test-harness.js";

// STORY-030 AC7 / Test scenario 7 — "Replay from the administrative surface
// → New suffix; no key collision." AdminController's HTTP surface is out of
// scope (D9 — needs an IP allow-list + step-up guard, a separate future
// story); this proves AdminService.replayDeadLetterJob at the service level
// against a real Valkey.

const ENTRY: QueueTopologyEntry = QUEUE_TOPOLOGY.find((candidate) => candidate.name === "capture.plan")!;
const NON_TENANT_ENTRY: QueueTopologyEntry = QUEUE_TOPOLOGY.find((candidate) => candidate.name === "credit.reconcile")!;

async function driveJobToDlq(options: {
  entry: QueueTopologyEntry;
  connectionString: string;
  prefix: string;
  data: unknown;
  idempotencyKey: string;
}) {
  const producerConnection = createQueueWorkerConnection(options.connectionString);
  const workerConnection = createQueueWorkerConnection(options.connectionString);
  const dlqConnection = createQueueWorkerConnection(options.connectionString);

  const queue = buildQueue(options.entry, { connection: producerConnection, prefix: options.prefix });
  const dlqQueue = buildDlqQueue(options.entry, { connection: dlqConnection, prefix: options.prefix });

  const worker = buildWorker(options.entry, {
    connection: workerConnection,
    prefix: options.prefix,
    keys: TEST_SIGNING_KEYS,
    getClient: () => fakeClient(),
    process: async () => {
      throw new Error(`STORY-030 admin-replay test — ${options.entry.name} always fails`);
    },
  });
  attachDeadLetterHandler(worker, dlqQueue, options.entry);

  await enqueueJob(queue, options.entry, options.data, {
    idempotencyKey: options.idempotencyKey,
    priorityVariant: "scheduled",
  });

  await waitFor(async () => (await dlqQueue.count()) >= 1, {
    timeoutMs: 20_000,
    label: `${options.entry.name}.dlq to receive the terminally-failed job`,
  });

  const dlqJobs = await dlqQueue.getJobs(["waiting", "delayed", "active", "completed"]);
  const dlqJob = dlqJobs[0]!;

  return {
    queue,
    dlqQueue,
    dlqJob,
    async cleanup() {
      await worker.close();
      await queue.close();
      await dlqQueue.close();
      await Promise.all(
        [producerConnection, workerConnection, dlqConnection].map((connection) => connection.quit().catch(() => undefined)),
      );
    },
  };
}

/**
 * Drives a job whose ORIGINAL failure is a real `JobSignatureError` — signed
 * with a kid outside the worker's configured rotation window, so
 * `createJobProcessor`/`rotatingHmacJobVerifier` reject it BEFORE `process`
 * ever runs (ISO-11's verify-before-context ordering, exercised through the
 * REAL worker path — never a plain `throw new Error(...)` standing in for
 * it). `process` here must never be observed to run.
 */
async function driveTamperedJobToDlq(options: {
  entry: QueueTopologyEntry;
  connectionString: string;
  prefix: string;
  idempotencyKey: string;
}) {
  const producerConnection = createQueueWorkerConnection(options.connectionString);
  const workerConnection = createQueueWorkerConnection(options.connectionString);
  const dlqConnection = createQueueWorkerConnection(options.connectionString);

  const queue = buildQueue(options.entry, { connection: producerConnection, prefix: options.prefix });
  const dlqQueue = buildDlqQueue(options.entry, { connection: dlqConnection, prefix: options.prefix });

  let processCalled = false;
  const worker = buildWorker(options.entry, {
    connection: workerConnection,
    prefix: options.prefix,
    keys: TEST_SIGNING_KEYS,
    getClient: () => fakeClient(),
    process: async () => {
      processCalled = true;
    },
  });
  attachDeadLetterHandler(worker, dlqQueue, options.entry);

  // Signed with a kid neither TEST_SIGNING_KEYS' current nor previous
  // recognizes — the exact poisoning technique queue-signing-rotation.spec.ts
  // uses to prove ISO-11's ordering; a poisoned entry, not a business-logic failure.
  const envelope = signedEnvelope({ current: OUTSIDE_WINDOW_SIGNING_KEY }, { probe: "tampered" });
  await enqueueJob(queue, options.entry, envelope, {
    idempotencyKey: options.idempotencyKey,
    priorityVariant: "scheduled",
  });

  await waitFor(async () => (await dlqQueue.count()) >= 1, {
    timeoutMs: 20_000,
    label: `${options.entry.name}.dlq to receive the tampered-signature job`,
  });

  const dlqJobs = await dlqQueue.getJobs(["waiting", "delayed", "active", "completed"]);
  const dlqJob = dlqJobs[0]!;

  return {
    queue,
    dlqQueue,
    dlqJob,
    processCalled: () => processCalled,
    async cleanup() {
      await worker.close();
      await queue.close();
      await dlqQueue.close();
      await Promise.all(
        [producerConnection, workerConnection, dlqConnection].map((connection) => connection.quit().catch(() => undefined)),
      );
    },
  };
}

describe("STORY-030 · AdminService.replayDeadLetterJob — administrative DLQ replay", () => {
  let fixture: ValkeyFixture;
  let lockConnection: Redis;
  const cleanups: Array<() => Promise<void>> = [];
  const admin = new AdminService();

  beforeAll(async () => {
    fixture = await startValkeyFixture();
    lockConnection = createQueueWorkerConnection(fixture.connectionString);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(cleanups.map((fn) => fn()));
    await lockConnection.quit().catch(() => undefined);
    await fixture.stop();
  });

  it("re-signs under the current key with a new idempotency suffix, and the replayed job actually runs", async () => {
    const prefix = queueKeyPrefix("admin-replay-tenant");
    const originalKey = "cap:proj-a:widget-launch:run-1";
    const drive = await driveJobToDlq({
      entry: ENTRY,
      connectionString: fixture.connectionString,
      prefix,
      data: jobDataFor(ENTRY, { probe: "admin-replay" }),
      idempotencyKey: originalKey,
    });
    cleanups.push(drive.cleanup);

    const dlqEntryBefore = dlqEntrySchema.parse(drive.dlqJob.data);
    expect(dlqEntryBefore.idempotencyKey).toBe(originalKey);
    expect(dlqEntryBefore.replayedAt).toBeUndefined();

    // A second, independent worker on the ORIGINAL queue, keyed to the
    // ROTATED keys (current = k2, previous = k1) — proves the replayed
    // payload was re-signed under the CURRENT key, not merely re-enqueued
    // with its stale signature.
    let processedCount = 0;
    let processedKid: string | undefined;
    const replayWorkerConnection = createQueueWorkerConnection(fixture.connectionString);
    const replayWorker = buildWorker(ENTRY, {
      connection: replayWorkerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS_ROTATED,
      getClient: () => fakeClient(),
      process: async (_tx, job) => {
        processedCount += 1;
        processedKid = (job.data as QueueJobEnvelope<TenantScopedPayload>).payload.kid;
      },
    });
    cleanups.push(async () => {
      await replayWorker.close();
      await replayWorkerConnection.quit().catch(() => undefined);
    });

    const replayedJob = await admin.replayDeadLetterJob({
      dlqQueue: drive.dlqQueue,
      targetQueue: drive.queue,
      entry: ENTRY,
      jobId: String(drive.dlqJob.id),
      keys: TEST_SIGNING_KEYS_ROTATED,
      connection: lockConnection,
    });

    expect(replayedJob.deduplicationId).not.toBe(originalKey);
    // Exact `{original}:replay:{suffix}` shape — idempotency.ts's withReplaySuffix, never a hand-rolled variant.
    expect(replayedJob.deduplicationId).toMatch(new RegExp(`^${originalKey}:replay:.+$`));

    await waitFor(() => processedCount >= 1, { timeoutMs: 15_000, label: "replayed job to be processed" });
    expect(processedCount).toBe(1);
    expect(processedKid).toBe(TEST_SIGNING_KEYS_ROTATED.current.kid);

    const dlqEntryAfter = dlqEntrySchema.parse((await drive.dlqQueue.getJob(String(drive.dlqJob.id)))!.data);
    expect(dlqEntryAfter.replayedAt).toBeTruthy();
  }, 30_000);

  it("replaying the same DLQ entry a second time is blocked, never silently producing a second effect", async () => {
    const prefix = queueKeyPrefix("admin-replay-blocked");
    const originalKey = "cap:proj-b:widget-launch:run-1";
    const drive = await driveJobToDlq({
      entry: ENTRY,
      connectionString: fixture.connectionString,
      prefix,
      data: jobDataFor(ENTRY, { probe: "admin-replay-blocked" }),
      idempotencyKey: originalKey,
    });
    cleanups.push(drive.cleanup);

    await admin.replayDeadLetterJob({
      dlqQueue: drive.dlqQueue,
      targetQueue: drive.queue,
      entry: ENTRY,
      jobId: String(drive.dlqJob.id),
      keys: TEST_SIGNING_KEYS,
      connection: lockConnection,
    });

    await expect(
      admin.replayDeadLetterJob({
        dlqQueue: drive.dlqQueue,
        targetQueue: drive.queue,
        entry: ENTRY,
        jobId: String(drive.dlqJob.id),
        keys: TEST_SIGNING_KEYS,
        connection: lockConnection,
      }),
    ).rejects.toBeInstanceOf(DlqReplayError);

    const counts = await drive.queue.getJobCounts("waiting", "active", "delayed", "completed");
    const total = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) + (counts.completed ?? 0);
    expect(total).toBe(1);
  }, 30_000);

  it("the replay is never deduplicated against the original job's now-consumed idempotency key", async () => {
    const prefix = queueKeyPrefix("admin-replay-no-dedup");
    const originalKey = "cap:proj-c:widget-launch:run-1";
    const drive = await driveJobToDlq({
      entry: ENTRY,
      connectionString: fixture.connectionString,
      prefix,
      data: jobDataFor(ENTRY, { probe: "admin-replay-no-dedup" }),
      idempotencyKey: originalKey,
    });
    cleanups.push(drive.cleanup);

    const replayedJob = await admin.replayDeadLetterJob({
      dlqQueue: drive.dlqQueue,
      targetQueue: drive.queue,
      entry: ENTRY,
      jobId: String(drive.dlqJob.id),
      keys: TEST_SIGNING_KEYS,
      connection: lockConnection,
    });

    // If the replay had (wrongly) reused the original key, this would
    // collide with the DEDUP entry the now-failed original job left behind
    // and return that SAME stale job rather than actually enqueuing.
    const attemptedReuse = await enqueueJob(drive.queue, ENTRY, jobDataFor(ENTRY, { probe: "reuse-attempt" }), {
      idempotencyKey: originalKey,
      priorityVariant: "scheduled",
    });

    expect(attemptedReuse.id).not.toBe(replayedJob.id);
  }, 30_000);

  it("a non-tenant-scoped queue's DLQ entry replays with its payload passed through unchanged (no signing envelope)", async () => {
    const prefix = queueKeyPrefix("admin-replay-non-tenant");
    const originalKey = "creditrec:bucket-1";
    const drive = await driveJobToDlq({
      entry: NON_TENANT_ENTRY,
      connectionString: fixture.connectionString,
      prefix,
      data: jobDataFor(NON_TENANT_ENTRY, { probe: "non-tenant-replay" }),
      idempotencyKey: originalKey,
    });
    cleanups.push(drive.cleanup);

    let processedCount = 0;
    let processedPayload: unknown;
    const replayWorkerConnection = createQueueWorkerConnection(fixture.connectionString);
    const replayWorker = buildWorker(NON_TENANT_ENTRY, {
      connection: replayWorkerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async (_tx, job) => {
        processedCount += 1;
        processedPayload = job.data;
      },
    });
    cleanups.push(async () => {
      await replayWorker.close();
      await replayWorkerConnection.quit().catch(() => undefined);
    });

    const replayedJob = await admin.replayDeadLetterJob({
      dlqQueue: drive.dlqQueue,
      targetQueue: drive.queue,
      entry: NON_TENANT_ENTRY,
      jobId: String(drive.dlqJob.id),
      keys: TEST_SIGNING_KEYS,
      connection: lockConnection,
    });

    expect(replayedJob.deduplicationId).not.toBe(originalKey);

    await waitFor(() => processedCount >= 1, { timeoutMs: 15_000, label: "replayed non-tenant job to be processed" });
    expect(processedPayload).toEqual({ probe: "non-tenant-replay" });
  }, 30_000);

  it("a jobId with no corresponding DLQ entry throws rather than silently no-op-ing", async () => {
    const prefix = queueKeyPrefix("admin-replay-missing");
    const dlqConnection = createQueueWorkerConnection(fixture.connectionString);
    const producerConnection = createQueueWorkerConnection(fixture.connectionString);
    const dlqQueue = buildDlqQueue(ENTRY, { connection: dlqConnection, prefix });
    const targetQueue = buildQueue(ENTRY, { connection: producerConnection, prefix });
    cleanups.push(async () => {
      await dlqQueue.close();
      await targetQueue.close();
      await Promise.all([dlqConnection, producerConnection].map((c) => c.quit().catch(() => undefined)));
    });

    await expect(
      admin.replayDeadLetterJob({
        dlqQueue,
        targetQueue,
        entry: ENTRY,
        jobId: "does-not-exist",
        keys: TEST_SIGNING_KEYS,
        connection: lockConnection,
      }),
    ).rejects.toBeInstanceOf(DlqReplayError);
  }, 15_000);

  it("BLOCKING (code review) — a DLQ entry whose original failure was a signature-verification error is refused, never re-signed and laundered", async () => {
    const prefix = queueKeyPrefix("admin-replay-poisoned");
    const drive = await driveTamperedJobToDlq({
      entry: ENTRY,
      connectionString: fixture.connectionString,
      prefix,
      idempotencyKey: "cap:proj-poisoned:widget-launch:run-1",
    });
    cleanups.push(drive.cleanup);

    const dlqEntry = dlqEntrySchema.parse(drive.dlqJob.data);
    expect(dlqEntry.error.name).toBe("JobSignatureError");
    expect(drive.processCalled()).toBe(false);

    await expect(
      admin.replayDeadLetterJob({
        dlqQueue: drive.dlqQueue,
        targetQueue: drive.queue,
        entry: ENTRY,
        jobId: String(drive.dlqJob.id),
        keys: TEST_SIGNING_KEYS,
        connection: lockConnection,
      }),
    ).rejects.toBeInstanceOf(DlqReplayError);

    // Nothing was enqueued onto the target queue — the poisoned payload was
    // never re-signed, never given a clean bill of health.
    const counts = await drive.queue.getJobCounts("waiting", "active", "delayed", "completed", "prioritized");
    const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    expect(total).toBe(0);

    // The entry itself is untouched — not silently marked replayed either.
    const dlqEntryAfter = dlqEntrySchema.parse((await drive.dlqQueue.getJob(String(drive.dlqJob.id)))!.data);
    expect(dlqEntryAfter.replayedAt).toBeUndefined();
  }, 30_000);

  it("SHOULD-FIX (code review) — two concurrent replays of the SAME DLQ entry: exactly one succeeds, the other is refused", async () => {
    const prefix = queueKeyPrefix("admin-replay-concurrent");
    const originalKey = "cap:proj-d:widget-launch:run-1";
    const drive = await driveJobToDlq({
      entry: ENTRY,
      connectionString: fixture.connectionString,
      prefix,
      data: jobDataFor(ENTRY, { probe: "admin-replay-concurrent" }),
      idempotencyKey: originalKey,
    });
    cleanups.push(drive.cleanup);

    const attempt = () =>
      admin.replayDeadLetterJob({
        dlqQueue: drive.dlqQueue,
        targetQueue: drive.queue,
        entry: ENTRY,
        jobId: String(drive.dlqJob.id),
        keys: TEST_SIGNING_KEYS,
        connection: lockConnection,
      });

    const results = await Promise.allSettled([attempt(), attempt()]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DlqReplayError);

    const counts = await drive.queue.getJobCounts("waiting", "active", "delayed", "completed", "prioritized");
    const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    expect(total).toBe(1);
  }, 30_000);
});
