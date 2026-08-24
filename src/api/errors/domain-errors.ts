import { HttpException } from "@nestjs/common";
import type { ErrorCode } from "../../../contracts/common/error-code.schema.js";
import type { SpendAndLimitRemediationKind } from "../../../contracts/common/error-details.schema.js";

// STORY-024 T9 — AC1: "Every error in the taxonomy has a typed domain error
// class, and a filter maps it to the wire shape. A controller never builds an
// error body by hand." This file is the classes; problem.filter.ts is the
// mapping. Nothing here formats a problem+json body.
//
// Statuses are api-specification.md §2's taxonomy table, transcribed once.
// test/unit/error-taxonomy.spec.ts holds an INDEPENDENT transcription of the
// same table and compares the two, so a slip here is caught by a copy that
// was not derived from this one.
export const ERROR_STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_failed: 400,
  unsupported_engine: 400,
  unauthenticated: 401,
  token_expired: 401,
  token_revoked: 401,
  step_up_required: 401,
  insufficient_credits: 402,
  forbidden: 403,
  workspace_mismatch: 403,
  project_out_of_scope: 403,
  entitlement_exceeded: 403,
  feature_not_in_plan: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  workspace_limit_reached: 409,
  price_changed: 409,
  domain_not_verified: 422,
  precondition_unmet: 422,
  unsafe_target: 422,
  rate_limited: 429,
  quota_exceeded: 429,
  daily_limit_reached: 429,
  capture_mode_unavailable: 451,
  engine_unavailable: 502,
  degraded: 503,
  retention_exceeded: 507,
};

// Decision D11 — the five NFR-API-13 conditions each carry their own
// remediation kind, so "buy credits" is never confusable with "upgrade" or
// "wait". Attached by the class rather than supplied at each throw site: a
// remediation that depends on the caller remembering to pass it is one
// forgotten argument away from two conditions looking identical.
const REMEDIATION_KIND_BY_CODE: Partial<Record<ErrorCode, SpendAndLimitRemediationKind>> = {
  insufficient_credits: "purchase_credits",
  entitlement_exceeded: "increase_limit",
  feature_not_in_plan: "upgrade_plan",
  quota_exceeded: "wait_for_cycle",
  daily_limit_reached: "wait_for_daily_reset",
};

export interface DomainRemediation {
  readonly kind: string;
  readonly url?: string;
}

export interface DomainErrorInit {
  readonly message?: string;
  readonly details?: unknown;
  readonly remediation?: DomainRemediation;
}

export class DomainError extends HttpException {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly remediation: DomainRemediation | undefined;

  constructor(code: ErrorCode, status: number, init: DomainErrorInit = {}) {
    super({ code, message: init.message ?? code, details: init.details }, status);
    this.code = code;
    this.details = init.details;
    this.remediation = init.remediation ?? remediationFor(code);
  }
}

function remediationFor(code: ErrorCode): DomainRemediation | undefined {
  const kind = REMEDIATION_KIND_BY_CODE[code];
  return kind === undefined ? undefined : { kind };
}

export type DomainErrorClass = new (init?: DomainErrorInit) => DomainError;

// The per-code exports below are VALUES holding classes, not class
// declarations, so `ValidationFailedError` is usable with `new` and
// `instanceof` but NOT as a type annotation. Annotate with `DomainError`
// (or `InstanceType<typeof ValidationFailedError>`) instead — `tsc` says so
// explicitly, which is why this note is here rather than a trap.

// One named class per code. `name` is set explicitly so a stack trace and a
// `instanceof`-less log both still identify which error was thrown — an
// anonymous subclass reports "DomainError" for all 27.
function defineDomainError(code: ErrorCode, className: string): DomainErrorClass {
  const status = ERROR_STATUS_BY_CODE[code];
  const cls = class extends DomainError {
    constructor(init: DomainErrorInit = {}) {
      super(code, status, init);
    }
  };
  Object.defineProperty(cls, "name", { value: className });
  return cls;
}

