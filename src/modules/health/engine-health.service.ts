import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../../db/pg-pool.js";
import type { EngineKey } from "../../lib/engines/contract.js";
import { healthBucketStart, percentile } from "../../lib/engines/engine-health.js";
import type { CircuitState } from "../../lib/resilience/circuit-breaker.js";

// STORY-031 Phase E — `engine_health` is "global telemetry, deliberately no
// workspace_id" (0003_projects_prompts_captures.up.sql) — NOT a tenant
// table, so this queries the pool directly (same posture HealthService's
// own migration-state check already uses for a global table), never
// through a tenant-context-carrying transaction. D11: no migration, no
// DDL — this only writes columns that already exist.

export type EngineHealthOutcome = "success" | "blocked" | "timeout" | "rate_limited" | "other_failure";

export interface EngineHealthEvent {
  readonly engineKey: EngineKey;
  readonly atMs: number;
  readonly outcome: EngineHealthOutcome;
  readonly latencyMs?: number;
  readonly circuitState: CircuitState;
}

/**
 * D16 — AC10's per-engine status surface. NOT a reference constant: no
 * spec names a window size for this surface, so this is this story's own
 * choice, disclosed rather than silently baked in.
 */
export const PER_ENGINE_STATUS_WINDOW_MS = 60 * 60 * 1000;

export interface EnginePerEngineStatus {
  readonly engineKey: EngineKey;
  readonly status: string;
  readonly attempts: number;
  readonly successes: number;
  readonly blocks: number;
  readonly timeouts: number;
  readonly rateLimited: number;
  /** From the LATEST bucket only — combining already-computed per-bucket percentiles across buckets would be mathematically wrong. */
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly circuitState: CircuitState;
}

@Injectable()
export class EngineHealthService {
  private readonly logger = new Logger(EngineHealthService.name);

  /**
   * Per-PROCESS latency reservoir, keyed by `<engineKey>:<bucketStart ISO>`.
   * p50/p95 are computed from THIS process's own observed samples and
   * OVERWRITE the row on every upsert (never combined with another
   * replica's view) — a fleet of replicas each writes its own latest
   * observation, last-write-wins. An exact cross-replica percentile would
   * need either a shared sample store or an approximate streaming quantile
   * sketch; out of scope for this story's first cut, and disclosed here
   * rather than silently presented as something stronger.
   */
  private readonly latencies = new Map<string, number[]>();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async recordAttempt(event: EngineHealthEvent): Promise<void> {
    const bucketStart = healthBucketStart(event.atMs);
    const reservoirKey = `${event.engineKey}:${bucketStart.toISOString()}`;

    if (event.latencyMs !== undefined) {
      const samples = this.latencies.get(reservoirKey) ?? [];
      samples.push(event.latencyMs);
      this.latencies.set(reservoirKey, samples);
    }

    const samples = this.latencies.get(reservoirKey);
    const sorted = samples ? [...samples].sort((a, b) => a - b) : [];
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);

    const successes = event.outcome === "success" ? 1 : 0;
    const blocks = event.outcome === "blocked" ? 1 : 0;
    const timeouts = event.outcome === "timeout" ? 1 : 0;
    const rateLimited = event.outcome === "rate_limited" ? 1 : 0;

