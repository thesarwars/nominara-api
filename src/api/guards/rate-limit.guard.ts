import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import { RATE_LIMIT_HEADERS, type RateLimitRouteClass } from "../../../contracts/common/rate-limit.schema.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { DailyLimitReachedError, RateLimitedError } from "../errors/domain-errors.js";
import { RateLimitBuckets } from "../rate-limit/buckets.js";
import { defaultRouteClass, RATE_LIMIT_CLASS_KEY } from "../rate-limit/route-class.js";
import type { AuthenticatedRequest } from "./auth.guard.js";

// STORY-025 T17 — replaces STORY-022's pass-through no-op.
//
// api-specification.md §12: "Rate limits are an abuse control and are
// INDEPENDENT of credits. Exhausting one returns `429 rate_limited` and debits
// nothing; a credit-spending call that is rate-limited never reaches
// `CreditGuard`, so no reservation is created."
//
// That last clause is about ORDER, and the order is already correct in
// api.module.ts — RateLimitGuard is registered before CreditGuard
// (STORY-022-E-1, which corrected two reference diagrams whose own prose said
// so). This file adds the LOGIC to a slot that is already in the right place;
// it does not touch the composition root.

const logger = new Logger("rate-limit");

interface RateLimitedRequest extends AuthenticatedRequest {
  url?: string;
  ip?: string;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly buckets: RateLimitBuckets,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<RateLimitedRequest>();
    const reply = http.getResponse<FastifyReply>();

    const workspaceId = request.auth?.ws ?? undefined;
    const userId = request.auth?.sub ?? undefined;

    const declared = this.reflector.getAllAndOverride<RateLimitRouteClass>(RATE_LIMIT_CLASS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const routeClass = declared ?? defaultRouteClass(request.method ?? "GET", request.url ?? "");

    // Unauthenticated traffic is limited, not skipped. §12 gives `/auth/*`,
    // `/portal/session` and `/public/niche-reports*` IP buckets precisely
    // BECAUSE those callers have no identity yet, and an authenticated-only
    // guard would leave sign-in — the tightest row in the table — unlimited.
    // RateLimitBuckets skips the buckets whose scope has no identity and keys
    // the rest globally; it never invents one.
    const decision = await this.buckets.check(routeClass, {
      env: cacheKeyNamespace(),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(userId === undefined ? {} : { userId }),
      ip: request.ip ?? "unknown",
    });

    // §1 publishes these on EVERY response, not only refusals: a client that
    // only learns its remaining capacity by being refused cannot pace itself,
    // which is the point of publishing them at all.
    //
    // But only when a bucket ACTUALLY APPLIED. Publishing `Limit: 0,
    // Remaining: 0` on a request nothing limited tells a conforming client it
    // has no quota, and it backs off against a limit that was never applied.
    if (decision.applied) {
      reply.header(RATE_LIMIT_HEADERS.limit, String(decision.limit));
      reply.header(RATE_LIMIT_HEADERS.remaining, String(decision.remaining));
      reply.header(RATE_LIMIT_HEADERS.reset, String(Math.ceil(decision.resetAfterMs / 1000)));
    }

    if (decision.allowed) {
      return true;
    }

    reply.header(RATE_LIMIT_HEADERS.retryAfter, String(Math.ceil(decision.resetAfterMs / 1000)));
    incrementCounter("nominara_api_rate_limit_refusal_total", {
      route_class: routeClass,
      bucket: decision.exhausted?.scope ?? "unknown",
    });
    logger.warn({
      message: "rate limit exhausted",
      workspace_id: workspaceId ?? null,
      route_class: routeClass,
      bucket: decision.exhausted?.scope ?? "unknown",
      limit: decision.exhausted?.limit ?? null,
    });

    // A HARD CAP is a different condition from a rate limit, and §2 gives it
    // its own code. `rate_limited` means "slow down"; `daily_limit_reached`
    // means "come back tomorrow, and buying credits will not help". Collapsing
    // them would break two of the five distinct conditions NFR-API-13 forbids
    // collapsing, and would make the interface offer a remediation that does
    // not work.
    if (decision.exhausted?.hardCap === true) {
      throw new DailyLimitReachedError({
        message: "the daily cap for this action has been reached",
        details: {
          // §2 specifies `details.{action_code, used, limit, resets_at}`. A
          // route class is the closest thing to an action code that exists
          // before EPIC-10 defines them, and saying so is better than
          // inventing one — but it IS a stand-in, not the real vocabulary.
          action_code: routeClass,
          // `used` is the cap itself: the refusal happens when the counter
          // reaches it, and reporting anything larger would tell a client it
          // had spent more than its allowance.
          used: decision.exhausted.limit,
          limit: decision.exhausted.limit,
          resets_at: new Date(Date.now() + decision.resetAfterMs).toISOString(),
        },
      });
    }

    throw new RateLimitedError({
      message: "too many requests; retry after the interval given",
      details: { retry_after_ms: decision.resetAfterMs },
    });
  }
}
