import { ForbiddenException, UnauthorizedException } from "@nestjs/common";

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
