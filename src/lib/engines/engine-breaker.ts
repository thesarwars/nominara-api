import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { CircuitBreaker, CircuitOpenError, type CircuitState } from "../resilience/circuit-breaker.js";
import type { EngineKey } from "./contract.js";

// STORY-031 Phase D — D3: this is NOT the generic NFR-ARCH-05 breaker
// (wrong trigger — a 50%-rolling-error-rate condition). This composes
// circuit-breaker.ts purely for its clock-based open→half_open computation
// and its `forceOpen()` seam; the OPEN decision itself is entirely this
// file's own EC-06 stage-4 (blocks/attempts>0.25) and EC-08
// (quota_exhausted, immediate) logic — `errorThresholdPercentage: Infinity`
// below permanently disables the composed breaker's OWN internal trigger,
// so it can only ever open via an explicit forceOpen() call from here.

const logger = new Logger("engine-breaker");

/** EC-06 stage 4 — exact reference constant, not an interpolation. */
export const ENGINE_BREAKER_BLOCK_RATIO_THRESHOLD = 0.25;

/**
 * D4 — THIS STORY'S OWN INTERPOLATION, not a reference constant. EC-06
 * states the stage-4 RE-QUEUE delay is 20 minutes; it never states the
 * breaker's own open duration. Chosen so a cell re-queued at that delay
 * arrives back to a half-open breaker rather than a still-open one.
 */
export const ENGINE_BREAKER_OPEN_DURATION_MS = 20 * 60 * 1000;

/**
 * D4 (again) — also an interpolation: EC-06 states a 15-minute window ONLY
 * for the stage-3 block-rate ALARM ("blocks/attempts > 0.10 over 15
 * minutes"); it never restates a window for stage 4's ratio. Reusing the
 * same 15-minute window for stage 4 is this file's own assumption, not a
 * second reference constant.
 */
export const ENGINE_BREAKER_RATIO_WINDOW_MS = 15 * 60 * 1000;

/**
 * `transient_failure` (STORY-031 review fix) is a retryable transport failure - rate_limited, timeout, upstream_5xx
 * (failure-taxonomy.ts). Closed, it is an attempt in the ratio's denominator like any other non-block; HALF-OPEN it is NEUTRAL:
 * it neither closes nor re-opens the breaker, because it is not evidence that would have opened a closed one (EC-06 stage 4 opens
 * on the block ratio; `rate_limited` is a stage-2 trigger). `other_failure` keeps its meaning for every other failure.
 */
export type EngineOutcome = "success" | "blocked" | "quota_exhausted" | "transient_failure" | "other_failure";

export interface EngineBreakerDecision {
  readonly state: CircuitState;
  /** false ONLY for quota_exhausted (EC-08's "zero retries") — never for a ratio-driven or half-open-trial-driven open. */
  readonly retry: boolean;
}

/** Why the breaker last opened: EC-08 quota exhaustion, or the EC-06 stage-4 block ratio (or a failed half-open probe). */
export type EngineBreakerOpenReason = "quota" | "ratio";

/**
 * STORY-031 AC6/AC7 - the breaker's current EPISODE: when it left `closed`, and why it last opened. `since` survives the
 * half-open probe that fails and re-opens the breaker, so "circuit open > 30 min" (EC-06 stage 5) is measured across
 * re-opens, not reset by each one.
 */
export interface EngineBreakerDetail {
  readonly state: CircuitState;
  /** The current open window's start (epoch ms), or null when closed. */
  readonly openedAt: number | null;
  /** When the breaker left `closed` for this episode (epoch ms), or null when closed. */
  readonly since: number | null;
  readonly reason: EngineBreakerOpenReason | null;
}

export interface EngineBreakerEpisode {
  readonly since: number;
  readonly reason: EngineBreakerOpenReason;
}

/** Where the episode lives (Valkey in production, next to the state key). Best-effort like the state store's writes. */
export interface EngineBreakerEpisodeStore {
  read(engineKey: EngineKey): Promise<EngineBreakerEpisode | null>;
  write(engineKey: EngineKey, episode: EngineBreakerEpisode | null): Promise<void>;
}

export interface EngineBreakerStateStore {
  /** Returns the persisted `openedAt` (epoch ms), or null if closed / never opened. */
  read(engineKey: EngineKey): Promise<number | null>;
  write(engineKey: EngineKey, openedAt: number | null): Promise<void>;
}

export interface EngineBreakerRatioCounter {
  /** Records one attempt (and, if `isBlocked`, one block) into the rolling window; returns the window's current totals. */
  record(engineKey: EngineKey, isBlocked: boolean): Promise<{ attempts: number; blocks: number }>;
  /** STORY-031 AC6 - the window's current totals WITHOUT recording an attempt (the ladder evaluator reads, it never counts). */
  peek?(engineKey: EngineKey): Promise<{ attempts: number; blocks: number }>;
}

