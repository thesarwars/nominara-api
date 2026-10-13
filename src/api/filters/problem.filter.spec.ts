import type { ArgumentsHost } from "@nestjs/common";
import { HttpException, HttpStatus, NotFoundException, UnsupportedMediaTypeException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { problemDetailsSchema } from "../../../contracts/common/problem-details.schema.js";
import {
  EmailNotVerifiedException,
  EmailOtpInvalidException,
  EntitlementStaleException,
  NotAMemberException,
  OauthFailedException,
  TenantContextMissingError,
  WorkspaceSuspendedException,
} from "../../tenancy/errors.js";
import {
  DegradedError,
  EngineUnavailableError,
  InsufficientCreditsError,
  RetentionExceededError,
  StepUpRequiredError,
} from "../errors/domain-errors.js";
import { ProblemFilter } from "./problem.filter.js";

const REQUEST_ID = "req-42";
// STORY-024 AC9 — the identifier is the trace id: 32 lowercase hex, never the request's own id or a header.
const TRACE_ID = expect.stringMatching(/^[0-9a-f]{32}$/);

function makeHost(headers: Record<string, string> = {}): {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  removeHeader: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const header = vi.fn(() => ({ send }));
  const status = vi.fn(() => ({ header, send }));
  // STORY-024 T12 — `removeHeader` is real FastifyReply API and the filter
  // calls it to strip a pre-commit ETag off an error response. It was
  // missing from this fake, so the fake was a more permissive object than
  // the thing it stands in for; the filter threw TypeError in production
  // shape while every test here passed.
  const removeHeader = vi.fn();
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status, removeHeader }),
      getRequest: () => ({ id: REQUEST_ID, headers }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, header, send, removeHeader };
}

function bodyFrom(exception: unknown, headers?: Record<string, string>): Record<string, unknown> {
  const { host, send, header } = makeHost(headers);
  new ProblemFilter().catch(exception, host);
  expect(header).toHaveBeenCalledWith("content-type", "application/problem+json; charset=utf-8");
  return send.mock.calls[0]![0] as Record<string, unknown>;
}

// STORY-024 T9 — decision D2's dual shape, replacing STORY-022's flat stub.
// STORY-024 T12 — AC2 is now a typecheck: a code with a required details
// shape cannot be constructed without one. These fixtures are the smallest
// payloads satisfying §2's shapes, and every one of them was previously
// `new …Error()` with nothing at all — which compiled, and passed.
const INSUFFICIENT_CREDITS_DETAILS = {
  required: 10,
  available: 2,
  wallet: { included_balance: 0, purchased_balance: 2, reserved: 0, cycle_end: "2026-09-01T00:00:00.000Z" },
  packs: [{ key: "small", credits: 100, price_usd: "10.00" }],
};

const STEP_UP_DETAILS = { methods: ["passkey"] };

describe("STORY-024 · ProblemFilter emits RFC 9457 plus the `error` extension member", () => {
  it("a domain error produces a body satisfying problemDetailsSchema", () => {
    const body = bodyFrom(
      new StepUpRequiredError({ message: "re-authenticate to continue", details: { methods: ["passkey"] } }),
    );

    const parsed = problemDetailsSchema.safeParse(body);
    expect(parsed.success, `body must satisfy the published contract: ${JSON.stringify(body)}`).toBe(true);
    expect(body.status).toBe(401);
    expect((body.error as Record<string, unknown>).code).toBe("step_up_required");
  });

  it("§2's title convention — the code in title case, not the HTTP status name", () => {
    const body = bodyFrom(new InsufficientCreditsError({ message: "not enough credits", details: INSUFFICIENT_CREDITS_DETAILS }));
    expect(body.title).toBe("Insufficient Credits");
  });

  it("code and details live under `error`, never flat at the top level", () => {
    const body = bodyFrom(new StepUpRequiredError({ details: { methods: ["passkey"] } }));

    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("details");
    expect((body.error as Record<string, unknown>).details).toEqual({ methods: ["passkey"] });
  });

  it("carries the 32-hex trace id as the request identifier, never an inbound X-Request-Id", () => {
    const own = (bodyFrom(new StepUpRequiredError({ details: STEP_UP_DETAILS })).error as Record<string, unknown>).request_id;
    expect(own).toEqual(TRACE_ID);
    expect(own).not.toBe(REQUEST_ID);
    const withHeader = (
      bodyFrom(new StepUpRequiredError({ details: STEP_UP_DETAILS }), { "x-request-id": "from-caller" }).error as Record<string, unknown>
    ).request_id;
    expect(withHeader).toEqual(TRACE_ID);
    expect(withHeader).not.toBe("from-caller");
  });

  it("carries the code's remediation so a client can act without a second request", () => {
    const error = bodyFrom(new InsufficientCreditsError({ details: INSUFFICIENT_CREDITS_DETAILS })).error as Record<string, unknown>;
    expect(error.remediation).toEqual({ kind: "purchase_credits" });
  });
});