    try {
      await this.pool.query(
        `INSERT INTO engine_health
           (engine_key, bucket_start, attempts, successes, blocks, timeouts, rate_limited, p50_latency_ms, p95_latency_ms, circuit_state)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (engine_key, bucket_start) DO UPDATE SET
           attempts = engine_health.attempts + 1,
           successes = engine_health.successes + EXCLUDED.successes,
           blocks = engine_health.blocks + EXCLUDED.blocks,
           timeouts = engine_health.timeouts + EXCLUDED.timeouts,
           rate_limited = engine_health.rate_limited + EXCLUDED.rate_limited,
           p50_latency_ms = EXCLUDED.p50_latency_ms,
           p95_latency_ms = EXCLUDED.p95_latency_ms,
           circuit_state = EXCLUDED.circuit_state`,
        [event.engineKey, bucketStart.toISOString(), successes, blocks, timeouts, rateLimited, p50, p95, event.circuitState],
      );
    } catch (error) {
      // D19 — health recording is best-effort: it must never fail the job
      // that triggered it.
      this.logger.warn(`failed to record engine_health for '${event.engineKey}': ${(error as Error).message}`);
    }
  }

  /**
   * D16 — a service method, not a new HTTP route (api-specification.md's
   * endpoint registry has no such route; mirrors STORY-030's D9 reasoning
   * for admin replay). Sums counts over the trailing PER_ENGINE_STATUS_WINDOW_MS;
   * latency and circuit_state come from the single most recent bucket.
   */
  async perEngineStatus(engineKey: EngineKey, atMs: number = Date.now()): Promise<EnginePerEngineStatus> {
    const windowStart = new Date(atMs - PER_ENGINE_STATUS_WINDOW_MS).toISOString();

    const [sums, latest, engineRow] = await Promise.all([
      this.pool.query<{ attempts: string; successes: string; blocks: string; timeouts: string; rate_limited: string }>(
        `SELECT
           COALESCE(SUM(attempts), 0) AS attempts,
           COALESCE(SUM(successes), 0) AS successes,
           COALESCE(SUM(blocks), 0) AS blocks,
           COALESCE(SUM(timeouts), 0) AS timeouts,
           COALESCE(SUM(rate_limited), 0) AS rate_limited
         FROM engine_health
         WHERE engine_key = $1 AND bucket_start >= $2`,
        [engineKey, windowStart],
      ),
      this.pool.query<{ p50_latency_ms: number | null; p95_latency_ms: number | null; circuit_state: CircuitState }>(
        `SELECT p50_latency_ms, p95_latency_ms, circuit_state
         FROM engine_health
         WHERE engine_key = $1
         ORDER BY bucket_start DESC
         LIMIT 1`,
        [engineKey],
      ),
      this.pool.query<{ status: string }>("SELECT status FROM engines WHERE key = $1", [engineKey]),
    ]);

    const sumRow = sums.rows[0]!;
    const latestRow = latest.rows[0];

    return {
      engineKey,
      status: engineRow.rows[0]?.status ?? "active",
      attempts: Number(sumRow.attempts),
      successes: Number(sumRow.successes),
      blocks: Number(sumRow.blocks),
      timeouts: Number(sumRow.timeouts),
      rateLimited: Number(sumRow.rate_limited),
      p50LatencyMs: latestRow?.p50_latency_ms ?? null,
      p95LatencyMs: latestRow?.p95_latency_ms ?? null,
      circuitState: latestRow?.circuit_state ?? "closed",
    };
  }

  /**
   * STORY-179 — when each engine last had a successful attempt, for the blackout monitor. `engine_health` is
   * bucketed, so this is the START of the latest bucket holding a success: it can understate the real instant by up to
   * HEALTH_BUCKET_MS, never overstate it. `null` is an engine with no success on record, which is not the same as one
   * whose last success was long ago. Unlike recordAttempt this does not swallow errors: a failed read must not look
   * like "no success".
   */
  async lastSuccessAtMs(engineKeys: readonly EngineKey[]): Promise<Map<EngineKey, number | null>> {
    const result = await this.pool.query<{ engine_key: EngineKey; last_success: Date }>(
      `SELECT engine_key, MAX(bucket_start) AS last_success
       FROM engine_health
       WHERE successes > 0 AND engine_key = ANY($1::text[])
       GROUP BY engine_key`,
      [[...engineKeys]],
    );
    const found = new Map(result.rows.map((row) => [row.engine_key, row.last_success.getTime()]));
    return new Map(engineKeys.map((key) => [key, found.get(key) ?? null]));
  }
}
