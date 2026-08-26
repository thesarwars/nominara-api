import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";

// STORY-031 Phase C — AC2/D8: a per-target-host crawl limit, independent of
// the per-engine token buckets (disjoint Valkey keyspace: `host-limit:*`
// here vs `engine-bucket:*` in token-bucket.ts). aux-and-geo-analysis.md's
// politeness section / FR-AUX-01c states three EXACT numbers — these are
// reference constants, pinned verbatim, never an interpolation.

/** D8 — ≤2 req/sec/host, expressed as the minimum interval between requests to the same host. Never decreased by a `Crawl-delay` header, only ever increased. */
export const HOST_RATE_LIMIT_MIN_INTERVAL_MS = 500;

const logger = new Logger("engine-host-rate-limiter");

export interface HostRateLimiterConfig {
  /** The target's robots.txt `Crawl-delay`, in ms, if any. Only ever RAISES the effective interval above the 500ms floor — never lowers it (D8). */
  readonly crawlDelayMs?: number;
}

export interface HostRateLimiterDecision {
  readonly nextAllowedAt: number;
  readonly granted: boolean;
  readonly retryAfterMs: number;
}

/** Pure — no I/O, no clock. `nextAllowedAt === null` means no prior state (a fresh host, or one the cache instance evicted — re-derivable, same D6 framing as the token bucket). */
export function hostRateLimiterDecision(nextAllowedAt: number | null, config: HostRateLimiterConfig, nowMs: number): HostRateLimiterDecision {
  const intervalMs = Math.max(HOST_RATE_LIMIT_MIN_INTERVAL_MS, config.crawlDelayMs ?? 0);
  const gate = nextAllowedAt ?? nowMs;

  if (nowMs >= gate) {
    return { nextAllowedAt: nowMs + intervalMs, granted: true, retryAfterMs: 0 };
  }
  return { nextAllowedAt: gate, granted: false, retryAfterMs: gate - nowMs };
}

// Mirrors hostRateLimiterDecision() above exactly — KEYS[1] is the host's
// gate key; ARGV = [minIntervalMs, crawlDelayMs, nowMs, ttlSeconds].
const LUA_TRY_ACQUIRE = `
local key = KEYS[1]
local minIntervalMs = tonumber(ARGV[1])
local crawlDelayMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local intervalMs = minIntervalMs
if crawlDelayMs > intervalMs then
  intervalMs = crawlDelayMs
end

local gate = now
local existing = redis.call('GET', key)
if existing then
  gate = tonumber(existing)
end

local granted = 0
local nextAllowedAt = gate
local retryAfterMs = 0

if now >= gate then
  granted = 1
  nextAllowedAt = now + intervalMs
else
  retryAfterMs = gate - now
end

redis.call('SET', key, tostring(nextAllowedAt), 'EX', ttl)

return {granted, retryAfterMs}
`;

interface HostRateLimiterRedisCommands {
  hostRateLimiterTryAcquire(key: string, minIntervalMs: string, crawlDelayMs: string, nowMs: string, ttlSeconds: string): Promise<[number, number]>;
}

type HostRateLimiterRedis = Redis & Partial<HostRateLimiterRedisCommands>;

const KEY_PREFIX = "host-limit";

/** Hosts are case-insensitive and port-suffix-sensitive as a plain string key — normalization (scheme stripping, punycode, etc.) is the caller's job, not this limiter's. */
function hostKey(host: string): string {
  return `${KEY_PREFIX}:${host.toLowerCase()}`;
}

/** A denied wait is at most one Crawl-delay-inflated interval; the TTL only needs to outlive that, generously. */
function ttlSecondsFor(config: HostRateLimiterConfig): number {
  return Math.max(60, Math.ceil((Math.max(HOST_RATE_LIMIT_MIN_INTERVAL_MS, config.crawlDelayMs ?? 0) / 1000) * 2));
}

export interface HostRateLimiterLeaseResult {
  readonly granted: boolean;
  readonly retryAfterMs: number;
}

export class HostRateLimiter {
  private readonly redis: HostRateLimiterRedis;
  private readonly clock: () => number;

  constructor(redis: Redis, clock: () => number = () => Date.now()) {
    this.redis = redis as HostRateLimiterRedis;
    if (typeof this.redis.hostRateLimiterTryAcquire !== "function") {
      this.redis.defineCommand("hostRateLimiterTryAcquire", { numberOfKeys: 1, lua: LUA_TRY_ACQUIRE });
    }
    this.clock = clock;
  }

  /** Fails OPEN on a store error — same posture as the token bucket (D19's spirit, extended here: crawl politeness is not itself a correctness guarantee, so an outage must never block crawling entirely). */
  async tryAcquire(host: string, config: HostRateLimiterConfig): Promise<HostRateLimiterLeaseResult> {
    try {
      const [granted, retryAfterMs] = await this.redis.hostRateLimiterTryAcquire!(
        hostKey(host),
        String(HOST_RATE_LIMIT_MIN_INTERVAL_MS),
        String(config.crawlDelayMs ?? 0),
        String(Math.floor(this.clock())),
        String(ttlSecondsFor(config)),
      );
      return { granted: granted === 1, retryAfterMs };
    } catch (error) {
      logger.warn(`host rate-limiter store unavailable for host '${host}' — failing open: ${(error as Error).message}`);
      return { granted: true, retryAfterMs: 0 };
    }
  }
}
