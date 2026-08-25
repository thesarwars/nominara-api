import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
// Named import, not default: ioredis is CommonJS and under this repo's
// NodeNext resolution its default export resolves to the module NAMESPACE,
// which is neither constructable nor usable as a type.
import { Redis } from "ioredis";
import type { Cache, CacheSetOptions, TokenBucketOutcome, TokenBucketSpec } from "./cache.port.js";

// STORY-025 T14 — the production adapter, over the Valkey CACHE instance
// (docker-compose.yml's `valkey-cache`, VALKEY_CACHE_URL). Valkey speaks the
// Redis wire protocol, which is why the client is `ioredis` (decision D3 of
// the EPIC-03 execution plan).
//
// Implements src/lib/cache/cache.port.ts and nothing more. The in-memory
// adapter implements the same five operations, and
// test/integration/cache-port-conformance.spec.ts runs ONE suite against BOTH
// — so a behavioural difference between the fake and the real thing is a test
// failure rather than a production surprise. That check exists because this
// repository has already shipped a fake more permissive than the real API it
// stood in for (STORY-024 T12, a FastifyReply without `removeHeader`).

const logger = new Logger("valkey-cache");

/**
 * INCR and PEXPIRE in one atomic step, with the expiry set ONLY on creation.
 *
 * Two round trips would leave a window in which a crash between them left a
 * counter with no expiry — a bucket that never resets until eviction reclaims
 * it. Setting the expiry unconditionally would be worse: every request would
 * push the window's end further out, so a bucket under continuous load would
 * never close, and the rate limit would stop working exactly when it is being
 * exercised.
 */
const INCREMENT_WITH_TTL_ON_CREATE = `
local value = redis.call('INCR', KEYS[1])
if value == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return value
`;

/**
 * A token bucket, refilled and decremented in ONE atomic step.
 *
 * Held as two fields under one hash so both are read and written together:
 * the token count and the millisecond timestamp it was last computed at.
 * Doing this over `GET` then `SET` would be a read-modify-write, and two
 * concurrent requests would each read the same count and each spend it — the
 * bucket would grant twice its capacity under exactly the load it exists to
 * limit.
 *
 * `TIME` comes from the SERVER, not from the caller. Several API instances
 * share this bucket and their clocks do not agree; a client-supplied
 * timestamp that ran fast would refill the bucket early, and one that ran
 * slow would throttle a tenant for someone else's clock drift.
 *
 * The key expires after one full refill period of idleness. A bucket nobody
 * has touched for that long is indistinguishable from a fresh one, so
 * dropping it costs nothing and stops idle tenants accumulating keys.
 */
const CONSUME_TOKEN = `
local capacity = tonumber(ARGV[1])
local ms_per_token = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[3])

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1])
local last = tonumber(state[2])

if tokens == nil or last == nil then
  tokens = capacity
else
  tokens = math.min(capacity, tokens + ((now - last) / ms_per_token))
end

local allowed = 0
local reset_after = 0
if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
  if tokens >= capacity then
    reset_after = 0
  else
    reset_after = math.ceil(ms_per_token)
  end
else
  reset_after = math.ceil((1 - tokens) * ms_per_token)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', KEYS[1], ttl_ms)
return { allowed, math.floor(tokens), reset_after }
`;

@Injectable()
export class ValkeyCacheAdapter implements Cache, OnModuleDestroy {
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, {
      // A cache miss must never become a hung request. If Valkey is
      // unreachable the call fails fast and the caller decides — for
      // idempotency that means executing the request, which is the same
      // degradation as an evicted record.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    this.client.on("error", (error: Error) => {
      // IDs and messages only. A connection error can carry the URL, and the
      // URL can carry credentials.
      logger.error({ message: "valkey connection error", error: error.name });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(key);
    return value ?? undefined;
  }

  async set(key: string, value: string, options: CacheSetOptions): Promise<boolean> {
    // `SET key value PX ttl NX` replies with null when NX prevented the write.
    // That reply IS the answer to "did I win the race", and it is why the
    // idempotency claim needs no lock of its own.
    const result =
      options.onlyIfAbsent === true
        ? await this.client.set(key, value, "PX", options.ttlMs, "NX")
        : await this.client.set(key, value, "PX", options.ttlMs);
    return result === "OK";
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    const value = await this.client.eval(INCREMENT_WITH_TTL_ON_CREATE, 1, key, String(ttlMs));
    return Number(value);
  }

  async timeToLiveMs(key: string): Promise<number | undefined> {
    // PTTL: -2 means the key does not exist, -1 means it exists with no
    // expiry. Neither is a duration, and returning either as a number would
    // make "expires in -2 ms" a value a caller could do arithmetic on.
    const ttl = await this.client.pttl(key);
    return ttl < 0 ? undefined : ttl;
  }

  async consume(key: string, bucket: TokenBucketSpec): Promise<TokenBucketOutcome> {
    const msPerToken = bucket.refillWindowMs / bucket.refillTokens;
    const reply = (await this.client.eval(
      CONSUME_TOKEN,
      1,
      key,
      String(bucket.capacity),
      String(msPerToken),
      String(Math.ceil(bucket.refillWindowMs)),
    )) as [number, number, number];

    return { allowed: reply[0] === 1, remaining: reply[1], resetAfterMs: reply[2] };
  }

  /** Opens the connection. Called explicitly rather than on construction, so a boot failure is attributable. */
  async connect(): Promise<void> {
    await this.client.connect();
  }
}
