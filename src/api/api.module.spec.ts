import { Test } from "@nestjs/testing";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Observable } from "rxjs";
import { tap } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiModule } from "./api.module.js";
import { AuthGuard } from "./guards/auth.guard.js";
import { WorkspaceGuard } from "./guards/workspace.guard.js";
import { RbacGuard } from "./guards/rbac.guard.js";
import { EntitlementGuard } from "./guards/entitlement.guard.js";
import { QuotaGuard } from "./guards/quota.guard.js";
import { DailyCapGuard } from "./guards/daily-cap.guard.js";
import { RateLimitGuard } from "./guards/rate-limit.guard.js";
import { CreditGuard } from "./guards/credit.guard.js";
import { IdempotencyInterceptor } from "./interceptors/idempotency.interceptor.js";
import { TenantContextInterceptor } from "./interceptors/tenant-context.interceptor.js";
import { AuditInterceptor } from "./interceptors/audit.interceptor.js";
import { CreditInterceptor } from "./interceptors/credit.interceptor.js";
import { PermissionDeniedException } from "../tenancy/errors.js";

// STORY-022 — locks the composition root's global guard/interceptor order
// against a silent regression (this story's "critical implementation
// nuance"). Exercises the REAL production classes, wired through
// ApiModule exactly as production boots them, over an actual HTTP request
// to the (@Public()) /health/live route — not stand-ins.

const GUARD_ORDER = [
  AuthGuard,
  WorkspaceGuard,
  RbacGuard,
  EntitlementGuard,
  QuotaGuard,
  DailyCapGuard,
  RateLimitGuard,
  CreditGuard,
] as const;

// Registration order in api.module.ts's APP_INTERCEPTOR providers array.
// NestJS enters interceptors' "before" logic (the code before `next.handle()`
// is called) in THIS order, and their "after" logic (anything the returned
// Observable does once the handler's result arrives) in the REVERSE of it.
const INTERCEPTOR_REGISTRATION_ORDER = [
  IdempotencyInterceptor,
  TenantContextInterceptor,
  AuditInterceptor,
  CreditInterceptor,
] as const;

describe("STORY-022 · composition root guard/interceptor order", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // DbModule's PG_POOL factory only constructs a lazy pg.Pool (no
    // connection attempted at construction) — a fake connection string is
    // safe here since /health/live never queries Postgres.
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("invokes all 8 global guards, in the STORY-022-E-1 corrected order, before the handler runs", async () => {
    const calls: string[] = [];
    for (const Guard of GUARD_ORDER) {
      // AuthGuard.canActivate is async (STORY-014 fix: `jose` verification is
      // Promise-based); the other seven guards are still synchronous no-ops.
      // Cast to a uniform signature so vi.spyOn doesn't have to reconcile a
      // union of incompatible `this`/return types across heterogeneous classes.
      const proto = Guard.prototype as unknown as { canActivate: (...args: unknown[]) => boolean | Promise<boolean> };
      const original = proto.canActivate;
      vi.spyOn(proto, "canActivate").mockImplementation(function (this: unknown, ...args: unknown[]) {
        calls.push(Guard.name);
        return original.apply(this, args as never);
      });
    }

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual(GUARD_ORDER.map((Guard) => Guard.name));

    await app.close();
  });

  // STORY-019 — QA finding: the guard-order test above only ever observes
  // RbacGuard returning true (every guard here is a no-op except AuthGuard,
  // /health/live is @Public()). It never proves a refusal SHORT-CIRCUITS
  // the chain. EntitlementGuard/QuotaGuard/DailyCapGuard/RateLimitGuard/
  // CreditGuard are still no-ops today, so there is no side effect (e.g. a
  // credit reservation) for this test to prove was skipped yet — once any
  // of them stops being a no-op, a test asserting that side effect never
  // ran on a 403 must be added alongside it. What this test pins now: a
  // thrown PermissionDeniedException stops NestJS's guard pipeline before
  // any guard registered after RbacGuard is even invoked.
  it("an RbacGuard refusal short-circuits the chain before any later guard runs", async () => {
    const calls: string[] = [];
    for (const Guard of GUARD_ORDER) {
      const proto = Guard.prototype as unknown as { canActivate: (...args: unknown[]) => boolean | Promise<boolean> };
      const original = proto.canActivate;
      if (Guard === RbacGuard) {
        vi.spyOn(proto, "canActivate").mockImplementation(function (this: unknown) {
          calls.push(Guard.name);
          throw new PermissionDeniedException("workspace:delete");
        });
        continue;
      }
      vi.spyOn(proto, "canActivate").mockImplementation(function (this: unknown, ...args: unknown[]) {
        calls.push(Guard.name);
        return original.apply(this, args as never);
      });
    }

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([AuthGuard.name, WorkspaceGuard.name, RbacGuard.name]);

    await app.close();
  });

  it("enters interceptors in registration order and completes them in REVERSE registration order", async () => {
    const entries: string[] = [];
    const exits: string[] = [];

    for (const Interceptor of INTERCEPTOR_REGISTRATION_ORDER) {
      const original = Interceptor.prototype.intercept as (
        context: ExecutionContext,
        next: CallHandler,
      ) => Observable<unknown> | Promise<Observable<unknown>>;

      const traced = function (
        this: unknown,
        context: ExecutionContext,
        next: CallHandler,
      ): Observable<unknown> | Promise<Observable<unknown>> {
        entries.push(Interceptor.name);
        const record = () => exits.push(Interceptor.name);
        // Real rxjs .pipe(tap(...)) — preserves the actual Observable
        // instance (Nest's own interceptor chaining relies on it being a
        // true Observable, not just an object exposing `subscribe`).
        const wrap = (observable$: Observable<unknown>): Observable<unknown> =>
          observable$.pipe(tap({ complete: record, error: record }));

        // .call(this, ...) — the real intercept() needs its instance's own
        // injected fields (e.g. TenantContextInterceptor's this.reflector),
        // which a plain `original(context, next)` call would lose.
        const result = original.call(this, context, next);
        // TenantContextInterceptor's intercept() is itself async and
        // resolves to an Observable — every other interceptor here returns
        // an Observable synchronously (today's no-ops). Handle both shapes
        // without altering the real return value.
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<Observable<unknown>>).then(wrap);
        }
        return wrap(result as Observable<unknown>);
      };

      vi.spyOn(Interceptor.prototype, "intercept").mockImplementation(traced as never);
    }

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(entries).toEqual(INTERCEPTOR_REGISTRATION_ORDER.map((I) => I.name));
    expect(exits).toEqual([...INTERCEPTOR_REGISTRATION_ORDER].reverse().map((I) => I.name));

    await app.close();
  });
});
