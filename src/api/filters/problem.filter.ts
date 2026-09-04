import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ErrorCode } from "../../../contracts/common/error-code.schema.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { DomainError, ERROR_STATUS_BY_CODE, type DomainRemediation } from "../errors/domain-errors.js";
import type { AuthenticatedRequest } from "../guards/auth.guard.js";

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

const logger = new Logger("problem-filter");

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

    // EVERY response leaving this filter carries an `error` member, because
    // §2's first paragraph says every error response does and
    // problemDetailsSchema is `.strict()` with `error` required. There is no
    // status that opts out, and there is no second place a request
    // identifier can live.
    //
    // Two fallbacks, one for each side of the 5xx line, and neither invents
    // a code — both name a member of §2's table:
    //
    //   5xx — `internal_error` (STORY-119). §2 previously ran 400…507 with
    //   nothing for "we did not model this", so the only ways to answer were
    //   to force an unrelated code or to drop the `error` member. This filter
    //   dropped it, and the resulting body failed the very schema this API
    //   publishes. §2 now has a 500 row and the choice is gone.
    //
    //   4xx — `validation_failed` (STORY-024 T12). codeForStatus() covers six
    //   statuses, so 415, a bare 422, 405 and anything else the framework
    //   raises arrive unclassified; they are client-side failures and this is
    //   the taxonomy's nearest structural match.
    const isServerError = status >= HttpStatus.INTERNAL_SERVER_ERROR;
    const wireCode: ErrorCode = code ?? (isServerError ? "internal_error" : "validation_failed");

    const body = {
      type: "about:blank",
      title: titleFor(wireCode),
      status,
      detail: message,
      error: {
        code: wireCode,
        message,
        ...(details !== undefined ? { details } : {}),
        ...(remediation !== undefined ? { remediation } : {}),
        request_id: requestId,
      },
    };

    // STORY-024 T12 — coding-standards.md §7: one metric, one redacted log
    // line. The filter owns EVERY error path, and it had neither: because it
    // is @Catch() and globally registered, Nest's own ExceptionsHandler
    // logging never runs, and ResponseEnvelopeInterceptor's log sits inside
    // map(), which never fires on an error. An unexpected 500 wrote zero
    // lines anywhere — while this same filter put a request_id on the body
    // on the stated grounds that a user needs "a reference to quote". There
    // was nothing on the other end of that reference to look up.
    //
    // IDs only, never names, and never `detail` for a 5xx — an unexpected
    // exception's message is the one string most likely to carry a
    // connection string, a row, or a customer's data.
    incrementCounter("nominara_api_error_total", { code: wireCode, status: String(status) });
    logger.error({
      message: "request refused",
      request_id: requestId,
      status,
      code: wireCode,
      workspace_id: (request as AuthenticatedRequest).auth?.ws ?? null,
      ...(isServerError ? {} : { detail: message }),
      // THE STACK, SERVER-SIDE ONLY, AND ONLY FOR A 5xx.
      //
      // The rule above is about the RESPONSE: an unexpected exception's
      // message is the one string most likely to carry a connection string or
      // a row, so it never reaches the client. But it was not reaching the LOG
      // either, and that made a 500 undiagnosable — an operator saw
      // `code: internal_error` and nothing else, with no way to tell a bad
      // query from a failed interceptor. Found the hard way: a real 500 on
      // POST /v1/projects took a manual bisect through the service to locate,
      // because the log said only that a request had been refused.
      //
      // A 4xx is already fully described by its own `detail`, so this adds
      // nothing there and would only make the ordinary case noisy.
      ...(isServerError && exception instanceof Error
        ? { error_name: exception.name, error_message: exception.message, stack: exception.stack }
        : {}),
    });

    // A representation tag may already be on the reply: WorkspacesController
    // sets `ETag` inside the ambient transaction, BEFORE TenantContext-
    // Interceptor commits. If the commit or the audit append then fails, the
    // client would receive a 500 carrying the tag of a row that never
    // existed — and with no item-level GET to re-read from, a client caching
    // tags per URL would be wedged into permanent 409s.
    reply.removeHeader("etag");
    reply.status(status).header("content-type", PROBLEM_CONTENT_TYPE).send(body);
  }
}
