import { Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePlanJobSchema } from "../../contracts/tracking/capture-plan-job.schema.js";
import { loadEnv } from "../../src/config/env.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-A-13 AC1 (Option A: in-process runtime in the capture worker) — the sweep
// is wired for WORKER_GROUP=capture and for no other group. Wiring presence only;
// the sweep itself is capture-scheduler-sweep.spec.ts and the :05 UTC timing is
// test/unit/capture-scheduler-sweep.spec.ts. A fake DATABASE_URL is safe: the
// first tick is armed for the next :05 UTC and the app is closed before then.

describe("NEW-A-13 · bootstrapWorker wires the scheduler sweep ONLY for WORKER_GROUP=capture", () => {
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
  });

  it("NEW-A-13 AC1 · WORKER_GROUP=capture starts the sweep, exposed via CAPTURE_SCHEDULER_SWEEP", async () => {
    process.env.WORKER_GROUP = "capture";
    const { bootstrapWorker, CAPTURE_SCHEDULER_SWEEP } = await import("../../src/worker.js");

    const app = await bootstrapWorker();
    try {
      expect(app.get(CAPTURE_SCHEDULER_SWEEP)).toBeDefined();
    } finally {
      await app.close();
    }
  }, 20_000);

  // CHECKPOINT-3 major: deleting `sweepRuntime.start()` from worker.ts left every
  // test green, and the AC3 spec ran its own copy of the enqueue closure. These two
  // tests are the ones that fail when the production wiring is wrong.
  it("NEW-A-13 CP3-4a · the capture worker's sweep timer is ARMED (start() was called), not merely constructed", async () => {
    process.env.WORKER_GROUP = "capture";
    const { bootstrapWorker, CAPTURE_SCHEDULER_SWEEP } = await import("../../src/worker.js");

    const app = await bootstrapWorker();
    try {
      const holder = app.get(CAPTURE_SCHEDULER_SWEEP) as { runtime: { armed: boolean } };
      expect(holder.runtime.armed).toBe(true);
    } finally {
      await app.close();
    }
  }, 20_000);

  it("NEW-A-13 CP3-4b · the PRODUCTION enqueue closure puts one signed capture.plan job per run key on the capture.plan queue, and the same key adds no second job", async () => {
    process.env.WORKER_GROUP = "capture";
    const { bootstrapWorker, CAPTURE_SCHEDULER_SWEEP } = await import("../../src/worker.js");

    const app = await bootstrapWorker();
    const connection = createQueueWorkerConnection(fixture.connectionString);
    const reader = new Queue("capture.plan", { connection, prefix: queueKeyPrefix(loadEnv().NODE_ENV) });
    try {
      // The capture group's own worker consumes capture.plan in this process (and
      // fails it against the fake database, then retries), so a job moves between
      // states. Count it wherever it is, by id.
      const allJobs = async () => {
        const found = await reader.getJobs(["waiting", "prioritized", "delayed", "active", "completed", "failed"]);
        return [...new Map(found.map((job) => [job.id, job])).values()];
      };
      const holder = app.get(CAPTURE_SCHEDULER_SWEEP) as {
        runtime: { enqueue: (job: { workspaceId: string; projectId: string; idempotencyKey: string }) => Promise<void> };
      };
      const workspaceId = "0192f0a0-0000-7000-8000-000000000001";
      const projectId = "0192f0a0-0000-7000-8000-000000000002";
      const job = { workspaceId, projectId, idempotencyKey: `run:${projectId}:2026-10-08T10:00:00.000Z` };
      await holder.runtime.enqueue(job);
      await holder.runtime.enqueue(job);

      const jobs = await allJobs();
      expect(jobs, "one job on capture.plan; a per-call random key would make two").toHaveLength(1);
      const envelope = jobs[0]!.data as { payload: Record<string, unknown>; signature: string };
      expect(typeof envelope.signature).toBe("string");
      expect(envelope.signature.length).toBeGreaterThan(0);
      expect(capturePlanJobSchema.parse(envelope.payload)).toMatchObject({ workspaceId, projectId, trigger: "scheduled" });

      await holder.runtime.enqueue({ ...job, idempotencyKey: `run:${projectId}:2026-10-08T11:00:00.000Z` });
      expect(await allJobs(), "a new next_run_at is a new key").toHaveLength(2);
    } finally {
      await reader.close();
      connection.disconnect();
      await app.close();
    }
  }, 30_000);

  // STORY-077 review round 2 (major): the downgrade-notice relay rides the capture sweep's tick. The production closure
  // must put a SIGNED tenant job on billing.downgrade_notice (consumed by the rollup group), carrying the notice id only.
  it("STORY-077 · the PRODUCTION downgrade-notice enqueuer puts one signed billing.downgrade_notice job per key", async () => {
    process.env.WORKER_GROUP = "capture";
    const { bootstrapWorker, CAPTURE_SCHEDULER_SWEEP } = await import("../../src/worker.js");

    const app = await bootstrapWorker();
    const connection = createQueueWorkerConnection(fixture.connectionString);
    const reader = new Queue("billing.downgrade_notice", { connection, prefix: queueKeyPrefix(loadEnv().NODE_ENV) });
    try {
      const holder = app.get(CAPTURE_SCHEDULER_SWEEP) as {
        runtime: { enqueueDowngradeNotice?: (queue: "billing.downgrade_notice", workspaceId: string, payload: { noticeId: string }, options: { idempotencyKey: string }) => Promise<unknown> };
      };
      expect(holder.runtime.enqueueDowngradeNotice, "the capture worker wires the relay's enqueuer").toBeDefined();
      const workspaceId = "0192f0a0-0000-7000-8000-000000000001";
      const noticeId = "0192f0a0-0000-7000-8000-000000000003";
      await holder.runtime.enqueueDowngradeNotice!("billing.downgrade_notice", workspaceId, { noticeId }, { idempotencyKey: `dgnotice:${workspaceId}:abc:paused` });
      await holder.runtime.enqueueDowngradeNotice!("billing.downgrade_notice", workspaceId, { noticeId }, { idempotencyKey: `dgnotice:${workspaceId}:abc:paused` });
      const jobs = await reader.getJobs(["waiting", "prioritized", "delayed", "active", "completed", "failed"]);
      expect(jobs, "the same key adds no second job").toHaveLength(1);
      const envelope = jobs[0]!.data as { payload: Record<string, unknown>; signature: string };
      expect(envelope.signature.length).toBeGreaterThan(0);
      expect(envelope.payload).toMatchObject({ workspaceId, noticeId });
    } finally {
      await reader.close();
      connection.disconnect();
      await app.close();
    }
  }, 30_000);

  it.each(["parse", "crawl", "embed", "rollup", "report", "deploy"])(
    "NEW-A-13 AC1 · WORKER_GROUP=%s never starts a scheduler sweep",
    async (group) => {
      process.env.WORKER_GROUP = group;
      const { bootstrapWorker, CAPTURE_SCHEDULER_SWEEP } = await import("../../src/worker.js");

      const app = await bootstrapWorker();
      try {
        expect(() => app.get(CAPTURE_SCHEDULER_SWEEP)).toThrow();
      } finally {
        await app.close();
      }
    },
    20_000,
  );
});
