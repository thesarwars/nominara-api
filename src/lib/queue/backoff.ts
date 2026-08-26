import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "./topology.js";

// STORY-030 — architecture reference §4's retry-ladder column, resolved to
// a BullMQ-compatible custom backoff strategy. capture.execute is the ONLY
// queue documented with "+ jitter"; edge-cases-and-slos.md EC-06 stage 1
// names the exact algorithm: "retry with exponential backoff 5 s→120 s plus
// full jitter, max 4 attempts" — AWS's Full Jitter (delay = random_between
// (0, base)). Every other queue's backoff is topology.ts's bare delaysMs
// value, unjittered.

export type QueueName = QueueTopologyEntry["name"];

const TOPOLOGY_BY_NAME: ReadonlyMap<QueueName, QueueTopologyEntry> = new Map(
  QUEUE_TOPOLOGY.map((entry) => [entry.name, entry]),
);

const FULL_JITTER_QUEUES: ReadonlySet<QueueName> = new Set<QueueName>(["capture.execute"]);

function topologyEntry(queueName: QueueName): QueueTopologyEntry {
  const entry = TOPOLOGY_BY_NAME.get(queueName);
  if (!entry) {
    throw new Error(`unknown queue "${queueName}"`);
  }
  return entry;
}

export function delaysMsFor(queueName: QueueName): readonly number[] {
  return topologyEntry(queueName).retry.delaysMs;
}

export interface BackoffOptions {
  /** Returns a value in [0, 1) — defaults to Math.random. Injectable for deterministic tests. */
  rng?: () => number;
}

/**
 * BullMQ's custom backoff strategy contract: given the 1-indexed count of
 * attempts made so far, return the delay in ms before the next attempt, or
 * `false` once the ladder is exhausted (BullMQ then moves the job to
 * failed, landing it in its dead-letter queue).
 */
export type BackoffStrategy = (attemptsMade: number) => number | false;

export function createBackoffStrategy(queueName: QueueName, options: BackoffOptions = {}): BackoffStrategy {
  const rng = options.rng ?? Math.random;
  const delays = delaysMsFor(queueName);
  const jitter = FULL_JITTER_QUEUES.has(queueName);

  return (attemptsMade: number): number | false => {
    const index = attemptsMade - 1;
    if (index < 0 || index >= delays.length) {
      return false;
    }

    const base = delays[index]!;
    return jitter ? Math.floor(rng() * base) : base;
  };
}