// The six codes thrown inside src/ that §2 does not contain. Mapped at this
// boundary so the guards and their existing tests keep their own vocabulary.
describe("STORY-024 · decision D12 — out-of-taxonomy codes are mapped on the way out", () => {
  const CASES = [
    { name: "NotAMemberException", make: () => new NotAMemberException(), code: "forbidden", reason: "not_a_member" },
    {
      name: "WorkspaceSuspendedException",
      make: () => new WorkspaceSuspendedException(),
      code: "forbidden",
      reason: "workspace_suspended",
    },
    {
      name: "EntitlementStaleException",
      make: () => new EntitlementStaleException(),
      code: "unauthenticated",
      reason: "entitlement_stale",
    },
    {
      name: "EmailNotVerifiedException",
      make: () => new EmailNotVerifiedException(),
      code: "forbidden",
      reason: "email_not_verified",
    },
    {
      name: "OauthFailedException",
      make: () => new OauthFailedException("req-1"),
      code: "validation_failed",
      reason: "oauth_failed",
    },
    {
      name: "EmailOtpInvalidException",
      make: () => new EmailOtpInvalidException(),
      code: "validation_failed",
      reason: "otp_invalid",
    },
  ] as const;

  it.each(CASES)("$name goes out as $code, keeping reason=$reason", ({ make, code, reason }) => {
    const error = bodyFrom(make()).error as Record<string, unknown>;

    expect(error.code).toBe(code);
    expect((error.details as Record<string, unknown>).reason, "the original condition must survive").toBe(reason);
  });

  it("the class itself is untouched — it still throws its own vocabulary", () => {
    const thrown = new NotAMemberException().getResponse() as { code: string };
    expect(thrown.code, "src/tenancy/errors.ts must keep working unchanged").toBe("not_a_member");
  });

  it("merges reason into details the thrower already supplied rather than replacing them", () => {
    const error = bodyFrom(new OauthFailedException("req-9")).error as Record<string, unknown>;
    expect(error.details).toEqual({ request_id: "req-9", reason: "oauth_failed" });
  });
});

