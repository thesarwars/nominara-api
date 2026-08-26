import { Queue, type Job, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { QueueTopologyEntry } from "./topology.js";

// STORY-030 Phase B — builds a real BullMQ Queue from one QUEUE_TOPOLOGY
// entry and wires the documented idempotency key as the job's IDENTITY at
// enqueue time. bullmq@6.2.0 ships two dedup mechanisms on `Queue.add`'s
// options (read from node_modules/.pnpm/.../bullmq/dist/esm/types/job-
// options.d.ts and deduplication-options.d.ts, not guessed):
//   - the legacy `jobId` override: "If you attempt to add a job with an id
//     that already exists, it will not be added" — but once that job is
//     REMOVED (e.g. by `removeOnComplete`), the id becomes reusable and a
//     later add() with the same id silently creates a NEW job. That is
//     exactly the failure mode a "replay after the original finished"
//     idempotency test would hit.
//   - `deduplication: { id, ttl }` (the newer mechanism): keeps a dedup key
//     alive independently of the job's own record for `ttl` milliseconds,
//     so a same-key replay inside that window returns the ORIGINAL job
//     rather than creating a second one. This is the one this module uses,
//     with `ttl` set to the queue's own documented `removeOnComplete.age`
//     (system-architecture.md §4) — a replay stays deduplicated for exactly
//     as long as this queue promises to retain the original job's record.

export interface BuildQueueOptions {
  readonly connection: Redis;
  readonly prefix: string;
}

export function buildQueue(entry: QueueTopologyEntry, options: BuildQueueOptions): Queue {
  return new Queue(entry.name, {
    connection: options.connection,
    prefix: options.prefix,
  });
}

export type PriorityVariant = "scheduled" | "interactive";

export class QueuePriorityVariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueuePriorityVariantError";
  }
}

/**
 * `capture.execute` is the one topology entry with a dual priority
 * (system-architecture.md §4: "5 scheduled / 1 interactive") — every other
 * queue has a single documented number and `variant` is ignored.
 */
export function resolvePriority(entry: QueueTopologyEntry, variant?: PriorityVariant): number {
  if (typeof entry.priority === "number") {
    return entry.priority;
  }
  if (!variant) {
    throw new QueuePriorityVariantError(
      `queue "${entry.name}" has a dual priority — a priorityVariant ("scheduled"|"interactive") is required`,
    );
  }
  return entry.priority[variant];
}

/** attempts = the initial try + every documented retry step. `deploy.cms`'s empty ladder → attempts: 1, i.e. no automatic retry. */
export function attemptsFor(entry: QueueTopologyEntry): number {
  return entry.retry.delaysMs.length + 1;
}

export interface EnqueueOptions {
  readonly idempotencyKey: string;
  readonly priorityVariant?: PriorityVariant;
  /** Overrides the dedup ttl (ms) — tests use a short one; production defaults to the queue's own removeOnComplete.age window. */
  readonly dedupTtlMs?: number;
}

/**
 * Enqueues `data` onto `queue`, wiring `options.idempotencyKey` as the
 * job's deduplication identity and applying this entry's documented
 * concurrency-independent knobs (priority, attempts, retention). Returns
 * the EXISTING job when `idempotencyKey` collides with one already inside
 * its dedup ttl window — never a second job — which is what makes "replay
 * with the same key produces at most one effect" true at the queue layer.
 */
export async function enqueueJob(queue: Queue, entry: QueueTopologyEntry, data: unknown, options: EnqueueOptions): Promise<Job> {
  const jobOptions: JobsOptions = {
    priority: resolvePriority(entry, options.priorityVariant),
    attempts: attemptsFor(entry),
    removeOnComplete: entry.removeOnComplete,
    removeOnFail: entry.removeOnFail,
    deduplication: {
      id: options.idempotencyKey,
      ttl: options.dedupTtlMs ?? entry.removeOnComplete.age * 1000,
    },
  };
  if (entry.retry.delaysMs.length > 0) {
    jobOptions.backoff = { type: "custom" };
  }
  return queue.add(entry.name, data, jobOptions);
}
