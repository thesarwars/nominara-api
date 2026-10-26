import { Inject, Injectable, Logger, Optional, ServiceUnavailableException, type OnModuleDestroy } from "@nestjs/common";
import { HealthCheckService, HealthIndicatorService, type HealthCheckResult } from "@nestjs/terminus";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type {
  DependencyHealth,
  EngineHealthSummary,
  LivenessResponse,
  QueueDepth,
  ReadinessResponse,
} from "../../../contracts/common/health.schema.js";
import { ENGINE_CATALOG_STATUSES, type EngineStatusEntry, type EngineStatusResponse } from "../../../contracts/engines/index.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { appliedMigrationNames, listMigrationFiles } from "../../db/migrate-runner.js";
import { ACTIVE_ENGINE_KEYS } from "../../lib/engines/registry.js";
import { EngineBreakerRegistry } from "../../lib/engines/engine-breaker-registry.js";
import { CircuitBreaker } from "../../lib/resilience/circuit-breaker.js";
import { buildQueue } from "../../lib/queue/queue-factory.js";
import { QUEUE_TOPOLOGY } from "../../lib/queue/topology.js";
import { EngineHealthService, PER_ENGINE_STATUS_WINDOW_MS } from "./engine-health.service.js";

// STORY-022 — HealthModule (system-architecture.md §5): "Liveness,
// readiness, circuit-breaker state, queue depth" with `@nestjs/terminus` as
// its key dependency. Liveness never touches Postgres — it answers only "is
// the process up" (scenario 1). Readiness additionally fails until the
// applied migration set matches what this build expects (NFR-ARCH-06,
// scenario 2), and reports the Postgres circuit breaker's state
// (NFR-ARCH-05, scenario 3) — via a real Terminus health indicator
// (HealthIndicatorService), not a hand-rolled equivalent.

interface MigrationState {
  applied: string | null;
  expected: string | null;
  matches: boolean;
}

// Overridable in tests (e.g. the rollback-superset boundary case, which
// points this at an isolated directory with a deliberately older/smaller
// migration set than what the real database has already applied) — not
// bound to a value anywhere except HealthModule, which defaults it to the
// real MIGRATIONS_DIR.
export const MIGRATIONS_DIR_TOKEN = Symbol("HEALTH_MIGRATIONS_DIR");

// STORY-030 Task 28 — the queue instance's own dedicated Valkey connection
// (system-architecture.md §11: "never the cache instance"), used ONLY to
// read depth (getJobCounts) — this process never runs a Worker against any
// of these queues.
export const QUEUE_CONNECTION_TOKEN = Symbol("HEALTH_QUEUE_CONNECTION");
export const QUEUE_KEY_PREFIX_TOKEN = Symbol("HEALTH_QUEUE_KEY_PREFIX");

// STORY-031 Phase I — the cache Valkey instance, read-only here (breaker
// state only — HealthService never opens/closes a breaker itself).
export const CACHE_CONNECTION_TOKEN = Symbol("HEALTH_CACHE_CONNECTION");

