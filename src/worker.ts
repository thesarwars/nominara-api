import "reflect-metadata";
import { pathToFileURL } from "node:url";
import { Logger, Module, type INestApplicationContext, type OnModuleDestroy } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { ClientBase, PoolClient } from "pg";
import { resolveEngineSpendCeilings } from "./config/env.schema.js";
import { loadEnv } from "./config/env.js";
import { announceAlertRouting, drainAlertEmails } from "./lib/alerts/alerts.js";
import { connect, withKeepalives } from "./db/client.js";
import { createPgPool, isConnectionClassFailure } from "./db/pg-pool.js";
import { SchedulerSweepRuntime } from "./lib/capture/scheduler-sweep.js";
import { CanaryRuntime } from "./lib/engines/canary-runtime.js";
import { captureEngineLeaseOptions } from "./lib/engines/engine-lease.js";
import { TokenBucket } from "./lib/engines/token-bucket.js";
import { ACTIVE_ENGINE_KEYS } from "./lib/engines/registry.js";
import { warnMissingSpendCeilings } from "./lib/engines/spend-meter.js";
import { createQueueReaderConnection, createQueueWorkerConnection, queueKeyPrefix } from "./lib/queue/connection.js";
import { attachDeadLetterHandler, buildDlqQueue } from "./lib/queue/dead-letter.js";
import { MonitorRuntime, ValkeyMonitorStateStore, dlqDepthReader } from "./lib/queue/monitor-runtime.js";
import { INTERACTIVE_QUEUES, queueAgeReader } from "./lib/queue/queue-age-monitor.js";
import { QUEUE_TOPOLOGY } from "./lib/queue/topology.js";
import { EngineHealthService } from "./modules/health/engine-health.service.js";
import { queuesForGroup } from "./lib/queue/group.js";
import { handlerFor } from "./lib/queue/handlers.js";
import { buildQueue } from "./lib/queue/queue-factory.js";
import { QueueProducer } from "./lib/queue/queue-producer.js";
import { describeSchedules, reconcileSchedules } from "./lib/queue/schedule-registrar.js";
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

/** STORY-179 — DI token for the rollup group's DLQ-depth and engine-blackout monitor driver. Rollup group only. */
export const ROLLUP_MONITOR_RUNTIME = "ROLLUP_MONITOR_RUNTIME";

/** NEW-A-13 — DI token for the capture group's scheduler sweep (hourly at :05 UTC). Capture group only. */
export const CAPTURE_SCHEDULER_SWEEP = "CAPTURE_SCHEDULER_SWEEP";

class WorkerGroupRuntime implements OnModuleDestroy {
  constructor(
    public readonly workers: readonly Worker[],
    private readonly dlqQueues: readonly Queue[],
    // G12 — the producer-side Queue handles the schedule registrar upserts
    // through, and the one connection they share. Closed with the DLQ queues.
    private readonly scheduleQueues: readonly Queue[],
    private readonly scheduleConnection: Redis | undefined,
    // STORY-124 — the pool every registered handler checks its client out
    // of. Closed AFTER the workers, so a job still draining keeps the
    // connection it is holding.
    private readonly pool: ReturnType<typeof createPgPool>,
    // SCANFIX D3 - the cache-instance connection the capture.execute token bucket spends from.
    private readonly leaseConnections: readonly Redis[] = [],
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => closeWithinDeadline(worker)));
    // Group C — handlers have stopped, so no new alert can start; give in-flight alert mail a bounded chance to land.
    await drainAlertEmails();
    await Promise.all(this.dlqQueues.map((queue) => queue.close().catch(() => undefined)));
    await Promise.all(this.scheduleQueues.map((queue) => queue.close().catch(() => undefined)));
    // The one connection every schedule Queue shares. Closing a Queue does
    // not close a connection it was handed rather than asked to create.
    await this.scheduleConnection?.quit().catch(() => undefined);
    await Promise.all(this.leaseConnections.map((connection) => connection.quit().catch(() => undefined)));
    await this.pool.end().catch(() => undefined);
  }
}

/** How long a graceful close may take before it is forced. */
const WORKER_CLOSE_DEADLINE_MS = 2_000;