/**
 * D5 — breaker state lives in Valkey, shared across every replica, never
 * in-process only. Reads are the resilience boundary for D19 ("breaker
 * state fails CLOSED to last-known-state, defaulting closed if no state
 * exists") — a `read()` failure here falls back to the LAST value this
 * instance itself successfully read, or closed if it never has. Writes are
 * best-effort: a write failure is logged and swallowed, never thrown —
 * recording breaker state must never fail the job that triggered it.
 */
export class ValkeyEngineBreakerStateStore implements EngineBreakerStateStore {
  private static readonly KEY_PREFIX = "engine-breaker:state";
  /** Comfortably longer than the 20-minute open window, so a legitimate open state is never evicted mid-window; an eviction otherwise just means "assume closed again" (D6's re-derivable framing). */
  private static readonly TTL_SECONDS = 6 * 60 * 60;

  constructor(private readonly redis: Redis) {}

  private key(engineKey: EngineKey): string {
    return `${ValkeyEngineBreakerStateStore.KEY_PREFIX}:${engineKey}`;
  }

  async read(engineKey: EngineKey): Promise<number | null> {
    const raw = await this.redis.get(this.key(engineKey));
    return raw === null ? null : Number(raw);
  }

  async write(engineKey: EngineKey, openedAt: number | null): Promise<void> {
    try {
      if (openedAt === null) {
        await this.redis.del(this.key(engineKey));
      } else {
        await this.redis.set(this.key(engineKey), String(openedAt), "EX", ValkeyEngineBreakerStateStore.TTL_SECONDS);
      }
    } catch (error) {
      logger.warn(`failed to persist breaker state for engine '${engineKey}' — best-effort, job unaffected: ${(error as Error).message}`);
    }
  }
}

/**
 * STORY-031 - the breaker's episode beside its state key, with the same TTL posture. Reads THROW (the breaker falls back to
 * `openedAt` as the episode start); writes are best-effort and never fail the job, like the state store's.
 */
export class ValkeyEngineBreakerEpisodeStore implements EngineBreakerEpisodeStore {
  private static readonly KEY_PREFIX = "engine-breaker:episode";
  private static readonly TTL_SECONDS = 6 * 60 * 60;

  constructor(private readonly redis: Redis) {}

  private key(engineKey: EngineKey): string {
    return `${ValkeyEngineBreakerEpisodeStore.KEY_PREFIX}:${engineKey}`;
  }

  async read(engineKey: EngineKey): Promise<EngineBreakerEpisode | null> {
    const raw = await this.redis.get(this.key(engineKey));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { since?: unknown; reason?: unknown };
    if (typeof parsed.since !== "number" || (parsed.reason !== "quota" && parsed.reason !== "ratio")) return null;
    return { since: parsed.since, reason: parsed.reason };
  }

  async write(engineKey: EngineKey, episode: EngineBreakerEpisode | null): Promise<void> {
    try {
      if (episode === null) {
        await this.redis.del(this.key(engineKey));
      } else {
        await this.redis.set(this.key(engineKey), JSON.stringify(episode), "EX", ValkeyEngineBreakerEpisodeStore.TTL_SECONDS);
      }
    } catch (error) {
      logger.warn(`failed to persist breaker episode for engine '${engineKey}' — best-effort, job unaffected: ${(error as Error).message}`);
    }
  }
}

// Mirrors a tumbling (not sliding) window: once `now - windowStart` exceeds
// `windowMs`, the window resets to just this one event rather than
// continuously sliding — a disclosed simplification, not a reference
// algorithm.
const LUA_RECORD_OUTCOME = `
local key = KEYS[1]
local isBlocked = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])

local existing = redis.call('HMGET', key, 'attempts', 'blocks', 'windowStart')
local attempts = 0
local blocks = 0
local windowStart = now

if existing[1] and existing[3] then
  local priorWindowStart = tonumber(existing[3])
  if (now - priorWindowStart) <= windowMs then
    attempts = tonumber(existing[1])
    blocks = tonumber(existing[2])
    windowStart = priorWindowStart
  end
end

attempts = attempts + 1
if isBlocked == 1 then
  blocks = blocks + 1
end

redis.call('HSET', key, 'attempts', attempts, 'blocks', blocks, 'windowStart', windowStart)
redis.call('PEXPIRE', key, windowMs * 2)

return {attempts, blocks}
`;

