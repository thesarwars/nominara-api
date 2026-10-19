import { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";

// STORY-030 AC8 — "an oldest-job-age autoscaling signal" for the interactive pool. system-architecture.md section 4:
// "ECS target-tracking on ... `lookup.execute` oldest-job-age (target < 3 s)".
//
// What exists is the SIGNAL. Nothing reads it yet: there is no metrics backend (the Logger-based counter in
// telemetry/metrics.ts is all there is) and no autoscaler to act on it (STORY-003). It is emitted as one structured log
// line per queue per driver tick, in the same `{ metric, value, ...labels }` shape incrementCounter uses, so a future
// backend can scrape it without this file changing.

const logger = new Logger("metrics");

/**
 * The queues whose waiting time a human is watching. `lookup.execute` is the one documented DEDICATED interactive pool.
 * `capture.execute` also carries an interactive priority variant, but it shares the queue with scheduled work, so its
 * age cannot be attributed to the interactive half, and it autoscales on depth instead (section 4).
 */
export const INTERACTIVE_QUEUES: readonly string[] = ["lookup.execute"];

export const OLDEST_JOB_AGE_METRIC = "nominara_queue_oldest_job_age_seconds";

/**
 * Seconds the NEXT job to run has waited, or `null` when nothing is waiting. `null` and `0` are different answers:
 * an empty queue has no wait, a job enqueued this millisecond has waited 0.
 *
 * Reads only the HEAD of each structure that holds runnable jobs: `waiting` (a list) and `prioritized` (a sorted set;
 * every queue with a priority in topology.ts, lookup.execute included, uses it). Both are first-in-first-out within a
 * priority, and an asc read returns the next job to run. That is what an autoscaler needs (how long the head of the line has
 * waited) but it is NOT strictly the oldest job: a retried job re-enters `prioritized` behind newer ones with a new
 * position and its ORIGINAL timestamp, so it can be older than the head without being read. A `delayed` job is excluded: it is not
 * waiting to run, and a retry carries its original enqueue time, so counting it would report a backoff as a queue stall.
 * The age is measured from the job's enqueue timestamp, so for the job that is read it includes any time that job
 * spent being retried.
 */
export async function oldestWaitingAgeSeconds(queue: Pick<Queue, "getWaiting" | "getPrioritized">, nowMs: number): Promise<number | null> {
  const [waiting, prioritized] = await Promise.all([queue.getWaiting(0, 0), queue.getPrioritized(0, 0)]);
  const stamps = [...waiting, ...prioritized].map((job) => job.timestamp);
  if (stamps.length === 0) return null;
  // Clamped: a producer clock a little ahead of this one must not make a wait negative.
  return Math.max(0, nowMs - Math.min(...stamps)) / 1000;
}

/** A reader over the interactive queues. A queue that cannot be read is left out, never reported as empty: absent is not 0. */
export function queueAgeReader(
  queues: ReadonlyMap<string, Pick<Queue, "getWaiting" | "getPrioritized">>,
  clock: () => number = () => Date.now(),
): () => Promise<ReadonlyMap<string, number | null>> {
  return async () => {
    const ages = new Map<string, number | null>();
    await Promise.all(
      [...queues].map(async ([queueName, queue]) => {
        try {
          ages.set(queueName, await oldestWaitingAgeSeconds(queue, clock()));
        } catch (error) {
          logger.warn(`queue age: could not read "${queueName}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    return ages;
  };
}

/**
 * One structured line per queue. DELIBERATE: an empty queue is emitted as value 0 flagged `empty: true`, because a
 * target-tracking autoscaler needs an input to scale in on ("no wait"); a backend that drops the label cannot tell it from
 * a job that waited 0 s, and that is accepted. Emitted only by the replica that won the tick's election (see
 * monitor-runtime.ts), so the series is not duplicated per replica; the 60 s tick is its sampling interval. Queue name only: no job data, no tenant.
 */
export function emitOldestJobAges(ages: ReadonlyMap<string, number | null>): void {
  for (const [queue, age] of ages) {
    logger.log(age === null ? { metric: OLDEST_JOB_AGE_METRIC, value: 0, queue, empty: true } : { metric: OLDEST_JOB_AGE_METRIC, value: age, queue });
  }
}
