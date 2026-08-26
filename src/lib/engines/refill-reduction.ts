import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { EngineKey } from "./contract.js";
import type { TokenBucketConfig } from "./token-bucket.js";

// STORY-031 Phase G stage 2 — EC-06: "reduce the engine's token-bucket
// refill by 50% for 15 minutes; re-delay affected jobs with jitter inside
// the run window." Both numbers here are exact reference constants, not
// interpolations. "Restores exactly" is structural: the base config is
// NEVER mutated — applyRefillReduction() always computes from it fresh, so
// once the window elapses the result is byte-identical to the original,
// never a decayed or compounded value.

export const REFILL_REDUCTION_FACTOR = 0.5;
export const REFILL_REDUCTION_DURATION_MS = 15 * 60 * 1000;

const logger = new Logger("engine-refill-reduction");

/** Pure. `reducedUntilMs === null` or already elapsed (`nowMs >= reducedUntilMs`) → the base config, completely unchanged. */
export function applyRefillReduction(base: TokenBucketConfig, reducedUntilMs: number | null, nowMs: number): TokenBucketConfig {
  if (reducedUntilMs !== null && nowMs < reducedUntilMs) {
    return { ...base, refillPerSecond: base.refillPerSecond * REFILL_REDUCTION_FACTOR };
  }
  return base;
}

export interface RefillReductionStore {
  read(engineKey: EngineKey): Promise<number | null>;
  write(engineKey: EngineKey, reducedUntilMs: number): Promise<void>;
}

/** D5-style shared state so a reduction triggered by one replica applies fleet-wide, not just to whichever replica observed the rate_limited failure. */
export class ValkeyRefillReductionStore implements RefillReductionStore {
  private static readonly KEY_PREFIX = "engine-refill-reduction";

  constructor(private readonly redis: Redis) {}

  async read(engineKey: EngineKey): Promise<number | null> {
    const raw = await this.redis.get(`${ValkeyRefillReductionStore.KEY_PREFIX}:${engineKey}`);
    return raw === null ? null : Number(raw);
  }

  async write(engineKey: EngineKey, reducedUntilMs: number): Promise<void> {
    try {
      const ttlSeconds = Math.max(60, Math.ceil(REFILL_REDUCTION_DURATION_MS / 1000) + 60);
      await this.redis.set(`${ValkeyRefillReductionStore.KEY_PREFIX}:${engineKey}`, String(reducedUntilMs), "EX", ttlSeconds);
    } catch (error) {
      logger.warn(`failed to persist refill reduction for engine '${engineKey}' — best-effort: ${(error as Error).message}`);
    }
  }
}

export class RefillReductionTracker {
  constructor(
    private readonly store: RefillReductionStore,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Stage 2 fires: cuts refill by 50% starting now, for exactly
   * REFILL_REDUCTION_DURATION_MS. Phase J/D19's spirit — never throws: a
   * store outage here must never fail whatever triggered the detection.
   */
  async trigger(engineKey: EngineKey): Promise<void> {
    try {
      await this.store.write(engineKey, this.clock() + REFILL_REDUCTION_DURATION_MS);
    } catch (error) {
      logger.warn(`failed to trigger refill reduction for engine '${engineKey}' — best-effort: ${(error as Error).message}`);
    }
  }

  /** Phase J/D19's spirit — a read failure never throws or blocks a lease decision; it falls back to the base config unchanged (never invents an active reduction it can't confirm). */
  async effectiveConfig(engineKey: EngineKey, base: TokenBucketConfig): Promise<TokenBucketConfig> {
    try {
      const reducedUntilMs = await this.store.read(engineKey);
      return applyRefillReduction(base, reducedUntilMs, this.clock());
    } catch (error) {
      logger.warn(`failed to read refill reduction state for engine '${engineKey}' — falling back to the base config: ${(error as Error).message}`);
      return base;
    }
  }
}
