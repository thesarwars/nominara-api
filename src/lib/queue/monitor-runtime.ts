import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { z } from "zod";
import { BlackoutMonitor } from "../engines/blackout.js";
import type { EngineKey } from "../engines/contract.js";
import { ACTIVE_ENGINE_KEYS } from "../engines/registry.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { DlqDepthMonitor, defaultPager, type Pager } from "./dead-letter.js";
import { withGlobalQueueLock } from "./locks.js";
import { emitOldestJobAges } from "./queue-age-monitor.js";

// STORY-179 — drives DlqDepthMonitor (SLO-24) and BlackoutMonitor (EC-06), which existed with tests but were never
// instantiated, so neither alert could fire in a running worker.
//
// ELECTION. Every replica of the group ticks; each tick takes `withGlobalQueueLock` (a transaction-scoped advisory
// lock, the same primitive runElectedCanaryRound uses, safe behind pgBouncer transaction pooling) and the monitors'
// state is read from Valkey AFTER the lock is held and written back BEFORE it is released. So whichever replica wins a
// tick continues the same window and the same "already paged", and a replica that was waiting sees the winner's result.
// A session-level lock held for the process lifetime would not survive transaction pooling (EC-14); a scheduled job
// would land on any replica and split the state, which is what the store exists to prevent.
//
// The monitors themselves stay synchronous and in-memory: a fresh pair is built each tick, seeded from the store.

const logger = new Logger("queue-monitor-runtime");
const tracer = trace.getTracer("nominara-api");

/** The lock namespace: a string only, never registered in topology.ts. */
export const MONITOR_DRIVER_LOCK = "monitor.driver";
/** How often each replica ticks. Far below the 10-minute DLQ window, so the window is measured to within a minute. */
export const MONITOR_TICK_INTERVAL_MS = 60_000;

export const monitorStateSchema = z
  .object({
    dlq: z.object({ aboveSince: z.record(z.string(), z.number()), alreadyPaged: z.array(z.string()) }).strict(),
    blackout: z.object({ darkSinceMs: z.record(z.string(), z.number()), lastPagedAtMs: z.record(z.string(), z.number()) }).strict(),
  })
  .strict();
export type MonitorState = z.infer<typeof monitorStateSchema>;

export const EMPTY_MONITOR_STATE: MonitorState = {
  dlq: { aboveSince: {}, alreadyPaged: [] },
  blackout: { darkSinceMs: {}, lastPagedAtMs: {} },
};

/** Where the monitors' small state lives between ticks and across replicas. `load` rejects on an outage and returns null when nothing is stored. */
export interface MonitorStateStore {
  load(): Promise<MonitorState | null>;
  save(state: MonitorState): Promise<void>;
}

/** Long enough that a quiet week does not forget an open window or a cooldown, short enough that a retired deployment's key goes away. Refreshed by every save. */
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The QUEUE Valkey instance (`noeviction`, persistent), not the cache one: this is dedup state, and an LRU eviction
 * would silently turn "already paged" into a second page.
 */
export class ValkeyMonitorStateStore implements MonitorStateStore {
  private readonly key: string;

  constructor(
    private readonly redis: Redis,
    keyPrefix: string,
  ) {
    this.key = `${keyPrefix}:monitor-state`;
  }

  async load(): Promise<MonitorState | null> {
    const raw = await this.redis.get(this.key);
    if (raw === null) return null;
    try {
      return monitorStateSchema.parse(JSON.parse(raw));
    } catch {
      // Unreadable is not an outage: skipping every tick would end the monitoring for good. Start clean; the cost is at
      // worst a window that restarts or one repeat page.
      logger.error("monitor state in Valkey is unreadable — starting from empty state");
      incrementCounter("nominara_queue_monitor_state_corrupt_total");
      return null;
    }
  }

  async save(state: MonitorState): Promise<void> {
    await this.redis.set(this.key, JSON.stringify(state), "EX", STATE_TTL_SECONDS);
  }
}

