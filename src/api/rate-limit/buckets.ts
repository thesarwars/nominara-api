import { Inject, Injectable } from "@nestjs/common";
import type {
  RateLimitBucket,
  RateLimitRouteClass,
  RateLimitRouteClassConfig,
} from "../../../contracts/common/rate-limit.schema.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { rateLimitCounterKey } from "../../lib/cache/valkey-keys.js";
import { RATE_LIMIT_DEFAULTS } from "./defaults.js";

// STORY-025 T17 — additive bucket evaluation.
//
// api-specification.md §12: "keys are ADDITIVE — every applicable bucket must
// have capacity." So a class with a per-user and a per-workspace bucket
// refuses when EITHER is exhausted, and a busy workspace throttles a quiet
// user inside it. That is the intent: the workspace bucket exists to stop one
// tenant saturating shared capacity, and a per-user check alone could never
// do it.

export interface RateLimitIdentity {
  readonly env: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly ip: string;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** The bucket that refused, for the log line. Absent when the request was allowed. */
  readonly exhausted?: { readonly scope: string; readonly limit: number; readonly hardCap: boolean };
  /** §1's headers come from the TIGHTEST applicable bucket, so a client paces itself against the real constraint. */
  readonly limit: number;
  readonly remaining: number;
  readonly resetAfterMs: number;
}

/** Milliseconds from `now` to the next UTC midnight — the boundary a `utc_day` bucket resets on. */
export function msUntilUtcMidnight(nowMs: number): number {
  const now = new Date(nowMs);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return midnight - nowMs;
}

/** The UTC calendar day a `utc_day` counter is keyed on, so the key itself changes at midnight. */
export function utcDayStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

@Injectable()
export class RateLimitBuckets {
  constructor(
    @Inject(CACHE) private readonly cache: Cache,
    private readonly config: readonly RateLimitRouteClassConfig[] = RATE_LIMIT_DEFAULTS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  configFor(routeClass: RateLimitRouteClass): RateLimitRouteClassConfig {
    const found = this.config.find((entry) => entry.route_class === routeClass);
    if (found === undefined) {
      // Unreachable through the schema, which is fixed-length and
      // duplicate-checked — but a route class with no configuration is a route
      // with NO LIMIT, and that must never be the silent outcome.
      throw new Error(`rate-limit: no configuration for route class "${routeClass}"`);
    }
    return found;
  }

  private identityFor(bucket: RateLimitBucket, identity: RateLimitIdentity): string {
    switch (bucket.scope) {
      case "user":
        return identity.userId;
      case "workspace":
        return identity.workspaceId;
      case "ip":
        return identity.ip;
    }
  }

  /**
   * Evaluates every applicable bucket and returns the first refusal.
   *
   * Evaluated IN ORDER and short-circuited on the first exhausted bucket, so a
   * request refused by its per-user limit does not also spend a token from the
   * workspace bucket. Charging every bucket for a request that was refused
   * anyway would let one user's excess drain the capacity of everyone else in
   * the workspace — an abuse control that amplifies abuse.
   */
  async check(routeClass: RateLimitRouteClass, identity: RateLimitIdentity): Promise<RateLimitDecision> {
    const config = this.configFor(routeClass);
    const nowMs = this.now();
    let tightest: RateLimitDecision | undefined;

    for (const bucket of config.buckets) {
      const key = rateLimitCounterKey(
        identity.env,
        identity.workspaceId,
        routeClass,
        bucket.scope,
        this.identityFor(bucket, identity),
      );

      const outcome =
        bucket.window === "utc_day"
          ? await this.checkCalendarCap(key, bucket, nowMs)
          : await this.cache.consume(key, {
              capacity: config.burst,
              refillTokens: bucket.limit,
              refillWindowMs: bucket.window_ms!,
            });

      if (!outcome.allowed) {
        return {
          allowed: false,
          exhausted: { scope: bucket.scope, limit: bucket.limit, hardCap: bucket.hard_cap },
          limit: bucket.limit,
          remaining: 0,
          resetAfterMs: outcome.resetAfterMs,
        };
      }

      if (tightest === undefined || outcome.remaining < tightest.remaining) {
        tightest = { allowed: true, limit: bucket.limit, remaining: outcome.remaining, resetAfterMs: outcome.resetAfterMs };
      }
    }

    return tightest ?? { allowed: true, limit: 0, remaining: 0, resetAfterMs: 0 };
  }

  /**
   * A calendar cap, not a token bucket.
   *
   * §12's "3/UTC-day hard cap" resets at midnight, and a token bucket refills
   * continuously — a client refused at 23:59 under a bucket would get one
   * token back a few hours later rather than three at midnight. The day stamp
   * is IN THE KEY, so the reset is the key changing rather than a scheduled
   * expiry, and the counter cannot be extended by traffic the way a sliding
   * window can.
   */
  private async checkCalendarCap(
    key: string,
    bucket: RateLimitBucket,
    nowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAfterMs: number }> {
    const untilMidnight = msUntilUtcMidnight(nowMs);
    const used = await this.cache.increment(`${key}:${utcDayStamp(nowMs)}`, untilMidnight);
    return {
      allowed: used <= bucket.limit,
      remaining: Math.max(0, bucket.limit - used),
      resetAfterMs: untilMidnight,
    };
  }
}
