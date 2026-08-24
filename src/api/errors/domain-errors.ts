import { HttpException } from "@nestjs/common";
import type { ErrorCode } from "../../../contracts/common/error-code.schema.js";

// STORY-024 task T9's job. The BASE class is real — T9 builds on it rather
// than replacing it — while the two registries and the factory are stubs
// carrying the signatures test/unit/error-taxonomy.spec.ts commits to, so
// `pnpm typecheck` stays a meaningful gate through the RED phase.
//
// AC1: "Every error in the taxonomy has a typed domain error class, and a
// filter maps it to the wire shape. A controller never builds an error body
// by hand." The filter (T9) reads `code`/`details`/`remediation` off this
// class; nothing constructs a problem+json body itself.
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
    this.remediation = init.remediation;
  }
}

export type DomainErrorClass = new (init?: DomainErrorInit) => DomainError;

// T9 fills both registries. Empty here on purpose: the RED assertions compare
// them against §2's transcribed table and against errorCodeSchema.options, so
// an empty map fails with a readable set difference rather than a crash.
export const ERROR_STATUS_BY_CODE = {} as Record<ErrorCode, number>;

export const DOMAIN_ERROR_CLASSES = {} as Record<ErrorCode, DomainErrorClass>;

export function domainErrorFor(_code: ErrorCode, _init?: DomainErrorInit): DomainError {
  throw new Error("domainErrorFor() is not implemented yet — STORY-024 task T9.");
}
