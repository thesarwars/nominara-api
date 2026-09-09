import "reflect-metadata";
import { pathToFileURL } from "node:url";
import { Logger, Module, type INestApplicationContext, type OnModuleDestroy } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { ClientBase, PoolClient } from "pg";
import { engineSpendCeilingsSchema } from "./config/env.schema.js";
import { loadEnv } from "./config/env.js";
import { createPgPool } from "./db/pg-pool.js";
import { CanaryRuntime } from "./lib/engines/canary-runtime.js";
import { ACTIVE_ENGINE_KEYS } from "./lib/engines/registry.js";
import { warnMissingSpendCeilings } from "./lib/engines/spend-meter.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "./lib/queue/connection.js";
import { attachDeadLetterHandler, buildDlqQueue } from "./lib/queue/dead-letter.js";
import { queuesForGroup } from "./lib/queue/group.js";
import { handlerFor } from "./lib/queue/handlers.js";
import { buildWorker, signingKeysFromEnv } from "./lib/queue/worker-factory.js";

// STORY-022 — worker bootstrap (project-structure.md §2: "src/worker.ts
// worker bootstrap; WORKER_GROUP selects the queue set").
//
// STORY-030 Phase B — `queuesForGroup(env.WORKER_GROUP)` runs BEFORE any
// Redis connection is created: an env value outside WORKER_GROUPS never
// reaches here at all (env.schema.ts's `z.enum` rejects it at `loadEnv()`,
// raising EnvValidationError), and queuesForGroup's own
// UnknownWorkerGroupError is the same fail-fast guarantee for any caller
// that reaches this function directly. Every queue in the group gets its
// own Worker AND its own dedicated ioredis connection — `lookup.execute`
// (system-architecture.md §4's one queue with a documented "dedicated
// pool") is no different from any other queue in that respect, since BullMQ
// never lets two queues share one Worker's concurrency slots anyway.
//
// STORY-124 — per-queue handlers come from src/lib/queue/handlers.ts's
// registry, and whether a worker autoruns is DERIVED from whether one is
// registered rather than declared separately. A queue with a handler pulls
// jobs and runs them on a pooled client; a queue without one keeps
// `autorun: false` and the throwing placeholder, so it never pulls a job at
// all.
//
// That asymmetry is the point. A worker that pulled a job it cannot process
// would fail it down the retry ladder and into the dead-letter queue,
// turning "not built yet" into "tried and failed" in the record an operator
// reads during an incident. Inert is a better lie than broken.
export class WorkerGroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerGroupError";
  }
}

/** DI token exposing the constructed group's Worker instances, e.g. for test/integration/worker-group-bootstrap.spec.ts. */
export const WORKER_GROUP_WORKERS = "WORKER_GROUP_WORKERS";

/** DI token for the capture group's canary (Phase F) — only ever registered when WORKER_GROUP === "capture"; absent for every other group. */
export const CAPTURE_CANARY_RUNTIME = "CAPTURE_CANARY_RUNTIME";

class WorkerGroupRuntime implements OnModuleDestroy {
  constructor(
    public readonly workers: readonly Worker[],
    private readonly dlqQueues: readonly Queue[],
    // STORY-124 — the pool every registered handler checks its client out
    // of. Closed AFTER the workers, so a job still draining keeps the
    // connection it is holding.
    private readonly pool: ReturnType<typeof createPgPool>,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => closeWithinDeadline(worker)));
    await Promise.all(this.dlqQueues.map((queue) => queue.close().catch(() => undefined)));
    await this.pool.end().catch(() => undefined);
  }
}

/** How long a graceful close may take before it is forced. */
const WORKER_CLOSE_DEADLINE_MS = 2_000;