interface EngineBreakerRatioRedisCommands {
  engineBreakerRecordOutcome(key: string, isBlocked: string, nowMs: string, windowMs: string): Promise<[number, number]>;
}

type EngineBreakerRatioRedis = Redis & Partial<EngineBreakerRatioRedisCommands>;

/** Best-effort: a store outage returns {0,0} (the ratio check simply can't fire this round) rather than throwing — accounting must never fail the job (D19's "health recording" posture, extended to this ratio counter). */
export class ValkeyEngineBreakerRatioCounter implements EngineBreakerRatioCounter {
  private static readonly KEY_PREFIX = "engine-breaker:ratio";
  private readonly redis: EngineBreakerRatioRedis;

  constructor(
    redis: Redis,
    private readonly windowMs: number = ENGINE_BREAKER_RATIO_WINDOW_MS,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.redis = redis as EngineBreakerRatioRedis;
    if (typeof this.redis.engineBreakerRecordOutcome !== "function") {
      this.redis.defineCommand("engineBreakerRecordOutcome", { numberOfKeys: 1, lua: LUA_RECORD_OUTCOME });
    }
  }

  /** Throws on a store outage: the ladder evaluator skips the engine rather than reading "no blocks". */
  async peek(engineKey: EngineKey): Promise<{ attempts: number; blocks: number }> {
    const [attempts, blocks, windowStart] = await this.redis.hmget(`${ValkeyEngineBreakerRatioCounter.KEY_PREFIX}:${engineKey}`, "attempts", "blocks", "windowStart");
    if (attempts === null || windowStart === null || this.clock() - Number(windowStart) > this.windowMs) return { attempts: 0, blocks: 0 };
    return { attempts: Number(attempts), blocks: Number(blocks ?? 0) };
  }

  async record(engineKey: EngineKey, isBlocked: boolean): Promise<{ attempts: number; blocks: number }> {
    try {
      const [attempts, blocks] = await this.redis.engineBreakerRecordOutcome!(
        `${ValkeyEngineBreakerRatioCounter.KEY_PREFIX}:${engineKey}`,
        isBlocked ? "1" : "0",
        String(Math.floor(this.clock())),
        String(this.windowMs),
      );
      return { attempts, blocks };
    } catch (error) {
      logger.warn(`failed to record breaker ratio outcome for engine '${engineKey}' — best-effort: ${(error as Error).message}`);
      return { attempts: 0, blocks: 0 };
    }
  }
}

/**
 * Per-engine circuit breaker (AC: "with the documented thresholds and
 * half-open probing"). Composes CircuitBreaker (D3) purely for its
 * clock-based state computation; every OPEN decision is driven by THIS
 * class's own EC-06/EC-08 rules, persisted via `store` so every replica
 * agrees (D5), with D19's fail-closed-to-last-known posture on a read
 * failure.
 */
export class EngineBreaker {
  private breaker: CircuitBreaker;
  private lastKnownOpenedAt: number | null = null;

  constructor(
    private readonly engineKey: EngineKey,
    private readonly store: EngineBreakerStateStore,
    private readonly ratioCounter: EngineBreakerRatioCounter,
    private readonly clock: () => number = () => Date.now(),
    private readonly episodes: EngineBreakerEpisodeStore | null = null,
  ) {
    this.breaker = this.freshBreaker();
  }

  private freshBreaker(): CircuitBreaker {
    return new CircuitBreaker({
      name: this.engineKey,
      clock: this.clock,
      openDurationMs: ENGINE_BREAKER_OPEN_DURATION_MS,
      // Disables the composed breaker's OWN rolling-error-rate trigger
      // entirely (D3) — errorRate can never reach Infinity, so record()
      // never calls open() on its own; only this file's forceOpen() calls do.
      errorThresholdPercentage: Number.POSITIVE_INFINITY,
    });
  }

  /** D19 — a read failure falls back to the last value THIS instance itself successfully read, defaulting to closed (null) if it never has. */
  private async sync(): Promise<void> {
    let openedAt: number | null;
    try {
      openedAt = await this.store.read(this.engineKey);
      this.lastKnownOpenedAt = openedAt;
    } catch (error) {
      logger.warn(`breaker state store unreadable for engine '${this.engineKey}' — falling back to last-known state: ${(error as Error).message}`);
      openedAt = this.lastKnownOpenedAt;
    }

    this.breaker = this.freshBreaker();
    if (openedAt !== null) {
      this.breaker.forceOpen(openedAt);
    }
  }