export const ValidationFailedError = defineDomainError("validation_failed", "ValidationFailedError");
export const UnsupportedEngineError = defineDomainError("unsupported_engine", "UnsupportedEngineError");
export const UnauthenticatedError = defineDomainError("unauthenticated", "UnauthenticatedError");
export const TokenExpiredError = defineDomainError("token_expired", "TokenExpiredError");
export const TokenRevokedError = defineDomainError("token_revoked", "TokenRevokedError");
export const StepUpRequiredError = defineDomainError("step_up_required", "StepUpRequiredError");
export const InsufficientCreditsError = defineDomainError("insufficient_credits", "InsufficientCreditsError");
export const ForbiddenError = defineDomainError("forbidden", "ForbiddenError");
export const WorkspaceMismatchError = defineDomainError("workspace_mismatch", "WorkspaceMismatchError");
export const ProjectOutOfScopeError = defineDomainError("project_out_of_scope", "ProjectOutOfScopeError");
export const EntitlementExceededError = defineDomainError("entitlement_exceeded", "EntitlementExceededError");
export const FeatureNotInPlanError = defineDomainError("feature_not_in_plan", "FeatureNotInPlanError");
export const NotFoundError = defineDomainError("not_found", "NotFoundError");
export const ConflictError = defineDomainError("conflict", "ConflictError");
export const IdempotencyConflictError = defineDomainError("idempotency_conflict", "IdempotencyConflictError");
export const WorkspaceLimitReachedError = defineDomainError("workspace_limit_reached", "WorkspaceLimitReachedError");
export const PriceChangedError = defineDomainError("price_changed", "PriceChangedError");
export const DomainNotVerifiedError = defineDomainError("domain_not_verified", "DomainNotVerifiedError");
export const PreconditionUnmetError = defineDomainError("precondition_unmet", "PreconditionUnmetError");
export const UnsafeTargetError = defineDomainError("unsafe_target", "UnsafeTargetError");
export const RateLimitedError = defineDomainError("rate_limited", "RateLimitedError");
export const QuotaExceededError = defineDomainError("quota_exceeded", "QuotaExceededError");
export const DailyLimitReachedError = defineDomainError("daily_limit_reached", "DailyLimitReachedError");
export const CaptureModeUnavailableError = defineDomainError("capture_mode_unavailable", "CaptureModeUnavailableError");
export const EngineUnavailableError = defineDomainError("engine_unavailable", "EngineUnavailableError");
export const DegradedError = defineDomainError("degraded", "DegradedError");
export const RetentionExceededError = defineDomainError("retention_exceeded", "RetentionExceededError");

export const DOMAIN_ERROR_CLASSES: Record<ErrorCode, DomainErrorClass> = {
  validation_failed: ValidationFailedError,
  unsupported_engine: UnsupportedEngineError,
  unauthenticated: UnauthenticatedError,
  token_expired: TokenExpiredError,
  token_revoked: TokenRevokedError,
  step_up_required: StepUpRequiredError,
  insufficient_credits: InsufficientCreditsError,
  forbidden: ForbiddenError,
  workspace_mismatch: WorkspaceMismatchError,
  project_out_of_scope: ProjectOutOfScopeError,
  entitlement_exceeded: EntitlementExceededError,
  feature_not_in_plan: FeatureNotInPlanError,
  not_found: NotFoundError,
  conflict: ConflictError,
  idempotency_conflict: IdempotencyConflictError,
  workspace_limit_reached: WorkspaceLimitReachedError,
  price_changed: PriceChangedError,
  domain_not_verified: DomainNotVerifiedError,
  precondition_unmet: PreconditionUnmetError,
  unsafe_target: UnsafeTargetError,
  rate_limited: RateLimitedError,
  quota_exceeded: QuotaExceededError,
  daily_limit_reached: DailyLimitReachedError,
  capture_mode_unavailable: CaptureModeUnavailableError,
  engine_unavailable: EngineUnavailableError,
  degraded: DegradedError,
  retention_exceeded: RetentionExceededError,
};

/** Constructs the class registered for `code`. Used where the code is data rather than a literal. */
export function domainErrorFor(code: ErrorCode, init?: DomainErrorInit): DomainError {
  return new DOMAIN_ERROR_CLASSES[code](init);
}
