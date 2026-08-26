import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { EngineKey } from "./contract.js";

// STORY-031 Phase B — D6/D7/D22: a per-engine token-bucket lease acquired
// before dispatch (AC1). Runs against STORY-025's cache Valkey instance
// (`VALKEY_CACHE_URL`, system-architecture.md §11 — allkeys-lru, no
// persistence), never the queue instance. D7 — capacity/refill numbers are
// undocumented anywhere in the spec, so they are ALWAYS an injected
// `TokenBucketConfig`, never a constant in this file.

const logger = new Logger("engine-token-bucket");

export interface TokenBucketConfig {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface TokenBucketState {
  readonly tokens: number;
  readonly lastRefillMs: number;
}

export interface TokenBucketDecision extends TokenBucketState {
  readonly granted: boolean;
  readonly retryAfterMs: number;
}

/**
 * Pure — no I/O, no clock (caller supplies `nowMs`). `state === null` means
 * "no prior state" (a fresh bucket, or one the cache instance evicted —
 * D6: an eviction re-derives to full capacity, a fail-open burst, by
 * design). This is the single source of truth for the algorithm; the Lua
 * script below (LUA_TRY_ACQUIRE) is a line-for-line port of it for atomic
 * execution against Valkey — keep the two in sync.
 */
export function tokenBucketDecision(state: TokenBucketState | null, config: TokenBucketConfig, nowMs: number): TokenBucketDecision {
  let tokens = state ? state.tokens : config.capacity;
  const lastRefillMs = state ? state.lastRefillMs : nowMs;

  const elapsedMs = nowMs - lastRefillMs;
  if (elapsedMs > 0) {
    const refilled = (elapsedMs / 1000) * config.refillPerSecond;
    tokens = Math.min(config.capacity, tokens + refilled);
  }

  if (tokens >= 1) {
    return { tokens: tokens - 1, lastRefillMs: nowMs, granted: true, retryAfterMs: 0 };
  }

  const deficit = 1 - tokens;
  const retryAfterMs = Math.ceil((deficit / config.refillPerSecond) * 1000);
  return { tokens, lastRefillMs: nowMs, granted: false, retryAfterMs };
}

// Mirrors tokenBucketDecision() above exactly — KEYS[1] is the bucket's
// hash key; ARGV = [capacity, refillPerSecond, nowMs, ttlSeconds]. A single
// EVAL is Redis's own atomicity boundary, which is what makes concurrent
// tryAcquire calls never over-grant (proven by
// test/integration/engine-token-bucket.spec.ts, not by this unit-level
// pure function).
const LUA_TRY_ACQUIRE = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSecond = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local tokens = capacity
local lastRefillMs = now

local existing = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
if existing[1] and existing[2] then
  tokens = tonumber(existing[1])
  lastRefillMs = tonumber(existing[2])
end

local elapsedMs = now - lastRefillMs
if elapsedMs > 0 then
  local refilled = (elapsedMs / 1000) * refillPerSecond
  tokens = math.min(capacity, tokens + refilled)
end

local granted = 0
local retryAfterMs = 0

if tokens >= 1 then
  tokens = tokens - 1
  granted = 1
else
  local deficit = 1 - tokens
  retryAfterMs = math.ceil((deficit / refillPerSecond) * 1000)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefillMs', tostring(now))
redis.call('EXPIRE', key, ttl)

return {granted, retryAfterMs}
`;

interface TokenBucketRedisCommands {
  tokenBucketTryAcquire(key: string, capacity: string, refillPerSecond: string, nowMs: string, ttlSeconds: string): Promise<[number, number]>;
}

type TokenBucketRedis = Redis & Partial<TokenBucketRedisCommands>;

const KEY_PREFIX = "engine-bucket";

function bucketKey(engineKey: EngineKey): string {
  return `${KEY_PREFIX}:${engineKey}`;
}

/** Generous enough that a bucket never expires mid-use under steady load, but does not linger forever once an engine goes quiet: 2x the time to refill from empty to full capacity, floored at 60s. */
function ttlSecondsFor(config: TokenBucketConfig): number {
  return Math.max(60, Math.ceil((config.capacity / config.refillPerSecond) * 2));
}

export interface TokenBucketLeaseResult {
  readonly granted: boolean;
  readonly retryAfterMs: number;
}

export class TokenBucket {
  private readonly redis: TokenBucketRedis;
  private readonly clock: () => number;

  constructor(redis: Redis, clock: () => number = () => Date.now()) {
    this.redis = redis as TokenBucketRedis;
    if (typeof this.redis.tokenBucketTryAcquire !== "function") {
      this.redis.defineCommand("tokenBucketTryAcquire", { numberOfKeys: 1, lua: LUA_TRY_ACQUIRE });
    }
    this.clock = clock;
  }

  /**
   * D19 — fails OPEN on a store error: never hard-fails a capture because
   * the rate limiter's own store is down. A cache-instance outage is
   * therefore indistinguishable, to the caller, from an always-available
   * engine — the safer failure mode for a capacity-protection mechanism
   * that is not itself a correctness guarantee.
   */
  async tryAcquire(engineKey: EngineKey, config: TokenBucketConfig): Promise<TokenBucketLeaseResult> {
    try {
      const [granted, retryAfterMs] = await this.redis.tokenBucketTryAcquire!(
        bucketKey(engineKey),
        String(config.capacity),
        String(config.refillPerSecond),
        String(Math.floor(this.clock())),
        String(ttlSecondsFor(config)),
      );
      return { granted: granted === 1, retryAfterMs };
    } catch (error) {
      logger.warn(`token bucket store unavailable for engine '${engineKey}' — failing open: ${(error as Error).message}`);
      return { granted: true, retryAfterMs: 0 };
    }
  }
}
