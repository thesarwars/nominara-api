import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import { RATE_LIMIT_HEADERS, type RateLimitRouteClass } from "../../../contracts/common/rate-limit.schema.js";
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

    const workspaceId = request.auth?.ws;
    const userId = request.auth?.sub;
    if (!workspaceId || !userId) {
      // An unauthenticated request has no identity to count against. The
      // counters are tenant-scoped keys (Valkey has no row-level security), so
      // there is no key to write that would not be a cross-tenant key. Public
      // and pre-authentication routes are limited by the surface in front of
      // this service; inventing a shared bucket here would let one caller
      // exhaust every other caller's capacity.
      return true;
    }

    const declared = this.reflector.getAllAndOverride<RateLimitRouteClass>(RATE_LIMIT_CLASS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const routeClass = declared ?? defaultRouteClass(request.method ?? "GET", request.url ?? "");

    const decision = await this.buckets.check(routeClass, {
      env: process.env.NODE_ENV ?? "development",
      workspaceId,
      userId,
      ip: request.ip ?? "unknown",
    });

    // §1 publishes these on EVERY response, not only refusals: a client that
    // only learns its remaining capacity by being refused cannot pace itself,
    // which is the point of publishing them at all.
    reply.header(RATE_LIMIT_HEADERS.limit, String(decision.limit));
    reply.header(RATE_LIMIT_HEADERS.remaining, String(decision.remaining));
    reply.header(RATE_LIMIT_HEADERS.reset, String(Math.ceil(decision.resetAfterMs / 1000)));

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
      workspace_id: workspaceId,
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
          action_code: routeClass,
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