/** Jobs a DLQ is holding: nothing ever runs a Worker against it, so waiting is the normal state (BullMQ 6 counts a paused queue's jobs as waiting). */
export function dlqDepthReader(dlqQueues: ReadonlyMap<string, Pick<Queue, "getJobCounts">>): () => Promise<ReadonlyMap<string, number>> {
  return async () => {
    const depths = new Map<string, number>();
    await Promise.all(
      [...dlqQueues].map(async ([queueName, dlq]) => {
        try {
          const counts = await dlq.getJobCounts("waiting", "delayed", "prioritized");
          depths.set(queueName, (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0));
        } catch (error) {
          // Left out rather than recorded as 0: an unreadable queue must not look recovered.
          logger.warn(`monitor: could not read the dead-letter depth of "${queueName}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    return depths;
  };
}

export interface MonitorRuntimeOptions {
  readonly pool: Pool;
  readonly store: MonitorStateStore;
  /** Depth of each `{queue}.dlq`, keyed by the SOURCE queue's name. A queue absent from the map is not observed this tick. */
  readonly readDlqDepths: () => Promise<ReadonlyMap<string, number>>;
  readonly readLastSuccess: (engines: readonly EngineKey[]) => Promise<ReadonlyMap<EngineKey, number | null>>;
  /** STORY-030 AC8 — oldest waiting job age per interactive queue, in seconds (null: nothing waiting). Optional: absent means no age signal. */
  readonly readOldestAges?: () => Promise<ReadonlyMap<string, number | null>>;
  readonly engines?: readonly EngineKey[];
  readonly pager?: Pager;
  readonly clock?: () => number;
  readonly tickIntervalMs?: number;
}

type TickOutcome = "ok" | "partial" | "skipped";

export class MonitorRuntime {
  private readonly pool: Pool;
  private readonly store: MonitorStateStore;
  private readonly readDlqDepths: MonitorRuntimeOptions["readDlqDepths"];
  private readonly readLastSuccess: MonitorRuntimeOptions["readLastSuccess"];
  private readonly readOldestAges: MonitorRuntimeOptions["readOldestAges"];
  private readonly engines: readonly EngineKey[];
  private readonly pager: Pager;
  private readonly clock: () => number;
  private readonly tickIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MonitorRuntimeOptions) {
    this.pool = options.pool;
    this.store = options.store;
    this.readDlqDepths = options.readDlqDepths;
    this.readLastSuccess = options.readLastSuccess;
    this.readOldestAges = options.readOldestAges;
    this.engines = options.engines ?? ACTIVE_ENGINE_KEYS;
    this.pager = options.pager ?? defaultPager;
    this.clock = options.clock ?? (() => Date.now());
    this.tickIntervalMs = options.tickIntervalMs ?? MONITOR_TICK_INTERVAL_MS;
  }

  /** Best-effort, always: a Valkey or Postgres outage must never crash the worker. A skipped tick loses nothing the next one cannot recover. */
  async tick(): Promise<void> {
    await tracer.startActiveSpan("queue.monitor_tick", async (span) => {
      let outcome: TickOutcome = "skipped";
      try {
        outcome = await this.elected();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        logger.warn(`monitor tick failed — best-effort, never crashes the worker: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        span.setAttribute("nominara.queue.monitor_tick.outcome", outcome);
        span.end();
        incrementCounter("nominara_queue_monitor_tick_total", { outcome });
      }
    });
  }

  private async elected(): Promise<TickOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const outcome = await withGlobalQueueLock(client, MONITOR_DRIVER_LOCK, () => this.round());
      await client.query("COMMIT");
      return outcome;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // already broken — nothing more to do.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs under the lock. */
  private async round(): Promise<TickOutcome> {
    // Loaded only now, under the lock. If it cannot be read the tick is skipped rather than run on empty state, which
    // would forget an open window and an already-paged breach.
    const stored = await this.store.load();
    const state = stored ?? EMPTY_MONITOR_STATE;
    const now = this.clock;
    const dlq = new DlqDepthMonitor({ clock: now, pager: this.pager });
    const blackout = new BlackoutMonitor(this.pager, now);
    dlq.importState(state.dlq);
    blackout.importState(state.blackout);

    let outcome: TickOutcome = "ok";
    let queuesObserved = 0;
    let enginesObserved = 0;

    try {
      const depths = await this.readDlqDepths();
      for (const [queueName, depth] of depths) {
        dlq.observe(queueName, depth);
        queuesObserved += 1;
      }
    } catch (error) {
      outcome = "partial";
      logger.warn(`monitor: dead-letter depths unreadable this tick — not observed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const lastSuccess = await this.readLastSuccess(this.engines);
      for (const [engineKey, at] of lastSuccess) {
        blackout.observeLastSuccess(engineKey, at);
        enginesObserved += 1;
      }
    } catch (error) {
      outcome = "partial";
      logger.warn(`monitor: engine last-success unreadable this tick — not observed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (this.readOldestAges) {
      try {
        emitOldestJobAges(await this.readOldestAges());
      } catch (error) {
        // No line at all: an unreadable age must not be reported as a short one.
        outcome = "partial";
        logger.warn(`monitor: oldest-job ages unreadable this tick — not emitted: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      await this.store.save({ dlq: dlq.exportState(), blackout: blackout.exportState() });
    } catch (error) {
      // A page may already have gone out from this tick; if the state is lost the next tick can repeat it. Loud, not fatal.
      outcome = "partial";
      logger.error(`monitor: state could not be saved — a page from this tick may repeat: ${error instanceof Error ? error.message : String(error)}`);
    }

    logger.log({ message: "monitor tick", outcome, queuesObserved, enginesObserved });
    return outcome;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        logger.warn(`unexpected monitor tick error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.tickIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
