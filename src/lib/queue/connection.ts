import { Redis } from "ioredis";

// STORY-030 Phase B — the queue instance's ioredis connection factory
// (system-architecture.md §11: "Valkey ... two instances" — this is the
// QUEUE one, never the cache one). `maxRetriesPerRequest: null` is
// BullMQ's own documented requirement (https://docs.bullmq.io/guide/connections):
// without it, ioredis gives up retrying a blocking command after its
// default retry budget and BullMQ misreports the failure as a job error
// instead of a connection issue.

/** One ioredis connection per BullMQ Queue/Worker — see queue-factory.ts / worker-factory.ts. Never shared with the cache-instance client. */
export function createQueueConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * BullMQ's own `prefix` option namespaces the whole queue instance per
 * environment (Phase A decision D7) — every Queue/Worker/QueueEvents for a
 * given NODE_ENV shares this prefix, so `development`, `test`, and
 * `production` processes can safely point at the same Valkey deployment
 * without their queues colliding.
 */
export function queueKeyPrefix(nodeEnv: string): string {
  return `nominara-queue-${nodeEnv}`;
}
