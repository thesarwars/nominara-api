import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ErrorCode } from "../../../contracts/common/error-code.schema.js";
import { DomainError, ERROR_STATUS_BY_CODE, type DomainRemediation } from "../errors/domain-errors.js";

// STORY-024 T9 — AC1: "a filter maps it to the wire shape". Decision D2's
// dual shape, from api-specification.md §2: RFC 9457's top-level members
// (`type`, `title`, `status`, `detail`) PLUS an `error` extension member
// carrying `code`, `message`, `details`, `remediation` and `request_id`.
// The RFC members are what a generic HTTP client already understands; the
// `error` member is what a Nominara client renders. Served as
// `application/problem+json` (§1).
//
// Replaces STORY-022's stub, which emitted `code`/`details` FLAT at the top
// level, carried no request_id, and sent application/json.
const PROBLEM_CONTENT_TYPE = "application/problem+json; charset=utf-8";

// Decision D12 — six codes thrown inside src/ are OUTSIDE §2's closed
// taxonomy. `problemErrorSchema.code` is `errorCodeSchema`, so putting any
// of them on the wire would break the contract STORY-023 published. They are
// mapped HERE, at the boundary, and NOT in src/tenancy/errors.ts: the guards
// and their tests keep throwing and asserting their own richer vocabulary
// unchanged, which is both what the execution plan requires and what AC1
// describes ("a filter maps it to the wire shape"). The original condition
// survives as `details.reason`, so support can still tell a suspended
// workspace from a non-member even though both are `403 forbidden`.
const TAXONOMY_CODE_BY_LEGACY_CODE: Record<string, ErrorCode> = {
  not_a_member: "forbidden",
  workspace_suspended: "forbidden",
  entitlement_stale: "unauthenticated",
  email_not_verified: "forbidden",
  oauth_failed: "validation_failed",
  otp_invalid: "validation_failed",
};

// §2's own example titles the 402 "Insufficient Credits" — the code in title
// case, not the HTTP status name. Derived rather than tabulated so a new code
// cannot ship with a missing title.
function titleFor(code: ErrorCode): string {
  return code
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** §1: "`X-Request-Id` — optional. Echoed in responses and logs; generated if absent." */
function requestIdOf(request: FastifyRequest | undefined): string {
  const supplied = request?.headers?.["x-request-id"];
  if (typeof supplied === "string" && supplied.length > 0) return supplied;
  return String(request?.id ?? "");
}

interface Classified {
  readonly status: number;
  readonly code: ErrorCode | undefined;
  readonly message: string;
  readonly details: unknown;
  readonly remediation: DomainRemediation | undefined;
}

function classify(exception: unknown): Classified {
  if (exception instanceof DomainError) {
    return {
      status: exception.getStatus(),
      code: exception.code,
      message: exception.message,
      details: exception.details,
      remediation: exception.remediation,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const body = typeof response === "object" && response !== null ? (response as Record<string, unknown>) : {};
    const thrownCode = typeof body.code === "string" ? body.code : undefined;
    const message = typeof body.message === "string" ? body.message : exception.message;
    const details = "details" in body ? body.details : undefined;

    if (thrownCode !== undefined) {
      const mapped = TAXONOMY_CODE_BY_LEGACY_CODE[thrownCode];
      if (mapped !== undefined) {
        // The original code becomes `details.reason`, merged into whatever
        // details the thrower already supplied rather than replacing them.
        const existing = typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
        return { status, code: mapped, message, details: { ...existing, reason: thrownCode }, remediation: undefined };
      }
      if (thrownCode in ERROR_STATUS_BY_CODE) {
        return { status, code: thrownCode as ErrorCode, message, details, remediation: undefined };
      }
    }

    return { status, code: codeForStatus(status), message, details, remediation: undefined };
  }

  // Anything else is an unexpected failure: 500, and the message never
  // reaches the client (coding-standards.md §6 — an internal detail is not a
  // user-facing string).
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: undefined,
    message: "internal server error",
    details: undefined,
    remediation: undefined,
  };
}

// An HttpException raised by the framework itself (a 404 from the router, a
// 401 from a guard that predates the taxonomy) still has to land on a
// taxonomy code, because §2 is the only vocabulary the wire has.
function codeForStatus(status: number): ErrorCode | undefined {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return "validation_failed";
    case HttpStatus.UNAUTHORIZED:
      return "unauthenticated";
    case HttpStatus.FORBIDDEN:
      return "forbidden";
    case HttpStatus.NOT_FOUND:
      return "not_found";
    case HttpStatus.CONFLICT:
      return "conflict";
    case HttpStatus.TOO_MANY_REQUESTS:
      return "rate_limited";
    default:
      return undefined;
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const { status, code, message, details, remediation } = classify(exception);
    const requestId = requestIdOf(request);

    // §2 has NO code for an unexpected 5xx — its table runs 400…507 with
    // nothing for "we did not model this". Rather than invent a taxonomy
    // member or force an unrelated one, such a response carries RFC 9457's
    // members plus a top-level `request_id` (a legal extension member) and
    // omits the `error` member entirely. A 500 is exactly the case where a
    // user most needs a reference to quote, so dropping the identifier too
    // would be the worst possible trade.
    const body =
      code === undefined
        ? { type: "about:blank", title: HttpStatus[status] ?? "error", status, detail: message, request_id: requestId }
        : {
            type: "about:blank",
            title: titleFor(code),
            status,
            detail: message,
            error: {
              code,
              message,
              ...(details !== undefined ? { details } : {}),
              ...(remediation !== undefined ? { remediation } : {}),
              request_id: requestId,
            },
          };

    reply.status(status).header("content-type", PROBLEM_CONTENT_TYPE).send(body);
  }
}
