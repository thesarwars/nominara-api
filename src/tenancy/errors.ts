import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from "@nestjs/common";

// STORY-011 — the two typed errors this module's guardrails raise. Kept
// separate from tenant-context.ts/query-guard.ts/with-tenant-job.ts so any
// of those can import the error types without a circular dependency.

/**
 * Thrown by src/tenancy/query-guard.ts when a tenant-scoped table is queried
 * outside a context-carrying transaction (i.e. outside
 * withTenantContext/withTenantJob). Converts "forgot the interceptor" from a
 * silent cross-tenant data leak into a loud failure in CI.
 */
export class TenantContextMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextMissingError";
  }
}

/**
 * Thrown by AuditInterceptor (STORY-020) when a mutating route has no
 * @Audit() metadata, or when no tenant context store is active for it to
 * write into. Fail-closed, same shape as TenantContextMissingError: "an
 * unaudited mutation is not an acceptable outcome" (AC2) means a forgotten
 * decorator must be a loud failure, not a silent audit gap.
 */
export class AuditMetadataMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditMetadataMissingError";
  }
}

/**
 * Thrown by AuditInterceptor (STORY-020 fix pass, qa-reviewer blocking
 * finding 2) when an @Audit()-annotated mutating route's resource_id cannot
 * be resolved into a usable value — the configured param is absent from
 * `req.params`, or the resolved string (from params or the response body) is
 * not a valid UUID. Fail-closed, same posture as AuditMetadataMissingError:
 * silently writing `null`, or letting a malformed value reach Postgres as a
 * raw `22P02 invalid input syntax for type uuid` error, are both worse than
 * a loud, attributable failure at the point the decorator was misconfigured.
 */
export class AuditResourceIdUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditResourceIdUnresolvedError";
  }
}

/**
 * Thrown by a JobVerifier (see with-tenant-job.ts) when a queue job's payload
 * signature does not verify. Raised BEFORE any set_config call, so a
 * tampered/poisoned queue entry can never redirect a worker into another
 * tenant's context.
 */
export class JobSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobSignatureError";
  }
}

// STORY-018 — WorkspaceGuard's distinguishable failure modes (AC 9):
// unauthenticated, workspace mismatch, not a member, workspace suspended —
// plus entitlement-version staleness (AC 6), which is a related but
// distinct freshness failure. Each carries a stable `code` on
// `.getResponse()` so a client can branch without parsing `.message` text,
// while `.message` stays human-readable for logs and the ProblemFilter stub.

export type WorkspaceGuardFailureCode =
  | "unauthenticated"
  | "workspace_mismatch"
  | "not_a_member"
  | "workspace_suspended"
  | "entitlement_stale";

export class UnauthenticatedWorkspaceException extends UnauthorizedException {
  constructor(message = "unauthenticated") {
    super({ code: "unauthenticated" satisfies WorkspaceGuardFailureCode, message });
  }
}

export class WorkspaceMismatchException extends ForbiddenException {
  constructor(message = "workspace does not match the authenticated key") {
    super({ code: "workspace_mismatch" satisfies WorkspaceGuardFailureCode, message });
  }
}

export class NotAMemberException extends ForbiddenException {
  constructor(message = "you are not a member of this workspace") {
    super({ code: "not_a_member" satisfies WorkspaceGuardFailureCode, message });
  }
}

export class WorkspaceSuspendedException extends ForbiddenException {
  constructor(message = "this workspace is suspended") {
    super({ code: "workspace_suspended" satisfies WorkspaceGuardFailureCode, message });
  }
}

export class EntitlementStaleException extends UnauthorizedException {
  constructor(message = "entitlement version is stale — refresh required") {
    super({ code: "entitlement_stale" satisfies WorkspaceGuardFailureCode, message });
  }
}

// STORY-019 — RbacGuard's three distinguishable failure modes (security-and-
// tenancy.md §6/§7). A permission denial is deliberately a 403 naming the
// permission, never a 404 — the resource's existence within the tenant is
// already known to the caller. An out-of-scope project is a DISTINCT code
// from a plain permission denial, because the remediation differs (ask for
// broader scope vs. ask for the permission itself). Step-up is a 401, not a
// 403 — the caller IS permitted, they just haven't proven presence recently
// enough; distinct from EntitlementStaleException above only in that it
// carries the acceptable methods so the interface can prompt correctly.

export type RbacGuardFailureCode = "forbidden" | "project_out_of_scope" | "step_up_required";

export class PermissionDeniedException extends ForbiddenException {
  constructor(requiredPermission: string, message = `missing required permission: ${requiredPermission}`) {
    super({
      code: "forbidden" satisfies RbacGuardFailureCode,
      message,
      details: { required_permission: requiredPermission },
    });
  }
}

