import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { mergeMap, type Observable } from "rxjs";
import { AuditMetadataMissingError, AuditResourceIdUnresolvedError } from "../../tenancy/errors.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { AUDIT_METADATA_KEY, type AuditOptions } from "../decorators/audit.decorator.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";
import { SKIP_TENANT_CONTEXT_KEY } from "../decorators/skip-tenant-context.decorator.js";
import { STREAMING_KEY } from "../decorators/streaming.decorator.js";
import type { WorkspaceScopedRequest } from "../guards/workspace.guard.js";

// STORY-020 — security-and-tenancy.md §12. Registered AFTER
// TenantContextInterceptor (api.module.ts) so its "before" logic (none here
// besides metadata resolution) runs after the transaction is already open,
// and — the load-bearing part — its response-side write, done via mergeMap
// below, runs BEFORE TenantContextInterceptor's own `lastValueFrom` resolves
// and COMMITs. If the audit write throws, mergeMap's returned promise
// rejects, the observable errors, TenantContextInterceptor's await rejects,
// and its withTenantContext call ROLLBACKs — the mutation and its audit
// record share one atomic outcome (AC2), never one succeeding without the
// other.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface SupportGrantContext {
  readonly id: string;
}

export interface AuditableRequest extends WorkspaceScopedRequest {
  readonly method: string;
  readonly id?: string | number;
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly params?: Record<string, string | undefined>;
  readonly supportGrant?: SupportGrantContext;
  /** Set by a controller/service BEFORE mutating, when it already has the prior row in hand (e.g. an update route). Absent means "no prior state to record" (e.g. a create). */
  readonly auditBeforeState?: unknown;
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

/** Who made the request, as an audit row records it. */
export interface RequestAuditActor {
  readonly actorType: "user" | "api_key" | "support";
  readonly supportGrantId: string | null;
  readonly requestId: string;
  readonly ip: string | null;
  readonly ua: string | null;
}

/**
 * The ONE mapping from a request to its audit actor. `writeAuditRow` uses it, and so does any later row written for the same request
 * after the interceptor's own (STORY-180 r7: ExportService's outcome row), so the two can never name different actors.
 */
export function requestAuditActorOf(req: AuditableRequest): RequestAuditActor {
  return {
    actorType: req.supportGrant ? "support" : req.authMethod === "apiKey" ? "api_key" : "user",
    supportGrantId: req.supportGrant?.id ?? null,
    requestId: req.id !== undefined ? String(req.id) : "",
    ip: req.ip ?? null,
    ua: firstHeaderValue(req.headers["user-agent"]),
  };
}

// qa-reviewer blocking finding 2: resource_id is a `uuid` column
// (audit_log.resource_id). Any string that reaches AuditChainService.append
// as resourceId is bound straight into that column — a non-UUID value
// crashes with Postgres's own "22P02 invalid input syntax for type uuid",
// a raw DB error instead of an attributable application-level failure.
// Validated here, once, at the boundary, so every caller gets the SAME
// fail-closed error regardless of which mode resolved the value.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The created resource's id, from either `id` or `<resourceType>_id`.
 *
 * `id` alone was not enough, and the gap was live: `POST /v1/projects` returns
 * `project_id` — api-specification.md §4.4 names the field, so the contract
 * generates it and the client reads it — and this returned null, so the
 * interceptor threw and the request answered 500 AFTER the project row had
 * already been written. A caller saw a failure for a project that exists.
 *
 * `resourceType` is already declared on the decorator, so the second name is
 * derived rather than configured: a route that says it audits a "project" is
 * saying its identifier is a project id, and a third spelling would be a new
 * convention rather than a new option.
 */
function resourceIdFromResponse(body: unknown, resourceType: string, idPath?: string): string | null {
  if (body === null || typeof body !== "object") return null;
  if (idPath !== undefined) {
    let cursor: unknown = body;
    for (const segment of idPath.split(".")) {
      if (cursor === null || typeof cursor !== "object") return null;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return typeof cursor === "string" ? cursor : null;
  }
  const record = body as Record<string, unknown>;
  for (const key of ["id", `${resourceType}_id`]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * Resolves and validates resource_id for one @Audit()-annotated request.
 * Never returns `null` silently for a misconfigured or malformed source —
 * either it returns a validated UUID string, or it throws
 * AuditResourceIdUnresolvedError. Fail-closed, matching this interceptor's
 * existing posture for a missing @Audit() decorator or a missing tenant
 * context store.
 */
function resolveAction(options: AuditOptions, responseBody: unknown): string {
  if (options.actionFrom === undefined) return options.action;
  try {
    const action = options.actionFrom(responseBody);
    return typeof action === "string" && action.length > 0 ? action : options.action;
  } catch {
    return options.action;
  }
}

function resolveResourceId(req: AuditableRequest, options: AuditOptions, responseBody: unknown): string {
  const routeLabel = `action "${options.action}" (resourceType "${options.resourceType}")`;

  if (options.resourceIdFrom === "workspace") {
    const workspaceId = currentTenantStore()?.context.workspaceId;
    if (workspaceId === undefined) {
      throw new AuditResourceIdUnresolvedError(`AuditInterceptor: ${routeLabel} declares resourceIdFrom: "workspace" but no tenant context is active`);
    }
    return workspaceId;
  }

  if (options.resourceIdFrom === "response") {
    const raw = resourceIdFromResponse(responseBody, options.resourceType, options.responseIdPath);
    if (raw === null) {
      throw new AuditResourceIdUnresolvedError(
        `AuditInterceptor: ${routeLabel} declares resourceIdFrom: "response" but the handler's response body had no usable string "id" or "${options.resourceType}_id" field`,
      );
    }
    if (!UUID_PATTERN.test(raw)) {
      // Post-review should-fix #2: the raw resolved value is user/attacker-
      // controlled free text with no size bound — Nest's default
      // ExceptionsHandler logs this Error's message server-side regardless
      // of what ProblemFilter does with the HTTP response, so it must never
      // appear here (coding-standards §7). action/resourceType identify the
      // route without repeating the value.
      throw new AuditResourceIdUnresolvedError(
        `AuditInterceptor: ${routeLabel} resolved a resource_id from the response body that is not a valid UUID`,
      );
    }
    return raw;
  }

  const paramName = options.paramName ?? "id";
  const raw = req.params?.[paramName];
  if (raw === undefined) {
    throw new AuditResourceIdUnresolvedError(
      `AuditInterceptor: ${routeLabel} declares resourceIdFrom: "params" (paramName: "${paramName}") but req.params.${paramName} is not present on this route`,
    );
  }
  if (!UUID_PATTERN.test(raw)) {
    // Same rationale as the response-body branch above — no raw param value
    // in the message.
    throw new AuditResourceIdUnresolvedError(
      `AuditInterceptor: ${routeLabel} resolved a resource_id from req.params.${paramName} that is not a valid UUID`,
    );
  }
  return raw;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditChain: AuditChainService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuditableRequest>();

    if (!MUTATING_METHODS.has(req.method)) {
      return next.handle();
    }

    // Mirrors TenantContextInterceptor's own exemption check: @Public()/
    // @SkipTenantContext() routes never have withTenantContext called on
    // them, so there is structurally no open transaction and no workspace to
    // chain a row against (audit_log.workspace_id is NOT NULL, no FK). These
    // routes are outside this per-tenant audit chain's scope by construction
    // (STORY-020-E-10) — not a fail-closed gap, since the chain they'd need
    // to join does not exist yet for that request.
    const isExempt =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]) ||
      this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_CONTEXT_KEY, [context.getHandler(), context.getClass()]);
    if (isExempt) {
      return next.handle();
    }

    // STORY-079 - a @Streaming() route opens its own short transactions (streaming.decorator.ts), so there is no ambient store to append to and no response
    // body to name a resource from. The marker already exempts the tenant-context, envelope and idempotency interceptors; this is the fourth. Such a route
    // audits ITSELF, in the transaction in which it writes (VisibilityScanService.start), and the coverage sweep treats it as exempt (discover-routes.ts).
    if (this.reflector.getAllAndOverride<boolean>(STREAMING_KEY, [context.getHandler(), context.getClass()]) === true) {
      return next.handle();
    }

    const options = this.reflector.getAllAndOverride<AuditOptions | undefined>(AUDIT_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) {
      // Fail closed (AC: "an unaudited mutation is not an acceptable
      // outcome") — a mutating route that forgot @Audit() must not silently
      // ship unaudited; it must fail loudly enough to be caught before
      // release, exactly like TenantContextMissingError does for tenant
      // context.
      throw new AuditMetadataMissingError(
        `AuditInterceptor: ${req.method} ${String(context.getClass().name)}.${String(context.getHandler().name)} ` +
          "is a mutating route with no @Audit() metadata — refusing to run it unaudited",
      );
    }

    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        await this.writeAuditRow(req, options, body);
        return body;
      }),
    );
  }

  private async writeAuditRow(req: AuditableRequest, options: AuditOptions, responseBody: unknown): Promise<void> {
    const store = currentTenantStore();
    if (!store) {
      // Mirrors TenantContextMissingError's fail-closed contract — this
      // route is mutating and non-public, so a transaction MUST already be
      // open (TenantContextInterceptor runs ahead of this one).
      throw new AuditMetadataMissingError(
        "AuditInterceptor: no tenant context store is active — TenantContextInterceptor must run before this interceptor",
      );
    }

    const resourceId = resolveResourceId(req, options, responseBody);
    const actor = requestAuditActorOf(req);

    await this.auditChain.append(store.client, {
      workspaceId: store.context.workspaceId,
      actorType: actor.actorType,
      actorId: store.context.actorId,
      actorIp: actor.ip,
      actorUa: actor.ua,
      action: resolveAction(options, responseBody),
      resourceType: options.resourceType,
      resourceId,
      beforeState: req.auditBeforeState ?? null,
      afterState: (options.afterState !== undefined ? options.afterState(responseBody) : responseBody) ?? null,
      requestId: actor.requestId,
      supportGrantId: actor.supportGrantId,
      severity: options.severity ?? "info",
    });
  }
}
