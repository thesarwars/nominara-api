import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Pool, PoolClient } from "pg";
import { from, lastValueFrom, type Observable } from "rxjs";
import { PG_POOL } from "../../db/pg-pool.js";
import { TenantContextMissingError } from "../../tenancy/errors.js";
import { withTenantContext, type TenantContext } from "../../tenancy/tenant-context.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";
import { SKIP_TENANT_CONTEXT_KEY } from "../decorators/skip-tenant-context.decorator.js";
import { STREAMING_KEY } from "../decorators/streaming.decorator.js";

// STORY-022 — security-and-tenancy.md §4's TenantContextInterceptor,
// wired into a real HTTP pipeline for the first time. This is the adapter
// glue only: it resolves req.tenant (set by WorkspaceGuard — a no-op today,
// STORY-017) and calls STRAIGHT INTO src/tenancy/tenant-context.ts's
// existing withTenantContext — it does not reimplement or restructure the
// BEGIN/set_config/COMMIT sequence that lives there.
//
// One connection is checked out of the pool PER REQUEST (never a single
// shared client across concurrent requests — Postgres allows only one
// transaction per physical connection) and released once the transaction
// completes, success or failure alike.

export interface AuthedRequest {
  tenant?: TenantContext;
}

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return next.handle();
    }

    // @SkipTenantContext() — session-authenticated (AuthGuard still ran) but
    // genuinely tenant-less routes (e.g. /me/passkeys, before any workspace
    // exists). Distinct from @Public(): this route required a valid access
    // token to reach here.
    const skipTenantContext = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_CONTEXT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipTenantContext) {
      return next.handle();
    }

    // STORY-026 T23 — THE ONE THAT WOULD HAVE BITTEN SILENTLY. This
    // interceptor awaits `lastValueFrom(next.handle())` inside
    // withTenantContext. A streaming handler writes to reply.raw and returns
    // nothing, so the observable completes without emitting and lastValueFrom
    // REJECTS with EmptyError — rolling back the transaction of a request that
    // succeeded. Holding a transaction open for a sixty-second stream would be
    // wrong even if it worked, so a streaming route opens its own short-lived
    // contexts instead, exactly as a @SkipTenantContext() route does.
    const streaming = this.reflector.getAllAndOverride<boolean>(STREAMING_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (streaming) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const tenant = req.tenant;
    if (!tenant) {
      // STORY-022-E-3 — fail closed. Every guard ahead of this interceptor
      // is a pass-through no-op today (STORY-022-E-2), so req.tenant is
      // never populated yet. Silently proceeding with unset tenant context
      // would be the exact "forgot the interceptor" failure NFR-SEC-01
      // exists to convert into a loud failure — refuse the request rather
      // than open a transaction with no tenant to scope it to.
      throw new TenantContextMissingError(
        "TenantContextInterceptor: req.tenant is unset — refusing to open a transaction without tenant context " +
          "(WorkspaceGuard has not populated it; mark the route @Public() if it genuinely has no tenant)",
      );
    }

    const client: PoolClient = await this.pool.connect();
    return from(
      withTenantContext(client, tenant, async () => lastValueFrom(next.handle())).finally(() => client.release()),
    );
  }
}