export class ProjectOutOfScopeException extends ForbiddenException {
  constructor(message = "this project is outside your assigned scope") {
    super({ code: "project_out_of_scope" satisfies RbacGuardFailureCode, message });
  }
}

export class StepUpRequiredException extends UnauthorizedException {
  constructor(methods: readonly string[], message = "step-up re-authentication required") {
    super({ code: "step_up_required" satisfies RbacGuardFailureCode, message, details: { methods } });
  }
}

// STORY-021-E-5 — the ONE constraint (SQLSTATE 23505 on
// ux_one_owned_workspace_per_user) that maps to this code. Every other
// unique violation in workspace creation is a plain 409 conflict — see
// WorkspacesService.create's catch path.
export interface ExistingOwnedWorkspace {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export class WorkspaceLimitReachedException extends ConflictException {
  constructor(existing: ExistingOwnedWorkspace) {
    super({
      code: "workspace_limit_reached",
      message: `you already own a workspace ("${existing.name}") — transfer ownership before creating another`,
      details: {
        existing_workspace_id: existing.id,
        existing_workspace_name: existing.name,
        existing_workspace_slug: existing.slug,
        transfer_path: "POST /workspaces/{id}/transfer-ownership",
      },
    });
  }
}

// STORY-021-E-7 — the invite/accept enumeration surface: uniform whether or
// not the token is real, so no reason-specific message ever leaves this
// exception (never distinguishes expired vs. revoked vs. already-accepted
// vs. unknown token). Plain message, no `code`, mirroring AccessTokenError's
// existing precedent (auth.guard.ts) rather than inventing a new taxonomy
// code for a case none of the five reserved codes describe.
export class InvitationInvalidException extends BadRequestException {
  constructor() {
    super("this invitation is invalid, expired, or already used");
  }
}

// STORY-015 — AC "An email the provider did not verify creates the account
// in an unverified state with no workspace-create right." Thrown by
// WorkspacesService.create() when the acting user's users.status is
// 'unverified' (set by OauthService.resolveOrCreateForLogin when a
// provider does not confirm the address).
export class EmailNotVerifiedException extends ForbiddenException {
  constructor(message = "email must be verified before creating a workspace") {
    super({ code: "email_not_verified", message });
  }
}

// STORY-015 AC "A provider error returns a neutral message with the
// request identifier, and never reflects the provider's raw error into the
// response." Every rejection in OauthService.callback() (bad state, a
// replayed/unknown/expired state, a binding mismatch, a link re-auth
// failure, a subject/email conflict, a provider error, a failed token
// exchange) funnels through this ONE exception — same fixed message and
// shape regardless of which reason applied, so no response ever
// distinguishes them for a caller (the distinguishing detail lives only in
// the server-side warn log, keyed by the SAME request_id).
export class OauthFailedException extends BadRequestException {
  constructor(requestId: string, message = "sign-in with this provider could not be completed") {
    super({ code: "oauth_failed", message, details: { request_id: requestId } });
  }
}

// STORY-016 D5/D6 — POST /auth/otp/request's rate-limit refusal, keyed on
// either the per-address (1h) or per-source (1m) bucket. `retry_after_seconds`
// is the only variable field; standard rate-limit headers are STORY-025's
// deliverable, not invented here.
export class OtpRateLimitedException extends HttpException {
  // STORY-024 decision D13 — api-specification.md §2 gives this code
  // `details.retry_after_ms`, and NFR-API-05 requires every duration to be
  // integer milliseconds with a `_ms` suffix. The constructor still takes
  // SECONDS because that is the unit the buckets and the `Retry-After`
  // header are expressed in (RFC 9110 §10.2.3); the conversion happens once,
  // here, rather than at each call site.
  constructor(retryAfterSeconds: number, message = "too many code requests — try again later") {
    super(
      { code: "rate_limited", message, details: { retry_after_ms: retryAfterSeconds * 1000 } },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

// STORY-016 AC "Verification failures return one message for every failure
// mode: wrong code, expired code, exhausted attempts, unknown address."
// Deliberately carries NO variable field, unlike OauthFailedException's
// request_id-in-details shape: Test Scenario 5 requires two rejections
// from GENUINELY DIFFERENT requests (an expired code vs. a reused code) to
// be byte-identical, which a per-request request_id would break by
// construction. The real reason is a server-side warn log only, keyed by
// its own request_id there — never reflected into the response body.
export class EmailOtpInvalidException extends BadRequestException {
  constructor(message = "this code is invalid, expired, or could not be verified") {
    super({ code: "otp_invalid", message });
  }
}
