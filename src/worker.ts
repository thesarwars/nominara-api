import "reflect-metadata";
import { pathToFileURL } from "node:url";
import { Logger, Module, type INestApplicationContext, type OnModuleDestroy } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { engineSpendCeilingsSchema } from "./config/env.schema.js";
import { loadEnv } from "./config/env.js";
import { createPgPool } from "./db/pg-pool.js";
import { CanaryRuntime } from "./lib/engines/canary-runtime.js";
import { ACTIVE_ENGINE_KEYS } from "./lib/engines/registry.js";
import { warnMissingSpendCeilings } from "./lib/engines/spend-meter.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "./lib/queue/connection.js";
import { attachDeadLetterHandler, buildDlqQueue } from "./lib/queue/dead-letter.js";
import { queuesForGroup } from "./lib/queue/group.js";
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
// Real per-queue handlers (the actual capture/parse/crawl/... business
// logic) do not exist yet — later stories wire `getClient`/`process` for
// each queue. Until then every worker is built with `autorun: false` (never
// pulls a job) and placeholder handlers that throw if ever invoked, so
// `bootstrapWorker()` proves the group→queue wiring itself without
// pretending real job processing exists.
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
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all(this.dlqQueues.map((queue) => queue.close()));
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
    private readonly pool: ReturnType<typeof createPgPool>,
    private readonly cacheRedis: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.runtime.stop();
    await this.pool.end().catch(() => undefined);
    await this.cacheRedis.quit().catch(() => undefined);
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

  try {
    for (const entry of entries) {
      const dlqQueue = buildDlqQueue(entry, { connection: createQueueWorkerConnection(env.QUEUE_REDIS_URL), prefix });
      dlqQueues.push(dlqQueue);

      const worker = buildWorker(entry, {
        connection: createQueueWorkerConnection(env.QUEUE_REDIS_URL),
        prefix,
        keys,
        autorun: false,
        getClient: () => notImplementedHandler(entry.name),
        process: () => notImplementedHandler(entry.name),
      });
      attachDeadLetterHandler(worker, dlqQueue, entry);
      workers.push(worker);
    }
  } catch (error) {
    await Promise.all([...workers.map((worker) => worker.close()), ...dlqQueues.map((queue) => queue.close())]);
    throw error;
  }

  const runtime = new WorkerGroupRuntime(workers, dlqQueues);

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

    const pool = createPgPool(env.DATABASE_URL_POOLED);
    // lazyConnect: a fake/unreachable VALKEY_CACHE_URL (e.g. in a unit test)
    // must never attempt a connection merely from construction — only once
    // the canary's own poll interval actually fires a tick.
    const cacheRedis = new Redis(env.VALKEY_CACHE_URL, { lazyConnect: true });
    cacheRedis.on("error", (error) => {
      new Logger("bootstrap").warn(`capture canary: cache Valkey connection error: ${error.message}`);
    });
    const canaryRuntime = new CanaryRuntime({ pool, cacheRedis });
    canaryRuntime.start();
    providers.push({ provide: CAPTURE_CANARY_RUNTIME, useValue: new CaptureCanaryRuntimeHolder(canaryRuntime, pool, cacheRedis) });
  }

  @Module({ providers })
  class WorkerRootModule {}

  const app = await NestFactory.createApplicationContext(WorkerRootModule, { bufferLogs: true });
  app.enableShutdownHooks();
  new Logger("bootstrap").log(
    `worker group "${env.WORKER_GROUP}" started with ${workers.length} queue(s): ${entries.map((entry) => entry.name).join(", ")}`,
  );
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void bootstrapWorker();
}
