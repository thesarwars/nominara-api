import { DelayedError, type Job } from "bullmq";
import { engineTokenBucketsSchema, type EngineTokenBuckets } from "../../config/env.schema.js";
import { engineKeySchema, type EngineKey } from "./contract.js";
import { CaptureFailureError } from "./failure-taxonomy.js";
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

/**
 * SCANFIX D3 - the lease the capture worker wires onto `capture.execute`.
 *
 * Until this the bucket (STORY-031) was built, configured and tested and NEVER WIRED: nothing in
 * `src/` called `withEngineLease`, so a 51-cell scan reached the vendor all at once, 39 of the
 * calls were 429'd, and every cell spent its five attempts.
 *
 * `GEMINI_REQUESTS_PER_MINUTE` (default 10 = the free tier of gemini-2.5-flash) decides gemini's
 * bucket, and wins over `ENGINE_TOKEN_BUCKETS.gemini`: the vendor's quota is one number an operator
 * knows, and a capacity-10 burst bucket cannot honour "10 a minute". Other engines still come from
 * `ENGINE_TOKEN_BUCKETS`, and a missing entry still fails loud (EngineLeaseConfigError).
 *
 * `resolveEngineKey` reads the UNVERIFIED payload - the lease runs before the signature check by
 * design (see the header). It can only choose which bucket to spend a token from, never which
 * tenant a job runs as; a payload with no valid engine key fails the job here, before any context.
 */
export function captureEngineLeaseOptions(
  env: { readonly ENGINE_TOKEN_BUCKETS: string; readonly GEMINI_REQUESTS_PER_MINUTE: number },
  tokenBucket: TokenBucket,
): EngineLeaseOptions {
  const buckets = engineTokenBucketsSchema.parse(JSON.parse(env.ENGINE_TOKEN_BUCKETS));
  return {
    tokenBucket,
    configFor: configForFromEnv(buckets, env.GEMINI_REQUESTS_PER_MINUTE),
    resolveEngineKey: (job) => engineKeySchema.parse((job.data as { payload?: { engineKey?: unknown } }).payload?.engineKey),
    rateLimitDeferral: { maxDeferrals: MAX_RATE_LIMIT_DEFERRALS },
  };
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

    if (options.rateLimitDeferral === undefined) return processor(job);

    try {
      return await processor(job);
    } catch (error) {
      // SCANFIX D3 - A 429 IS "COME BACK LATER", NOT A FAILED ATTEMPT. Defer the job by the vendor's own
      // Retry-After (or one quota window when it named none) through the same DelayedError path a denied
      // lease takes: no DLQ entry, `attemptsMade` untouched. Bounded - the count rides in `job.progress`
      // (not in `job.data`, which is HMAC-signed) - so a key whose quota is gone for the day eventually
      // falls through to the ordinary ladder and then to the terminal `failed` record.
      if (!(error instanceof CaptureFailureError) || error.code !== "rate_limited") throw error;
      const deferrals = typeof job.progress === "number" ? job.progress : 0;
      if (deferrals >= options.rateLimitDeferral.maxDeferrals) throw error;
      await job.updateProgress(deferrals + 1);
      await job.moveToDelayed(clock() + (error.retryAfterMs ?? DEFAULT_RATE_LIMIT_DEFER_MS), token);
      throw new DelayedError();
    }
  };
}

/** Adapts the parsed ENGINE_TOKEN_BUCKETS (D7) into a `configFor` callback. A missing entry is a config defect — fails loud (EngineLeaseConfigError), never a silent default (distinct from D19's store-outage fail-open, which is about the STORE being unreachable, not the config being absent). */
export function configForFromEnv(buckets: EngineTokenBuckets, geminiRequestsPerMinute?: number): (engineKey: EngineKey) => TokenBucketConfig {
  return (engineKey: EngineKey): TokenBucketConfig => {
    if (engineKey === "gemini" && geminiRequestsPerMinute !== undefined) return geminiPacingConfig(geminiRequestsPerMinute);
    const config = buckets[engineKey];
    if (!config) {
      throw new EngineLeaseConfigError(engineKey);
    }
    return config;
  };
}
