import { Redis } from "ioredis";

// STORY-030 Phase B — the queue instance's ioredis connections
// (system-architecture.md §11: "Valkey ... two instances" — this is the QUEUE
// one, never the cache one).
//
// TWO FACTORIES, BECAUSE THERE ARE TWO ROLES WITH OPPOSITE REQUIREMENTS.
//
// There was one, `createQueueConnection`, and it was named for neither. It
// gave everyone the WORKER's connection, which is correct for a worker and
// silently wrong for anything that reads: `/health/ready` hung instead of
// failing, confirmed in docker compose with the container sitting unhealthy
// and no HTTP response at all. STORY-120 put a deadline in the health service
// so the probe could answer; this fixes the reason it could not.
//
// The old name is deliberately not reused for either factory. A call site
// that still says `createQueueConnection` should fail to compile rather than
// quietly keep whichever meaning it had.

/**
 * For a BullMQ Queue, Worker or QueueEvents.
 *
 * `maxRetriesPerRequest: null` is BullMQ's own documented requirement
 * (https://docs.bullmq.io/guide/connections): without it ioredis abandons a
 * blocking command after its default budget and BullMQ misreports the
 * connection problem as a JOB failure — which sends a perfectly good payload
 * down its retry ladder and eventually to the dead-letter queue, as though
 * the work were bad. Never bound this. If a worker cannot reach the queue,
 * the right behaviour is to keep trying, not to invent job failures.
 */
export function createQueueWorkerConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * For anything that ASKS the queue a question and must answer someone —
 * queue depth on the health probe, an admin read, an operator tool.
 *
 * The opposite requirement, for the opposite reason. A reader that inherits
 * the worker's forever-retry does not fail slowly against an unreachable
 * instance; it does not fail at all. The command never rejects and never
 * resolves, so there is nothing to catch, nothing to log, and nothing to
 * report — the caller simply never hears back. A probe that cannot answer is
 * worse than one that answers 503, because an orchestrator sees a timeout
 * rather than a reason.
 *
 * Mirrors `createHealthCacheConnection` in health.module.ts, which got this
 * right for the cache instance and was never carried across to the queue one.
 */
export function createQueueReaderConnection(url: string): Redis {
  const redis = new Redis(url, {
    // Do not connect merely by constructing — the caller decides when.
    lazyConnect: true,
    connectTimeout: 500,
    // One retry, then give up and surface the error. Bounded is the point.
    retryStrategy: (times) => (times > 1 ? null : 200),
    maxRetriesPerRequest: 1,
  });
  redis.on("error", () => {
    // Swallowed deliberately: every read through this connection handles its
    // own failure, and an unhandled 'error' event would crash the process on
    // a background reconnect attempt — turning a degraded read into an
    // outage. Same reasoning as the cache-side factory.
  });
  return redis;
}

/**
 * STORY-179 — the connection for a loop that runs for the life of the process (the monitor driver). Unlike the reader
 * above, which is built for one-shot boot reads, it must NEVER give up reconnecting: when a `retryStrategy` returns
 * null ioredis moves the connection to `end` for good and every later command rejects with "Connection is closed". A
 * Valkey restart or failover would then end the monitoring until the pod restarted. Each command still fails fast
 * (one retry, bounded connect, `commandTimeout` for a socket that is open but silent), so a tick is skipped, not stuck.
 */
export function createQueueMonitorConnection(url: string): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 500,
    commandTimeout: 2_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    maxRetriesPerRequest: 1,
  });
  redis.on("error", () => {
    // Swallowed deliberately, as the reader factory does: every use handles its own failure, and an unhandled 'error'
    // event on a background reconnect would crash the process.
  });
  return redis;
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