// STORY-120 review — the ceiling on how long readiness may spend reading
// queue depth before reporting it as unavailable. Deliberately short: this
// is observability inside a probe an orchestrator polls, so being late is a
// worse answer than being empty.
const QUEUE_DEPTH_READ_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  // NFR-ARCH-05's exact numbers (50% error threshold, 30s open, 3-request
  // half-open) — sampleSize is this class's own implementation detail, not
  // one of those reference constants.
  private readonly postgresBreaker = new CircuitBreaker({ name: "postgres" });
  private lastMigrationState: MigrationState = { applied: null, expected: null, matches: false };
  private queuesByName: ReadonlyMap<string, Queue> | undefined;
  private readonly breakers: EngineBreakerRegistry;
  private readonly engineHealth: EngineHealthService;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional() @Inject(MIGRATIONS_DIR_TOKEN) private readonly migrationsDir: string | undefined,
    private readonly healthCheckService: HealthCheckService,
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(QUEUE_CONNECTION_TOKEN) private readonly queueConnection: Redis,
    @Inject(QUEUE_KEY_PREFIX_TOKEN) private readonly queueKeyPrefixValue: string,
    @Inject(CACHE_CONNECTION_TOKEN) private readonly cacheConnection: Redis,
  ) {
    this.breakers = new EngineBreakerRegistry(this.cacheConnection);
    this.engineHealth = new EngineHealthService(this.pool);
  }

  /**
   * STORY-031 AC11 - `GET /v1/engines/status`: one entry per active engine. GLOBAL data only (`engines`, `engine_health`, the
   * breaker), read on the pool like the probes, so the body is the same for every workspace. Unlike the probe's `engines[]` a
   * failure here is NOT swallowed: an empty list would tell a customer every engine is fine.
   */
  async engineStatus(nowMs: number = Date.now()): Promise<EngineStatusResponse> {
    const engines = await Promise.all(
      ACTIVE_ENGINE_KEYS.map(async (engineKey): Promise<EngineStatusEntry> => {
        const [health, breaker] = await Promise.all([this.engineHealth.perEngineStatus(engineKey, nowMs), this.breakers.for(engineKey).detail()]);
        const status = (ENGINE_CATALOG_STATUSES as readonly string[]).includes(health.status) ? (health.status as EngineStatusEntry["status"]) : "active";
        return {
          engine_key: engineKey,
          status,
          circuit_state: breaker.state,
          unavailable_since: breaker.since === null ? null : new Date(breaker.since).toISOString(),
          window_minutes: PER_ENGINE_STATUS_WINDOW_MS / 60_000,
          attempts: health.attempts,
          successes: health.successes,
          blocks: health.blocks,
          timeouts: health.timeouts,
          rate_limited: health.rateLimited,
          p50_latency_ms: health.p50LatencyMs,
          p95_latency_ms: health.p95LatencyMs,
        };
      }),
    );
    return { engines, generated_at: new Date(nowMs).toISOString() };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queuesByName) {
      await Promise.all(Array.from(this.queuesByName.values()).map((queue) => queue.close()));
    }
    await this.queueConnection.quit().catch(() => undefined);
    await this.cacheConnection.quit().catch(() => undefined);
  }

  liveness(): LivenessResponse {
    return { status: "ok" };
  }

  async readiness(): Promise<ReadinessResponse> {
    let result: HealthCheckResult;
    try {
      result = await this.healthCheckService.check([() => this.postgresIndicator()]);
    } catch (error) {
      // HealthCheckService.check() throws ServiceUnavailableException with
      // the same result shape once any indicator reports "down" — caught
      // here so this method can still return our own contract shape
      // (readinessResponseSchema) instead of Terminus's default response.
      if (error instanceof ServiceUnavailableException) {
        result = error.getResponse() as HealthCheckResult;
      } else {
        throw error;
      }
    }

    const postgresDetail = result.details["postgres"] as { status: "up" | "down" } | undefined;
    const dependencies: DependencyHealth[] = [
      {
        name: "postgres",
        state: this.postgresBreaker.state,
        healthy: postgresDetail?.status === "up",
      },
    ];
    // STORY-030 Task 28 — real per-queue depth (waiting+active), one entry
    // per QUEUE_TOPOLOGY queue. Queue depth is observability, not a
    // readiness gate — a failure reading it never flips `ready` to
    // `not_ready`, it only leaves this array empty for that one call.
    const queues = await this.queueDepths();
    const engines = await this.engineSummaries();

    const ready = result.status === "ok" && this.lastMigrationState.matches;
    this.logger.log(`readiness check: ${ready ? "ready" : "not_ready"}`);

    return {
      status: ready ? "ready" : "not_ready",
      migrationVersion: this.lastMigrationState,
      dependencies,
      queues,
      engines,
    };
  }

  /**
   * STORY-031 Phase I — D16: one entry per active engine, combining
   * `engines.status` (Postgres) with the breaker's `circuitState` (cache
   * Valkey, via EngineBreakerRegistry). `healthy` is true only when BOTH
   * are the fully-nominal value — `active` and `closed`.
   *
   * A Postgres read failure degrades this to an empty array — same posture
   * STORY-030's D11 established for `queueDepths` above: engine health is
   * observability, never a readiness gate. A cache Valkey failure does NOT
   * blank the array the same way: EngineBreaker.state() already fails
   * CLOSED to its own last-known state per D19 (never throws), so a cache
   * outage degrades PER ENGINE (falling back to `closed`) rather than
   * discarding perfectly good Postgres data just because the breaker read
   * alongside it had a hiccup.
   */
  private async engineSummaries(): Promise<EngineHealthSummary[]> {
    try {
      const result = await this.pool.query<{ key: string; status: string }>(
        "SELECT key, status FROM engines WHERE key = ANY($1)",
        [ACTIVE_ENGINE_KEYS],
      );
      const statusByKey = new Map(result.rows.map((row) => [row.key, row.status]));

      return await Promise.all(
        ACTIVE_ENGINE_KEYS.map(async (engineKey) => {
          const status = (statusByKey.get(engineKey) ?? "active") as EngineHealthSummary["status"];
          const circuitState = await this.breakers.for(engineKey).state();
          return {
            engineKey,
            status,
            circuitState,
            healthy: status === "active" && circuitState === "closed",
          };
        }),
      );
    } catch (error) {
      this.logger.error(`failed to read engine health summary: ${(error as Error).message}`);
      return [];
    }
  }

  /** One BullMQ `Queue` handle per QUEUE_TOPOLOGY entry, sharing this service's single connection — built once, lazily, and reused across calls. */
  private queues(): ReadonlyMap<string, Queue> {
    if (!this.queuesByName) {
      this.queuesByName = new Map(
        QUEUE_TOPOLOGY.map((entry) => [
          entry.name,
          buildQueue(entry, { connection: this.queueConnection, prefix: this.queueKeyPrefixValue }),
        ]),
      );
    }
    return this.queuesByName;
  }

  /**
   * Real per-queue depth (waiting+active), one entry per documented queue.
   * Every QUEUE_TOPOLOGY entry carries a documented `priority`
   * (queue-factory.ts's `enqueueJob` always sets one), so a job not yet
   * picked up by a worker sits in BullMQ's own separate `prioritized` state,
   * never `waiting` — that state is counted alongside `waiting`+`active`
   * here, or an unprocessed backlog would silently read as depth 0.
   * A Valkey read failure is logged and reported as an empty list — never a
   * thrown error, since queue depth is observability, not a readiness gate.
   *
   * STORY-120 review — that posture was documented but not implemented. An
   * UNREACHABLE queue instance produces no error to catch: BullMQ requires
   * `maxRetriesPerRequest: null` (src/lib/queue/connection.ts), so ioredis
   * retries forever and `getJobCounts()` never settles. Readiness then
   * never answered at all — worse than a 503, because nothing can report
   * it. Confirmed in real docker compose, where the api container stayed
   * unhealthy with no response. The deadline below is what makes the
   * sentence above true: an unreachable instance degrades this to an empty
   * list, exactly like a failing one, and never blocks the probe.
   *
   * The deeper cause is fixed too, in STORY-121: the connection factory now
   * has two named roles, and this service takes the READER — bounded retry,
   * short connect timeout — so an unreachable instance produces an error to
   * catch rather than silence. The deadline below stays as the second line of
   * defence: the connection failing fast is the fix, and the deadline is what
   * keeps the probe answering if a future read finds a new way to block.
   */
  private async queueDepths(): Promise<QueueDepth[]> {
    const reads = Promise.all(
      Array.from(this.queues().entries()).map(async ([name, queue]) => {
        const counts = await queue.getJobCounts("waiting", "active", "prioritized");
        return { name, depth: (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.prioritized ?? 0) };
      }),
    );
    // The race below can ABANDON this promise, and Node 24 terminates the
    // process on an unhandled rejection — so it carries its own handler
    // before anything else touches it.
    reads.catch(() => undefined);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`queue depth read exceeded ${QUEUE_DEPTH_READ_TIMEOUT_MS}ms`)),
        QUEUE_DEPTH_READ_TIMEOUT_MS,
      );
    });

    try {
      return await Promise.race([reads, deadline]);
    } catch (error) {
      this.logger.error(`failed to read queue depth: ${(error as Error).message}`);
      return [];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The Postgres dependency as a Terminus health indicator. The circuit
   * breaker (NFR-ARCH-05) still owns open/closed/half-open bookkeeping —
   * this only reports through HealthIndicatorService the same way any
   * other Terminus indicator would.
   */
  private async postgresIndicator() {
    const indicator = this.healthIndicatorService.check("postgres");
    const state: MigrationState = { applied: null, expected: null, matches: false };

    try {
      await this.postgresBreaker.execute(() => this.checkMigrationState(state));
      this.lastMigrationState = state;
      return indicator.up({ breakerState: this.postgresBreaker.state });
    } catch (error) {
      this.lastMigrationState = state;
      return indicator.down({ breakerState: this.postgresBreaker.state, message: (error as Error).message });
    }
  }

  /**
   * expected = the newest migration file this BUILD knows about.
   * matches = every migration file this build knows about is applied — a
   * database that has additionally applied a NEWER migration than this
   * build's own directory (the rollback-superset boundary case: an older
   * build still running during/after a rolling deploy) still counts as
   * ready, since migrations are expand/contract only and therefore
   * backward-compatible.
   */
  private async checkMigrationState(state: MigrationState): Promise<void> {
    const client = await this.pool.connect();
    try {
      const files = await listMigrationFiles(this.migrationsDir);
      const expectedNames = files.map((f) => f.name);
      state.expected = expectedNames.length > 0 ? expectedNames[expectedNames.length - 1]! : null;

      const appliedSet = await appliedMigrationNames(client);
      const appliedSorted = Array.from(appliedSet).sort();
      state.applied = appliedSorted.length > 0 ? appliedSorted[appliedSorted.length - 1]! : null;
      // STORY-120 review — `[].every(...)` is vacuously true, so a build
      // that shipped no migration files at all would report `ready` against
      // ANY database while expecting nothing: a probe that has stopped
      // comparing. Not reachable through this repository's Dockerfile
      // (which copies src/db/migrations/sql explicitly, with a comment
      // saying it was learned the hard way), and guarded here so a change
      // to that packaging cannot silently turn readiness into a rubber
      // stamp. Asserted by readiness-as-runtime-role.spec.ts.
      state.matches = expectedNames.length > 0 && expectedNames.every((name) => appliedSet.has(name));
    } finally {
      client.release();
    }
  }
}
