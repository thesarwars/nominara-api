import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { EngineHealthService } from "../../modules/health/engine-health.service.js";
import { CANARY_INTERVAL_MS, EngineCanary, ValkeyCanaryDueStore, runElectedCanaryRound } from "./canary.js";
import type { EngineKey } from "./contract.js";
import { EngineBreakerRegistry } from "./engine-breaker-registry.js";
import { ACTIVE_ENGINE_KEYS, healthProbeEngine } from "./registry.js";

// STORY-031 Phase F — the production seam src/worker.ts wires for the
// capture worker group ONLY (D2/EC-06's 5-minute canary is a capture
// concern; no other worker group probes engines). Owns its own poll
// interval (checking "is a round due" far more often than the round itself
// actually runs — the real 5-minute cadence lives in EngineCanary's own
// due-check) plus the Postgres client borrow/BEGIN/COMMIT/release around
// the elected round.

const logger = new Logger("engine-canary-runtime");

/** How often this process CHECKS whether a round is due — NOT the round's own cadence (CANARY_INTERVAL_MS). Deliberately much shorter, so a due round is picked up promptly without every replica hammering Postgres every 5 minutes on the dot. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface CanaryRuntimeOptions {
  readonly pool: Pool;
  readonly cacheRedis: Redis;
  readonly engines?: readonly EngineKey[];
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
}

export class CanaryRuntime {
  private readonly canary: EngineCanary;
  private readonly pool: Pool;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: CanaryRuntimeOptions) {
    this.pool = options.pool;
    const engineHealth = new EngineHealthService(options.pool);
    const breakers = new EngineBreakerRegistry(options.cacheRedis, options.clock);
    const clock = options.clock ?? (() => Date.now());

    this.canary = new EngineCanary(
      options.engines ?? ACTIVE_ENGINE_KEYS,
      healthProbeEngine,
      async (engineKey, result) => {
        // D10 — the canary feeds the SAME engine_health counters a
        // customer attempt would; there is no `source` column to
        // distinguish them (known limitation, disclosed in the story file).
        const decision = await breakers.for(engineKey).recordOutcome(result.ok ? "success" : "blocked");
        await engineHealth.recordAttempt({
          engineKey,
          atMs: clock(),
          outcome: result.ok ? "success" : "blocked",
          latencyMs: result.latencyMs,
          circuitState: decision.state,
        });
      },
      new ValkeyCanaryDueStore(options.cacheRedis),
      CANARY_INTERVAL_MS,
      clock,
    );

    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Best-effort, always: a store/DB outage here must never crash the worker process (D19's spirit). */
  async tick(): Promise<void> {
    let client;
    try {
      client = await this.pool.connect();
    } catch (error) {
      logger.warn(`canary tick: failed to acquire a Postgres client — skipping this round: ${(error as Error).message}`);
      return;
    }

    try {
      await client.query("BEGIN");
      await runElectedCanaryRound(client, this.canary);
      await client.query("COMMIT");
    } catch (error) {
      logger.warn(`canary tick failed — best-effort, never crashes the worker: ${(error as Error).message}`);
      try {
        await client.query("ROLLBACK");
      } catch {
        // already broken — nothing more to do.
      }
    } finally {
      client.release();
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        logger.warn(`unexpected canary tick error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
