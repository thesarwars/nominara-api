import { Inject, Injectable } from "@nestjs/common";
import type {
  RateLimitBucket,
  RateLimitRouteClass,
  RateLimitRouteClassConfig,
} from "../../../contracts/common/rate-limit.schema.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { globalKey, rateLimitCounterKey } from "../../lib/cache/valkey-keys.js";
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
  /** Absent before authentication — §12's `/auth/*`, `/portal/session` and `/public/niche-reports*` rows. */
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly ip: string;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** The bucket that refused, for the log line. Absent when the request was allowed. */
  readonly exhausted?: { readonly scope: string; readonly limit: number; readonly hardCap: boolean };
  /**
   * False when NO bucket applied — an unauthenticated request to a class whose
   * buckets are all user- or workspace-scoped. The guard then publishes no
   * headers at all, rather than `Limit: 0, Remaining: 0`, which a conforming
   * client reads as "you have no quota" and backs off against a limit that was
   * never applied. Found by code review.
   */
  readonly applied: boolean;
  /**
   * BOTH NUMBERS ARE TOKENS, in the same unit.
   *
   * `limit` used to be the bucket's window RATE while `remaining` was leftover
   * BURST tokens, so the first allowed capture-backed request advertised
   * `Limit: 40, Remaining: 0` and a conforming client backed off immediately.
   * A limit and a remainder that cannot be subtracted from each other are not a
   * budget. Found by code review.
   */
  readonly limit: number;
  readonly remaining: number;
  readonly resetAfterMs: number;
}

/**
 * What distinguishes two buckets of the SAME scope inside one route class.
 *
 * §12 gives capture-backed tools a user bucket at 5/min and another at 40/day.
 * Keyed on scope alone the two collide, share one token state, and the daily
 * allowance stops existing. The window is what tells them apart, and it is the
 * only thing that does — two buckets of the same scope and the same window
 * would be one bucket written twice.
 */