describe("STORY-024 · errors outside the taxonomy", () => {
  // STORY-119 — §2 now has a 500 row, so an unexpected failure has a member
  // of the taxonomy to carry and the body is an ordinary problem+json like
  // every other error. Before it, the filter had to choose between inventing
  // a code and dropping the `error` member; it dropped the member, and the
  // resulting body failed the schema this API publishes.
  it("a generic Error is a 500 carrying `internal_error`, and leaks no internal message", () => {
    const body = bodyFrom(new Error("raw internal detail"));

    expect(body).toEqual({
      type: "about:blank",
      title: "Internal Error",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: "internal server error",
      error: {
        code: "internal_error",
        message: "internal server error",
        request_id: TRACE_ID,
      },
    });
  });

  // The identifier used to sit at the top level BECAUSE there was no `error`
  // member to put it in. Now that there is one, leaving it in both places
  // would give a client two answers to one question — and problemDetailsSchema
  // is `.strict()`, so a leftover top-level member fails the contract outright.
  it("carries the request identifier in exactly one place", () => {
    const body = bodyFrom(new Error("boom"));
    expect(body).not.toHaveProperty("request_id");
    expect((body.error as Record<string, unknown>).request_id).toEqual(TRACE_ID);
  });

  // The exception's own message is the string most likely to carry a
  // connection string, a row, or customer data. It must appear under NO
  // member — not `detail`, not `error.message`, not `error.details`.
  it("puts the exception's own text nowhere in the body", () => {
    const secret = "postgres://user:hunter2@10.0.0.4:5432/nominara";
    expect(JSON.stringify(bodyFrom(new Error(secret)))).not.toContain("hunter2");
  });

  // `internal_error` is for the UNMODELLED failure. A 5xx that §2 already
  // models keeps its own code — collapsing these into one would erase the
  // distinction the table exists to draw, and a client would render "retry"
  // where "the circuit is open" or "partial results are available" was true.
  it.each([
    [
      new EngineUnavailableError({ details: { circuit_opened_at: "2026-08-25T09:00:00.000Z" } }),
      "engine_unavailable",
      HttpStatus.BAD_GATEWAY,
    ],
    [new DegradedError(), "degraded", HttpStatus.SERVICE_UNAVAILABLE],
    [new RetentionExceededError(), "retention_exceeded", HttpStatus.INSUFFICIENT_STORAGE],
  ])("a modelled 5xx keeps its own code, never internal_error (%#)", (exception, expectedCode, expectedStatus) => {
    const body = bodyFrom(exception);
    expect(body.status).toBe(expectedStatus);
    expect((body.error as Record<string, unknown>).code).toBe(expectedCode);
  });

  it("TenantContextMissingError (a plain Error, not an HttpException) is a well-formed 500", () => {
    const body = bodyFrom(new TenantContextMissingError("req.tenant is unset"));
    expect(body.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.detail).toBe("internal server error");
  });

  // A framework-raised HttpException predates the taxonomy and still has to
  // land on a §2 code, because §2 is the only vocabulary the wire has.
  it("a bare HttpException is given the taxonomy code its status implies", () => {
    const error = bodyFrom(new HttpException("nope", HttpStatus.FORBIDDEN)).error as Record<string, unknown>;
    expect(error.code).toBe("forbidden");
  });

  // STORY-024 T12 — the assertion that would have caught the 4xx defect.
  // T9 keyed the error-less branch on `code === undefined` rather than on
  // 5xx, so every 4xx outside codeForStatus()'s six statuses emitted a body
  // with no `error` member and an unknown top-level `request_id` — a shape
  // problemDetailsSchema rejects on both counts. Every test here asserted
  // with toEqual({...}) and none ran the body through the schema, which is
  // the one check that makes the filter and the published contract agree.
  describe("the emitted body satisfies the contract this API publishes", () => {
    it.each([
      ["415 unsupported media type", new UnsupportedMediaTypeException("nope"), HttpStatus.UNSUPPORTED_MEDIA_TYPE],
      ["a bare 422", new HttpException("nope", HttpStatus.UNPROCESSABLE_ENTITY), HttpStatus.UNPROCESSABLE_ENTITY],
      ["a bare 405", new HttpException("nope", HttpStatus.METHOD_NOT_ALLOWED), HttpStatus.METHOD_NOT_ALLOWED],
    ])("%s is a well-formed problem+json carrying an error member", (_label, exception, expectedStatus) => {
      const body = bodyFrom(exception);
      expect(body.status).toBe(expectedStatus);
      const parsed = problemDetailsSchema.safeParse(body);
      expect(
        parsed.success,
        `body must satisfy problemDetailsSchema: ${JSON.stringify(parsed.success ? {} : parsed.error.issues)}`,
      ).toBe(true);
    });

    it("a mapped 4xx also satisfies it", () => {
      const parsed = problemDetailsSchema.safeParse(bodyFrom(new NotFoundException()));
      expect(parsed.success).toBe(true);
    });

    // STORY-119 — this was a NAMED WAIVER asserting the opposite: that an
    // unexpected 5xx did NOT satisfy the schema, because §2 had no code for
    // an unmodelled failure and the body therefore omitted `error`. §2 now
    // has one, so the waiver is deleted rather than left to outlive its
    // reason, and the assertion is inverted into the requirement.
    //
    // There is no status the service can emit that is exempt from this.
    it("an unexpected 5xx satisfies it too — no status is exempt from the published contract", () => {
      const body = bodyFrom(new Error("boom"));
      expect(body.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      const parsed = problemDetailsSchema.safeParse(body);
      expect(
        parsed.success,
        `body must satisfy problemDetailsSchema: ${JSON.stringify(parsed.success ? {} : parsed.error.issues)}`,
      ).toBe(true);
    });
  });
});
