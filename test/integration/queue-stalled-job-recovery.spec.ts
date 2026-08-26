import { Queue, Worker, type Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueueConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { waitFor } from "../support/queue-test-harness.js";

// STORY-030 Phase C — "a worker's Valkey connection drops mid-processing."
// This exercises BullMQ's OWN stalled-job detection/recovery (not any
// nominara-api wiring): a Worker renews its job's lock on a background timer
// tied to its own connection; if that connection is gone, the lock cannot be
// renewed and expires. A SECOND worker's periodic stalled-checker (its own
// `stalledInterval` timer, independent of the first worker) then notices the
// lock is gone, requeues the job, and a worker picks it back up.
//
// Read directly from bullmq@6.2.0's own source
// (node_modules/bullmq/dist/cjs/commands/moveStalledJobsToWait-9.lua +
// classes/worker.js) rather than assumed:
//   - Detection takes two stalled-checker passes at minimum: pass 1 marks
//     every currently-active job as a stall CANDIDATE; only if a job is
//     STILL a candidate AND its lock key is missing on pass 2 does it get
//     moved back to `wait`. Worst-case detection latency is therefore
//     ~2 x stalledInterval, not one.
//   - A recovered job is NOT a fresh job: `attemptsStarted` (Redis hash
//     field "ats") is incremented by `prepareJobForProcessing` on EVERY
//     move-to-active, including the recovery re-dequeue — so the second
//     attempt's `attemptsStarted` is strictly greater than the first's, and
//     `attemptsMade` (which only increments on an actual
///    completion/failure, never touched by the stall path) accumulates
//     across recoveries rather than being reset. This is the "counts
//     against the ladder, does not reset it" property.
//   - "Not infinitely re-stalled": the script also HINCRBYs a SEPARATE
//     per-job `stc` (stalled count) field, and once a job's stalled count
//     exceeds `maxStalledCount` (BullMQ's own WorkerOptions, default 1) it
//     is failed outright with reason "job stalled more than allowable
//     limit" rather than requeued again — verified by reading the script
//     (moveStalledJobsToWait-9.lua lines ~74-99), not exercised live here.
//     Deliberately NOT tested end-to-end: reproducing a SECOND stall cycle
//     deterministically would mean killing a second worker mid-recovery and
//     waiting through a second ~2xstalledInterval detection window on top of
//     the first, which multiplies this suite's real-timer flakiness surface
//     for a property BullMQ's own script already encodes unambiguously.
//
// This test proves the ONE cycle that IS practical to reproduce
// deterministically with real timers and a real Valkey: kill worker A's
// connection immediately after it picks up the job (a hard connection drop,
// not a graceful close), and confirm worker B recovers and completes it
// exactly once, with a strictly-incremented attemptsStarted on the recovered
// attempt.

describe("STORY-030 Phase C · stalled-job recovery — a dropped connection mid-processing is recovered exactly once", () => {
  let fixture: ValkeyFixture;

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 60_000);

  afterAll(async () => {
    await fixture.stop();
  });

  it(
    "worker B recovers and completes the job after worker A's connection drops; attemptsStarted strictly increases on the recovered attempt",
    async () => {
      const QUEUE_NAME = "test.stall-recovery";
      const prefix = queueKeyPrefix("stall-recovery");

      const producerConnection = createQueueConnection(fixture.connectionString);
      const queue = new Queue(QUEUE_NAME, { connection: producerConnection, prefix });

      const pickups: number[] = [];
      let workerACaughtJob = false;
      let completedCount = 0;

      const connA = createQueueConnection(fixture.connectionString);
      const workerA = new Worker(
        QUEUE_NAME,
        async (job: Job) => {
          pickups.push(job.attemptsStarted);
          workerACaughtJob = true;
          // Simulate a genuinely dropped connection: worker A can never
          // renew this job's lock or report completion/failure again.
          connA.disconnect();
          return new Promise(() => {
            // never resolves — worker A is gone, from the job's point of view.
          });
        },
        { connection: connA, prefix, concurrency: 1, lockDuration: 500, stalledInterval: 300, autorun: true },
      );
      workerA.on("error", () => {
        // Expected once connA is force-disconnected — never let this crash the test process.
      });

      let workerB: Worker | undefined;
      let connB: ReturnType<typeof createQueueConnection> | undefined;

      try {
        await queue.add(QUEUE_NAME, { probe: true }, { attempts: 2 });

        // Worker B is only started once worker A has already grabbed the
        // job — otherwise A and B would race for the SAME single job and
        // this test would depend on which one happened to win, rather than
        // deterministically exercising the recovery path.
        await waitFor(() => workerACaughtJob, { timeoutMs: 10_000, label: "worker A to pick up the job" });

        connB = createQueueConnection(fixture.connectionString);
        workerB = new Worker(
          QUEUE_NAME,
          async (job: Job) => {
            pickups.push(job.attemptsStarted);
            return "recovered";
          },
          { connection: connB, prefix, concurrency: 1, lockDuration: 500, stalledInterval: 300, autorun: true },
        );
        workerB.on("error", () => undefined);
        workerB.on("completed", () => {
          completedCount += 1;
        });

        await waitFor(() => completedCount === 1, { timeoutMs: 20_000, label: "worker B to recover and complete the job" });

        // Recovered exactly once: worker A's original pickup, worker B's
        // recovery — no more, no fewer.
        expect(pickups).toHaveLength(2);
        expect(pickups[1]).toBeGreaterThan(pickups[0]!);
        expect(completedCount).toBe(1);
      } finally {
        await workerA.close(true).catch(() => undefined);
        await workerB?.close().catch(() => undefined);
        await queue.close();
        await producerConnection.quit().catch(() => undefined);
        await connB?.quit().catch(() => undefined);
      }
    },
    30_000,
  );
});