export function bucketWindowTag(bucket: RateLimitBucket): string {
  return bucket.window === "utc_day" ? "utcday" : `r${String(bucket.window_ms)}`;
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

  private identityFor(bucket: RateLimitBucket, identity: RateLimitIdentity): string | undefined {
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
   * Where a bucket's counter lives.
   *
   * Tenant-scoped when the caller is authenticated — an IP counter shared
   * across workspaces would let one tenant's traffic exhaust another's from a
   * shared office, VPN or CI runner, which is a denial of service between
   * tenants rather than an abuse control.
   *
   * IP-scoped counters stay under the workspace for authenticated traffic, and
   * the COST of that is worth writing down beside the rationale: §12's "10/hour
   * per IP" becomes 10/hour per IP PER WORKSPACE, so a tenant with several
   * workspaces gets a correspondingly larger allowance from one address. The
   * alternative — a shared IP counter across tenants — lets one tenant's
   * traffic exhaust another's from a shared office, VPN or CI runner, which is
   * a denial of service BETWEEN tenants. The looser limit was chosen
   * deliberately over the cross-tenant one; both directions are wrong in some
   * way and only one of them is wrong across a tenant boundary.
   *
   * GLOBAL when there is no workspace, which is the case for exactly the three
   * §12 rows that matter most here: `/auth/*`, `/portal/session` and
   * `/public/niche-reports*`. Pre-authentication traffic is not attributable to
   * a tenant, so there is no tenant to scope it to — and a global bucket is the
   * only way those three rows are enforceable at all. Skipping them instead,
   * which is what an authenticated-only guard does, leaves sign-in unlimited:
   * the surface §12 gives the tightest numbers in the whole table.
   *
   * Both forms go through src/lib/cache/valkey-keys.ts. Nothing here
   * concatenates a key by hand, including the calendar cap's day stamp — that
   * file owns the separator and the segment checks, and a key built beside it
   * is a key those checks never see.
   */
  private keyFor(
    routeClass: RateLimitRouteClass,
    bucket: RateLimitBucket,
    identity: RateLimitIdentity,
    id: string,
    ...extra: readonly string[]
  ): string {
    const window = bucketWindowTag(bucket);

    // A USER-SCOPED BUCKET IS ALWAYS GLOBAL, and that is a fix rather than a
    // simplification. Keying it under the workspace gave one human a separate
    // per-user allowance in every workspace they belong to, PLUS another for
    // the workspace-less token state that WorkspaceGuard explicitly permits
    // (`req.auth.ws === null`). §12's "60/min per user" became 60/min per user
    // per workspace, and workspace creation is self-serve — so the limit was
    // multipliable at will by the person it exists to limit. Found by the
    // dangerous-area audit.
    //
    // A user id identifies one human across every tenant, so a global key is
    // the accurate one. No tenant DATA is keyed here — only a count.
    const tenantScoped = bucket.scope !== "user" && identity.workspaceId !== undefined;
    return tenantScoped
      ? rateLimitCounterKey(identity.env, identity.workspaceId!, routeClass, bucket.scope, window, id, ...extra)
      : globalKey(identity.env, "ratelimit", routeClass, bucket.scope, window, id, ...extra);
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

    // ROLLING BUCKETS FIRST, CALENDAR CAPS LAST, AND THE ORDER IS A CORRECTNESS
    // PROPERTY RATHER THAN A PREFERENCE.
    //
    // A token spent on a rolling bucket comes back; a unit spent on a UTC-day
    // hard cap does not until midnight. Evaluated in §12's table order, a
    // request that passed the cap and was then refused by the workspace bucket
    // would have BURNED a unit of its daily allowance on a request that never
    // ran — and a hard cap is by definition not liftable by buying credits, so
    // the customer loses the allowance with no remedy.
    //
    // Ordering the irreversible check last means a refused request can still
    // spend rolling tokens, which refill. That is the cheap direction to be
    // wrong in. Found by the dangerous-area audit of this story.
    const ordered = [...config.buckets].sort((a, b) => {
      const irreversible = (bucket: RateLimitBucket): number => (bucket.window === "utc_day" ? 1 : 0);
      return irreversible(a) - irreversible(b);
    });

    for (const bucket of ordered) {
      const id = this.identityFor(bucket, identity);
      // A bucket whose scope this caller has no identity for is SKIPPED, not
      // guessed at. Before authentication there is no user and no workspace,
      // and counting every anonymous caller against one shared key would let
      // any one of them exhaust the limit for all of them.
      if (id === undefined) continue;

      const outcome =
        bucket.window === "utc_day"
          ? await this.checkCalendarCap(routeClass, bucket, identity, id, nowMs)
          : await this.cache.consume(this.keyFor(routeClass, bucket, identity, id), {
              capacity: config.burst,
              refillTokens: bucket.limit,
              refillWindowMs: bucket.window_ms!,
            });

      if (!outcome.allowed) {
        return {
          allowed: false,
          applied: true,
          exhausted: { scope: bucket.scope, limit: bucket.limit, hardCap: bucket.hard_cap },
          // Tokens, matching `remaining`. A calendar cap has no burst, so its
          // own limit IS its capacity.
          limit: bucket.window === "utc_day" ? bucket.limit : config.burst,
          remaining: 0,
          resetAfterMs: outcome.resetAfterMs,
        };
      }

      if (tightest === undefined || outcome.remaining < tightest.remaining) {
        tightest = {
          allowed: true,
          applied: true,
          limit: bucket.window === "utc_day" ? bucket.limit : config.burst,
          remaining: outcome.remaining,
          resetAfterMs: outcome.resetAfterMs,
        };
      }
    }

    return tightest ?? { allowed: true, applied: false, limit: 0, remaining: 0, resetAfterMs: 0 };
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
    routeClass: RateLimitRouteClass,
    bucket: RateLimitBucket,
    identity: RateLimitIdentity,
    id: string,
    nowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAfterMs: number }> {
    const untilMidnight = msUntilUtcMidnight(nowMs);
    const key = this.keyFor(routeClass, bucket, identity, id, utcDayStamp(nowMs));
    const used = await this.cache.increment(key, untilMidnight);
    return {
      allowed: used <= bucket.limit,
      remaining: Math.max(0, bucket.limit - used),
      resetAfterMs: untilMidnight,
    };
  }
}