  /**
   * The state plus the current episode. An unreadable episode store never fails it: the episode start falls back to the open
   * window's start and the reason to null (the capture path then treats the breaker as ratio-opened: re-queue, not skip).
   */
  async detail(): Promise<EngineBreakerDetail> {
    await this.sync();
    const state = this.breaker.state;
    if (state === "closed" || this.lastKnownOpenedAt === null) return { state: "closed", openedAt: null, since: null, reason: null };
    const episode = await this.readEpisode();
    return { state, openedAt: this.lastKnownOpenedAt, since: Math.min(episode?.since ?? this.lastKnownOpenedAt, this.lastKnownOpenedAt), reason: episode?.reason ?? null };
  }

  /** blocks/attempts over the rolling window WITHOUT recording an attempt; 0 with no attempts (never NaN). Throws on a store outage. */
  async blockRatio(): Promise<number> {
    const totals = this.ratioCounter.peek === undefined ? { attempts: 0, blocks: 0 } : await this.ratioCounter.peek(this.engineKey);
    return totals.attempts > 0 ? totals.blocks / totals.attempts : 0;
  }

  private async readEpisode(): Promise<EngineBreakerEpisode | null> {
    if (this.episodes === null) return null;
    try {
      return await this.episodes.read(this.engineKey);
    } catch (error) {
      logger.warn(`breaker episode store unreadable for engine '${this.engineKey}' — using the open window's start: ${(error as Error).message}`);
      return null;
    }
  }

  private async writeEpisode(episode: EngineBreakerEpisode | null): Promise<void> {
    if (this.episodes === null) return;
    try {
      await this.episodes.write(this.engineKey, episode);
    } catch (error) {
      logger.warn(`failed to persist breaker episode for engine '${this.engineKey}' — best-effort: ${(error as Error).message}`);
    }
  }

  async state(): Promise<CircuitState> {
    await this.sync();
    return this.breaker.state;
  }

  /** Throws CircuitOpenError while open. A half_open breaker admits every concurrent call through — there is no single-trial gate limiting how many calls may probe at once (EC-06 states no half-open trial count for engines, so unlimited concurrent admission during half-open is this story's own choice, not a gap against the spec). recordOutcome()'s outcomes still resolve the breaker back to closed (success) or open (failure) for every caller, whichever outcome that instance's `sync()` observes last. */
  async admit(): Promise<void> {
    await this.sync();
    if (this.breaker.state === "open") {
      throw new CircuitOpenError(this.engineKey);
    }
  }

  async recordOutcome(outcome: EngineOutcome): Promise<EngineBreakerDecision> {
    await this.sync();

    if (outcome === "quota_exhausted") {
      // EC-08 — opens immediately, no ratio check, zero retries.
      return this.open(false);
    }

    if (this.breaker.state === "open") {
      // Defensive only — a caller using admit() first would never reach
      // here while fully open. Reports the current state without touching
      // any counter, rather than silently re-extending the open window.
      return { state: "open", retry: true };
    }

    if (this.breaker.state === "half_open") {
      if (outcome === "success") {
        await this.store.write(this.engineKey, null);
        await this.writeEpisode(null);
        this.lastKnownOpenedAt = null;
        this.breaker = this.freshBreaker();
        return { state: "closed", retry: true };
      }
      // A transient vendor failure is no verdict on the probe: the breaker stays half-open for the next attempt to decide.
      if (outcome === "transient_failure") return { state: "half_open", retry: true };
      // Any other failure recorded while half_open reopens for another full
      // window — "half-open probing" per the AC. No single-trial gate:
      // concurrent half-open calls are all admitted (see admit()'s
      // docstring); this only governs what recordOutcome() itself does.
      return this.open(true);
    }

    // closed — every outcome (success AND failure alike) feeds the ratio
    // window: `attempts` must count everything, `blocks` only `blocked`
    // outcomes, or the denominator would silently only ever count failures.
    const { attempts, blocks } = await this.ratioCounter.record(this.engineKey, outcome === "blocked");
    if (attempts > 0 && blocks / attempts > ENGINE_BREAKER_BLOCK_RATIO_THRESHOLD) {
      return this.open(true);
    }
    return { state: this.breaker.state, retry: true };
  }

  private async open(retry: boolean): Promise<EngineBreakerDecision> {
    const at = this.clock();
    // The episode starts when the breaker LEAVES closed. A re-open from half_open (or a quota open while already open) keeps it.
    const wasClosed = this.breaker.state === "closed";
    const prior = wasClosed ? null : await this.readEpisode();
    this.breaker.forceOpen(at);
    this.lastKnownOpenedAt = at;
    await this.store.write(this.engineKey, at);
    await this.writeEpisode({ since: prior?.since ?? at, reason: retry ? "ratio" : "quota" });
    return { state: "open", retry };
  }
}
