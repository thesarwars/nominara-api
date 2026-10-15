import { Module } from "@nestjs/common";
import { AlertEmailShutdown } from "../lib/alerts/alerts.js";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { CanonicalParamsGuard } from "./guards/canonical-params.guard.js";
import { DbModule } from "../db/db.module.js";
import { CacheModule } from "../lib/cache/cache.module.js";
import { HealthModule } from "../modules/health/health.module.js";
import { IdentityModule } from "../modules/identity/identity.module.js";
import { WorkspacesModule } from "../modules/workspaces/workspaces.module.js";
import { ProjectsModule } from "../modules/projects/projects.module.js";
import { PromptsModule } from "../modules/prompts/prompts.module.js";
import { TrackingModule } from "../modules/tracking/tracking.module.js";
import { ReportsModule } from "../modules/reports/reports.module.js";
import { AnalyticsModule } from "../modules/analytics/analytics.module.js";
import { AuxModule } from "../modules/aux/aux.module.js";
import { TasksModule } from "../modules/tasks/tasks.module.js";
import { GeoModule } from "../modules/geo/geo.module.js";
import { DisplacementModule } from "../modules/displacement/displacement.module.js";
import { IntegrationsModule } from "../modules/integrations/integrations.module.js";
import { AgencyModule } from "../modules/agency/agency.module.js";
import { ApiKeysModule } from "../modules/api-keys/api-keys.module.js";
import { TrustModule } from "../modules/trust/trust.module.js";
import { PortalModule } from "../modules/portal/portal.module.js";
import { ToolsModule } from "../modules/tools/tools.module.js";
import { BillingModule } from "../modules/billing/billing.module.js";
import { CreditsModule } from "../modules/credits/credits.module.js";
import { EntitlementsModule } from "../modules/entitlements/entitlements.module.js";
import { CommandModule } from "../modules/command/command.module.js";
import { AdminModule } from "../modules/admin/admin.module.js";
import { AuditModule } from "../modules/audit/audit.module.js";
import { AuthGuard } from "./guards/auth.guard.js";
import { WorkspaceGuard } from "./guards/workspace.guard.js";
import { RbacGuard } from "./guards/rbac.guard.js";
import { EntitlementGuard } from "./guards/entitlement.guard.js";
import { QuotaGuard } from "./guards/quota.guard.js";
import { DailyCapGuard } from "./guards/daily-cap.guard.js";
import { RateLimitGuard } from "./guards/rate-limit.guard.js";
import { CreditGuard } from "./guards/credit.guard.js";
import { IdempotencyStore } from "./idempotency/store.js";
import { CACHE, type Cache } from "../lib/cache/cache.port.js";
import { RateLimitBuckets } from "./rate-limit/buckets.js";
import { IdempotencyInterceptor } from "./interceptors/idempotency.interceptor.js";
import { TenantContextInterceptor } from "./interceptors/tenant-context.interceptor.js";
import { AuditInterceptor } from "./interceptors/audit.interceptor.js";
import { CreditInterceptor } from "./interceptors/credit.interceptor.js";
import { ProblemFilter } from "./filters/problem.filter.js";
import { ResponseEnvelopeInterceptor } from "./interceptors/response-envelope.interceptor.js";

// STORY-022 — the HTTP composition root (project-structure.md §2: "src/api/
// HTTP composition root: global guards, interceptors, filters"). The global
// chain is composed EXACTLY ONCE, here, per this story's acceptance
// criteria — a future story fills in a guard/interceptor's LOGIC, never
// touches this file's ordering.
//
// Guard order corrects system-architecture.md §2 and security-and-tenancy.md
// §5's own diagrammed order (STORY-022-E-1): both documents' prose says "a
// rate-limited request must never reach CreditGuard", which the diagrammed
// order (...DailyCapGuard -> CreditGuard -> RateLimitGuard...) contradicts.
// The prose is authoritative; RateLimitGuard runs BEFORE CreditGuard here.
// (Non-blocking, separate doc-fix: those two reference docs' diagrams
// themselves still carry this order bug.)
@Module({
  imports: [
    DbModule,
    CacheModule,
    HealthModule,
    IdentityModule,
    WorkspacesModule,
    ProjectsModule,
    PromptsModule,
    TrackingModule,
    AnalyticsModule,
    AuxModule,
    TasksModule,
    GeoModule,
    DisplacementModule,
    IntegrationsModule,
    AgencyModule,
    ApiKeysModule,
    TrustModule,
    ReportsModule,
    PortalModule,
    ToolsModule,
    BillingModule,
    CreditsModule,
    EntitlementsModule,
    CommandModule,
    AdminModule,
    AuditModule,
  ],
  providers: [
    // Group C — flush in-flight alert emails on graceful shutdown (bounded wait).
    AlertEmailShutdown,
    // STORY-025 T16 — the idempotency record store, injected into
    // IdempotencyInterceptor. Not a global: only the interceptor uses it.
    IdempotencyStore,
    // STORY-025 T17 — the token buckets RateLimitGuard evaluates. Registered
    // through a factory rather than by class: the constructor takes the
    // configuration and a clock as optional arguments so a test can supply
    // both, and Nest cannot resolve an Array or a Function by type.
    {
      provide: RateLimitBuckets,
      useFactory: (cache: Cache): RateLimitBuckets => new RateLimitBuckets(cache),
      inject: [CACHE],
    },
    // ⚠ FIRST, AND api.module.spec.ts ASSERTS IT. Every guard below reads
    // `req.params`, and this is what makes the value they read the same value
    // the database will store. Second place would make it silently useless.
    { provide: APP_GUARD, useClass: CanonicalParamsGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: WorkspaceGuard },
    { provide: APP_GUARD, useClass: RbacGuard },
    { provide: APP_GUARD, useClass: EntitlementGuard },
    { provide: APP_GUARD, useClass: QuotaGuard },
    { provide: APP_GUARD, useClass: DailyCapGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: CreditGuard },
    // Registered in THIS array order — NOT the documented linear chain's
    // order — because NestJS runs APP_INTERCEPTOR "before" logic in
    // registration order and "after" logic in REVERSE registration order
    // (RxJS pipe chaining). Audit registered BEFORE Credit here means
    // Credit's "after" (commit/release the debit) fires BEFORE Audit's
    // "after" (append the audit_log row) at runtime, while
    // TenantContextInterceptor's transaction stays open across both —
    // locked by composition-root.spec.ts.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    // STORY-024 T10 — index 1 exactly: INNER to Idempotency (so STORY-025
    // caches the envelope, not the bare body) and OUTER to Audit (whose
    // resourceIdFromResponse reads body.id and would break on {data}).
    // See response-envelope.interceptor.ts for the full ordering argument.
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: CreditInterceptor },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class ApiModule {}