/**
 * Close a worker gracefully, but never indefinitely.
 *
 * A bare `worker.close()` waits for the worker to drain, and a worker whose
 * Redis is unreachable NEVER DRAINS — it sits in ioredis's reconnect loop
 * while the process refuses to exit. That is a pod that will not terminate
 * during exactly the incident you most want it to restart in, and a
 * shutdown-during-a-Valkey-outage is not a hypothetical.
 *
 * Graceful first, because that is what lets an in-flight job finish rather
 * than being retried. Forced after the deadline, because a shutdown that
 * cannot complete is worse than one that interrupts a job the retry ladder
 * will pick up again.
 *
 * Surfaced by wiring `capture.execute`: the worker boot test had never
 * booted a group with a live queue in it, so nothing had ever closed a real
 * worker against a Valkey that was not there.
 */
async function closeWithinDeadline(worker: Worker): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), WORKER_CLOSE_DEADLINE_MS);
    timer.unref();
  });

  try {
    const outcome = await Promise.race([worker.close().then(() => "closed" as const), deadline]);
    if (outcome !== "timeout") return;
    // The FORCED close is raced too. BullMQ's `close()` awaits its own
    // `waitUntilReady` on the way in, so a worker whose Redis never comes up
    // hangs on the forced path exactly as it did on the graceful one — and a
    // shutdown that waits forever for the escape hatch has no escape hatch.
    // The connection is torn down with the process either way.
    await Promise.race([worker.close(true).catch(() => undefined), deadline]);
  } catch {
    await Promise.race([worker.close(true).catch(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * STORY-031 Phase F — owns the capture group's canary resources
 * (Postgres pool, cache Valkey connection, the CanaryRuntime's own poll
 * interval) so they are torn down on `app.close()` exactly like every
 * other worker-group resource.
 */
class CaptureCanaryRuntimeHolder implements OnModuleDestroy {
  constructor(
    public readonly runtime: CanaryRuntime,
    private readonly cacheRedis: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.runtime.stop();
    await this.cacheRedis.quit().catch(() => undefined);
    // STORY-124 — the Postgres pool is WorkerGroupRuntime's now, shared
    // with every registered queue handler, and closed there.
  }
}

function notImplementedHandler(queueName: string): never {
  throw new Error(`queue "${queueName}": no handler wired yet — business logic lands in a later story`);
}

export async function bootstrapWorker(): Promise<INestApplicationContext> {
  const env = loadEnv();
  if (!env.WORKER_GROUP) {
    throw new WorkerGroupError(
      "WORKER_GROUP must be set to boot a worker process (capture|parse|crawl|embed|rollup|report|deploy)",
    );
  }

  const entries = queuesForGroup(env.WORKER_GROUP);
  const keys = signingKeysFromEnv(env);
  const prefix = queueKeyPrefix(env.NODE_ENV);

  // Code-review fix: built as ONE loop (not two separate .map() passes) so
  // that if queue N throws partway through construction, every dlqQueue/
  // Worker already fully built for the entries BEFORE it — which are
  // otherwise unreachable once the exception propagates — gets closed
  // before rethrowing, instead of leaking their connections.
  const dlqQueues: Queue[] = [];
  const workers: Worker[] = [];

  // STORY-124 — one pool per worker process, for every group rather than
  // only `capture`. It is lazy (pg.Pool opens nothing until a client is
  // checked out), so a group whose queues are all still inert pays nothing
  // for holding one.
  const pool = createPgPool(env.DATABASE_URL_POOLED);
  const live: string[] = [];
  const inert: string[] = [];

  try {
    for (const entry of entries) {
      const dlqQueue = buildDlqQueue(entry, { connection: createQueueWorkerConnection(env.QUEUE_REDIS_URL), prefix });
      dlqQueues.push(dlqQueue);

      const handler = handlerFor(entry.name);
      (handler ? live : inert).push(entry.name);

      const worker = buildWorker(entry, {
        connection: createQueueWorkerConnection(env.QUEUE_REDIS_URL),
        prefix,
        keys,
        // Derived, never declared twice: a registered handler is exactly
        // what makes a queue safe to pull from.
        autorun: handler !== undefined,
        getClient: handler ? () => pool.connect() : () => notImplementedHandler(entry.name),
        // Spread rather than a ternary to `undefined`: under
        // exactOptionalPropertyTypes an absent option and one explicitly set
        // to undefined are different things, and an unhandled queue has no
        // client to give back — its getClient throws first.
        ...(handler ? { releaseClient: (client: ClientBase) => (client as PoolClient).release() } : {}),
        process: handler ? handler({ pool, env }) : () => notImplementedHandler(entry.name),
      });
      attachDeadLetterHandler(worker, dlqQueue, entry);
      workers.push(worker);
    }
  } catch (error) {
    await Promise.all([...workers.map((worker) => worker.close()), ...dlqQueues.map((queue) => queue.close())]);
    await pool.end().catch(() => undefined);
    throw error;
  }

  const runtime = new WorkerGroupRuntime(workers, dlqQueues, pool);

  // STORY-031 Phase F — D2/EC-06: the 5-minute engine-health canary is a
  // capture-group concern only. Nothing else touches an engine at all.
  const providers: Array<{ provide: string; useValue: unknown }> = [{ provide: WORKER_GROUP_WORKERS, useValue: runtime }];
  if (env.WORKER_GROUP === "capture") {
    // D13 — a boot-time disclosure, not a fabricated default: every active
    // engine missing an ENGINE_SPEND_CEILINGS_USD entry logs exactly one
    // warning here, matching where ENGINE_TOKEN_BUCKETS's config-shaped
    // sibling is already read from env for this same worker group.
    const ceilingsUsd = env.ENGINE_SPEND_CEILINGS_USD
      ? engineSpendCeilingsSchema.parse(JSON.parse(env.ENGINE_SPEND_CEILINGS_USD))
      : {};
    warnMissingSpendCeilings(ceilingsUsd, ACTIVE_ENGINE_KEYS);

    // lazyConnect: a fake/unreachable VALKEY_CACHE_URL (e.g. in a unit test)
    // must never attempt a connection merely from construction — only once
    // the canary's own poll interval actually fires a tick.
    const cacheRedis = new Redis(env.VALKEY_CACHE_URL, { lazyConnect: true });
    cacheRedis.on("error", (error) => {
      new Logger("bootstrap").warn(`capture canary: cache Valkey connection error: ${error.message}`);
    });
    // STORY-124 — the canary shares the worker process's one pool rather
    // than opening a second. WorkerGroupRuntime owns closing it.
    const canaryRuntime = new CanaryRuntime({ pool, cacheRedis });
    canaryRuntime.start();
    providers.push({ provide: CAPTURE_CANARY_RUNTIME, useValue: new CaptureCanaryRuntimeHolder(canaryRuntime, cacheRedis) });
  }

  @Module({ providers })
  class WorkerRootModule {}

  const app = await NestFactory.createApplicationContext(WorkerRootModule, { bufferLogs: true });
  app.enableShutdownHooks();
  // STORY-043 review — WITHOUT THIS THE WORKER LOGS NOTHING, EVER. `bufferLogs`
  // holds every log line until something flushes it, and main.ts and
  // gateway.ts both flush implicitly via `app.listen()`. A worker never
  // listens, so nothing ever flushed: `docker logs` on the worker container
  // was completely empty, including the boot line below that exists to tell
  // an operator which queues are live. Found by running the container rather
  // than by reading it.
  app.flushLogs();
  // STORY-124 — an operator reading this needs to know which half of the
  // spine is alive. A group that processes nothing must not look identical
  // to one that processes everything.
  // The two lists are formatted into named locals rather than inline
  // ternaries. ISO-13's cache-key scanner is a regex over source text, and a
  // template opening with an interpolation and carrying two colons — one
  // from the label, one from a ternary — reads to it as an un-namespaced
  // cache key. The gate is right to be coarse; this is the call site's
  // problem to avoid (same shape STORY-122 hit in schema-check.ts).
  const processing = live.length > 0 ? live.join(", ") : "none";
  const notWired = inert.length > 0 ? inert.join(", ") : "none";
  new Logger("bootstrap").log(
    `worker group "${env.WORKER_GROUP}" started with ${workers.length} queue(s) — ` +
      `${String(live.length)} processing (${processing}); ` +
      `${String(inert.length)} inert, no handler wired (${notWired})`,
  );
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void bootstrapWorker();
}