/** How long the boot will wait for Valkey to accept the schedule reconcile. */
const SCHEDULE_RECONCILE_DEADLINE_MS = 5_000;

/** Reject rather than hang. See the schedule reconcile's own comment for why. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms`)), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

/** NEW-A-13 — owns the sweep's timer and the producer it enqueues through. */
class CaptureSchedulerSweepHolder implements OnModuleDestroy {
  constructor(
    public readonly runtime: SchedulerSweepRuntime,
    private readonly producer: QueueProducer,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.runtime.stop();
    // Closes the producer's Queues only. The connection is the group's shared
    // producer-side one, which WorkerGroupRuntime closes.
    await this.producer.onModuleDestroy();
  }
}

/** STORY-179 — owns the monitor driver's timer and the read-only Queue handles it counts and ages through. */
class RollupMonitorHolder implements OnModuleDestroy {
  constructor(
    public readonly runtime: MonitorRuntime,
    private readonly readers: readonly Queue[],
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.runtime.stop();
    // Closes the Queue handles only; the connection is the group's shared producer-side one, which WorkerGroupRuntime closes.
    await Promise.all(this.readers.map((queue) => queue.close().catch(() => undefined)));
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

  // Group C — one boot line if operational alerts have nowhere to go (ALERT_EMAIL_TO unset).
  announceAlertRouting();

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
  // G12 — one producer-side Queue per entry in THIS group, used only to
  // reconcile job schedulers. Scoped to the group because a scheduler is
  // removed when it should not run, and a group that could see another
  // group's queues would remove its schedulers on every boot.
  //
  // ⚠ ONE SHARED CONNECTION FOR ALL OF THEM, unlike the Workers above, and
  // built AFTER the worker loop. The comment at the top of this file records
  // why each Worker gets a dedicated ioredis connection: a Worker blocks on
  // Redis, so two sharing one starve each other. A producer-side Queue issues
  // ordinary commands and does not block, so a connection each would have
  // tripled every worker process's connection count to Valkey for schedulers
  // upserted once at boot. Built after the loop so the connection ORDER
  // inside it is unchanged — `worker-group-bootstrap.spec.ts` injects a
  // failure at a specific call index to prove partial construction cleans up,
  // and a connection taken before the loop would have shifted that index and
  // quietly changed what that test proves.
  let scheduleConnection: Redis | undefined;
  const scheduleQueues = new Map<string, Queue>();

  // STORY-124 — one pool per worker process, for every group rather than
  // only `capture`. It is lazy (pg.Pool opens nothing until a client is
  // checked out), so a group whose queues are all still inert pays nothing
  // for holding one.
  const pool = createPgPool(env.DATABASE_URL_POOLED);
  const leaseConnections: Redis[] = [];
  const live: string[] = [];
  const inert: string[] = [];

  try {
    for (const entry of entries) {
      const dlqQueue = buildDlqQueue(entry, { connection: createQueueWorkerConnection(env.QUEUE_REDIS_URL), prefix });
      dlqQueues.push(dlqQueue);

      const handler = handlerFor(entry.name);
      (handler ? live : inert).push(entry.name);

      // SCANFIX D3 - capture.execute is paced per engine. The bucket lives on the CACHE instance (STORY-031
      // D6), over a connection that rejects rather than blocks: TokenBucket fails OPEN on a store error
      // (D19), so an unreachable cache means unpaced, never stuck.
      let engineLease: ReturnType<typeof captureEngineLeaseOptions> | undefined;
      if (entry.name === "capture.execute") {
        const leaseRedis = new Redis(env.VALKEY_CACHE_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
        leaseRedis.on("error", (error) => {
          new Logger("bootstrap").warn(`capture.execute engine lease: cache Valkey connection error: ${error.message}`);
        });
        leaseConnections.push(leaseRedis);
        engineLease = captureEngineLeaseOptions(env, new TokenBucket(leaseRedis));
      }

      const worker = buildWorker(entry, {
        connection: createQueueWorkerConnection(env.QUEUE_REDIS_URL),
        prefix,
        keys,
        // Derived, never declared twice: a registered handler is exactly
        // what makes a queue safe to pull from.
        autorun: handler !== undefined,
        ...(engineLease ? { engineLease } : {}),
        getClient: handler ? () => pool.connect() : () => notImplementedHandler(entry.name),
        // Spread rather than a ternary to `undefined`: under
        // exactOptionalPropertyTypes an absent option and one explicitly set
        // to undefined are different things, and an unhandled queue has no
        // client to give back — its getClient throws first.
        ...(handler ? { releaseClient: (client: ClientBase, failure?: unknown) => (client as PoolClient).release(isConnectionClassFailure(failure) ? (failure as Error) : undefined) } : {}),
        process: handler ? handler({ pool, env }) : () => notImplementedHandler(entry.name),
      });
      attachDeadLetterHandler(worker, dlqQueue, entry);
      workers.push(worker);
    }
    // ⚠ THE READER FACTORY, NOT THE WORKER ONE. These Queues ASK Valkey
    // questions (`getJobSchedulers`) and must answer someone, which is
    // exactly the role `createQueueReaderConnection` exists to serve —
    // bounded connect, one retry, then a real error. The worker factory sets
    // `maxRetriesPerRequest: null` on purpose, so that a worker never invents
    // a job failure out of a connection problem; inherited here it means the
    // read never rejects and never resolves, which is precisely the hang the
    // deadline below was added to paper over. connection.ts's own comment
    // describes this failure and names the mistake: the bounded factory
    // "mirrors createHealthCacheConnection, which got this right for the
    // cache instance and was never carried across to the queue one". It has
    // now been carried across. The deadline stays as a second line of
    // defence, but a failure here now arrives with a cause attached.
    scheduleConnection = createQueueReaderConnection(env.QUEUE_REDIS_URL);
    for (const entry of entries) {
      scheduleQueues.set(entry.name, buildQueue(entry, { connection: scheduleConnection, prefix }));
    }
  } catch (error) {
    await Promise.all([
      ...workers.map((worker) => worker.close()),
      ...dlqQueues.map((queue) => queue.close()),
      ...[...scheduleQueues.values()].map((queue) => queue.close()),
      ...(scheduleConnection ? [scheduleConnection.quit().catch(() => undefined)] : []),
      ...leaseConnections.map((connection) => connection.quit().catch(() => undefined)),
    ]);
    await pool.end().catch(() => undefined);
    throw error;
  }

  const runtime = new WorkerGroupRuntime(workers, dlqQueues, [...scheduleQueues.values()], scheduleConnection, pool, leaseConnections);

  // STORY-031 Phase F — D2/EC-06: the 5-minute engine-health canary is a
  // capture-group concern only. Nothing else touches an engine at all.
  const providers: Array<{ provide: string; useValue: unknown }> = [{ provide: WORKER_GROUP_WORKERS, useValue: runtime }];
  if (env.WORKER_GROUP === "capture") {
    // D13 — a boot-time disclosure: every active
    // engine (gemini aside, which has a documented default) missing an ENGINE_SPEND_CEILINGS_USD entry logs exactly one
    // warning here, matching where ENGINE_TOKEN_BUCKETS's config-shaped
    // sibling is already read from env for this same worker group.
    const ceilingsUsd = resolveEngineSpendCeilings(env.ENGINE_SPEND_CEILINGS_USD);
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

    // NEW-A-13 — the scheduler sweep, in-process in the capture worker, hourly
    // at :05 UTC. It enqueues signed `capture.plan` jobs (consumed by this same
    // group) on the owner connection, so it can see across tenants. It enqueues
    // through the group's ONE shared producer-side connection (the bounded reader
    // factory, an ordinary-command producer is what that connection is for) and
    // opens no connection of its own.
    if (scheduleConnection === undefined) throw new WorkerGroupError("scheduler sweep: the producer-side connection was not built");
    const sweepProducer = new QueueProducer(scheduleConnection, prefix, keys);
    const sweepRuntime = new SchedulerSweepRuntime({
      connect: () => connect(withKeepalives(env.DATABASE_URL)),
      enqueue: async (job) => {
        await sweepProducer.enqueueTenantJob(
          "capture.plan",
          job.workspaceId,
          { projectId: job.projectId, trigger: "scheduled" },
          { idempotencyKey: job.idempotencyKey },
        );
      },
      // SCANFIX D4 - the stuck-run reaper asks for the rollup of a run it finishes.
      enqueueRollup: (queue, workspaceId, payload, idempotencyKey) =>
        sweepProducer.enqueueTenantJob(queue, workspaceId, payload, { idempotencyKey }),
    });
    sweepRuntime.start();
    providers.push({
      provide: CAPTURE_SCHEDULER_SWEEP,
      useValue: new CaptureSchedulerSweepHolder(sweepRuntime, sweepProducer),
    });
  }

  // STORY-179 — SLO-24 (dead-letter depth) and EC-06 (engine blackout) paging. The platform/system group owns it, so
  // capture pods stay lean. Every replica of the group ticks; the advisory-lock election inside the runtime makes one of
  // them drive each tick. It reads EVERY queue's DLQ, not just this group's, through the same bounded reader connection
  // the schedule registrar uses, and keeps its state on the queue Valkey (noeviction) rather than the LRU cache.
  if (env.WORKER_GROUP === "rollup") {
    if (scheduleConnection === undefined) throw new WorkerGroupError("monitor driver: the producer-side connection was not built");
    const dlqReaders = new Map(QUEUE_TOPOLOGY.map((entry) => [entry.name, buildDlqQueue(entry, { connection: scheduleConnection as Redis, prefix })]));
    // STORY-030 AC8 — the interactive queues' oldest-waiting-job age rides the same tick.
    const interactiveReaders = new Map(
      QUEUE_TOPOLOGY.filter((entry) => INTERACTIVE_QUEUES.includes(entry.name)).map((entry) => [entry.name, buildQueue(entry, { connection: scheduleConnection as Redis, prefix })]),
    );
    const engineHealth = new EngineHealthService(pool);
    const monitorRuntime = new MonitorRuntime({
      pool,
      store: new ValkeyMonitorStateStore(scheduleConnection, prefix),
      readDlqDepths: dlqDepthReader(dlqReaders),
      readLastSuccess: (engines) => engineHealth.lastSuccessAtMs(engines),
      readOldestAges: queueAgeReader(interactiveReaders),
    });
    monitorRuntime.start();
    providers.push({ provide: ROLLUP_MONITOR_RUNTIME, useValue: new RollupMonitorHolder(monitorRuntime, [...dlqReaders.values(), ...interactiveReaders.values()]) });
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
  // G12 — the timer. `producer:` in the topology was a declaration of intent
  // nothing had ever read, so ten queues declared a cron and none had a job
  // scheduler. Reconciled AFTER the workers are built, so a boot that fails
  // partway has not left a repeatable firing into a process that never came
  // up.
  //
  // ⚠ A FAILURE HERE MUST NOT TAKE THE WORKER DOWN, AND NEITHER MAY A HANG.
  // The group's whole job is processing what is already queued, and it can do
  // that with no schedule at all — so a Valkey that refuses the upsert is a
  // degraded tick, not a dead worker.
  //
  // The DEADLINE is the half that matters. ioredis does not fail fast against
  // an unreachable Valkey; it sits in its reconnect loop, so `await
  // queue.getJobSchedulers()` never settles and the boot never finishes. That
  // is the same trap `closeWithinDeadline` above documents for shutdown, at
  // the other end of the process's life — and the worker boot test found it
  // here by timing out at 15s.
  let scheduleLine: string;
  try {
    scheduleLine = describeSchedules(await withDeadline(reconcileSchedules(scheduleQueues), SCHEDULE_RECONCILE_DEADLINE_MS));
  } catch (error) {
    scheduleLine = `schedules: FAILED to reconcile — ${error instanceof Error ? error.message : String(error)}`;
    new Logger("bootstrap").error(scheduleLine);
  }

  const processing = live.length > 0 ? live.join(", ") : "none";
  const notWired = inert.length > 0 ? inert.join(", ") : "none";
  new Logger("bootstrap").log(
    `worker group "${env.WORKER_GROUP}" started with ${workers.length} queue(s) — ` +
      `${String(live.length)} processing (${processing}); ` +
      `${String(inert.length)} inert, no handler wired (${notWired})`,
  );
  new Logger("bootstrap").log(`worker group "${env.WORKER_GROUP}" ${scheduleLine}`);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void bootstrapWorker();
}
