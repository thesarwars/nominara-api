import { DelayedError, type Job } from "bullmq";
import type { EngineTokenBuckets } from "../../config/env.schema.js";
import type { EngineKey } from "./contract.js";
import type { TokenBucket, TokenBucketConfig } from "./token-bucket.js";

// STORY-031 Phase B — D17: this wraps the FUNCTION `createJobProcessor`
// returns; it never reaches inside that function, never reorders anything
// in it. Signature verification (the first executable statement on the
// tenant-scoped path) only ever runs once a lease is actually granted and
// the inner processor is invoked — a denied lease never gets that far.

export class EngineLeaseConfigError extends Error {
  constructor(engineKey: string) {
    super(`no token-bucket config for engine '${engineKey}' — ENGINE_TOKEN_BUCKETS is missing an entry for it`);
    this.name = "EngineLeaseConfigError";
  }
}

export interface EngineLeaseOptions {
  readonly tokenBucket: TokenBucket;
  /** Looks up this engine's bucket config. Throwing here (e.g. EngineLeaseConfigError) is a boot/config defect, distinct from D19's store-outage fail-open — a MISSING config entry is not a runtime outage. */
  readonly configFor: (engineKey: EngineKey) => TokenBucketConfig;
  /**
   * Reads which engine a job targets. Injected rather than reading a fixed
   * `job.data` field: no capture-job payload shape is ratified in this
   * codebase yet (STORY-032+ wires the real one) — this wrapper stays
   * decoupled from a schema that doesn't exist.
   */
  readonly resolveEngineKey: (job: Job) => EngineKey;
  readonly clock?: () => number;
  /** SCANFIX D3 - when set, a rate_limited failure is deferred by the vendor's Retry-After instead of spending an attempt. */
  readonly rateLimitDeferral?: { readonly maxDeferrals: number };
}

/** SCANFIX D3 - how long a 429 that named no Retry-After is deferred: one vendor quota window. */
export const DEFAULT_RATE_LIMIT_DEFER_MS = 60_000;
/** SCANFIX D3 - deferrals per job before a 429 is treated as an ordinary failed attempt. */
export const MAX_RATE_LIMIT_DEFERRALS = 20;

/** SCANFIX D3 - GEMINI_REQUESTS_PER_MINUTE as a bucket. */
export function geminiPacingConfig(requestsPerMinute: number): TokenBucketConfig {
  return { capacity: 1, refillPerSecond: requestsPerMinute / 60 };
}

/** SCANFIX D3 - the lease the capture worker wires. */
export function captureEngineLeaseOptions(
  _env: { readonly ENGINE_TOKEN_BUCKETS: string; readonly GEMINI_REQUESTS_PER_MINUTE: number },
  _tokenBucket: TokenBucket,
): EngineLeaseOptions {
  throw new Error("SCANFIX D3: not implemented");
}

/**
 * Wraps `processor` (createJobProcessor's return value) with a token-bucket
 * lease acquired BEFORE it is ever called. No lease → the job is moved to
 * `delayed` via BullMQ's own `moveToDelayed`, then `DelayedError` is thrown
 * — BullMQ's Worker treats that sentinel as "already rescheduled", never as
 * a failure: no DLQ entry, `attemptsMade` untouched (AC1/Test scenario 1).
 */
export function withEngineLease(
  processor: (job: Job) => Promise<unknown>,
  options: EngineLeaseOptions,
): (job: Job, token?: string) => Promise<unknown> {
  const clock = options.clock ?? (() => Date.now());

  return async (job: Job, token?: string): Promise<unknown> => {
    const engineKey = options.resolveEngineKey(job);
    const config = options.configFor(engineKey);
    const lease = await options.tokenBucket.tryAcquire(engineKey, config);

    if (!lease.granted) {
      await job.moveToDelayed(clock() + lease.retryAfterMs, token);
      throw new DelayedError();
    }

    return processor(job);
  };
}

/** Adapts the parsed ENGINE_TOKEN_BUCKETS (D7) into a `configFor` callback. A missing entry is a config defect — fails loud (EngineLeaseConfigError), never a silent default (distinct from D19's store-outage fail-open, which is about the STORE being unreachable, not the config being absent). */
export function configForFromEnv(buckets: EngineTokenBuckets, _geminiRequestsPerMinute?: number): (engineKey: EngineKey) => TokenBucketConfig {
  return (engineKey: EngineKey): TokenBucketConfig => {
    const config = buckets[engineKey];
    if (!config) {
      throw new EngineLeaseConfigError(engineKey);
    }
    return config;
  };
}
