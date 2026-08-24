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
import { InsufficientCreditsError, StepUpRequiredError } from "../errors/domain-errors.js";
import { ProblemFilter } from "./problem.filter.js";

const REQUEST_ID = "req-42";

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

  it("carries the request identifier, honouring an inbound X-Request-Id", () => {
    expect((bodyFrom(new StepUpRequiredError({ details: STEP_UP_DETAILS })).error as Record<string, unknown>).request_id).toBe(REQUEST_ID);
    expect(
      (bodyFrom(new StepUpRequiredError({ details: STEP_UP_DETAILS }), { "x-request-id": "from-caller" }).error as Record<string, unknown>)
        .request_id,
    ).toBe("from-caller");
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
  // §2's table has no row for an unexpected 5xx, so there is no code to put
  // in an `error` member. Such a response carries RFC 9457's members plus a
  // top-level request_id — a 500 is exactly when a user needs a reference to
  // quote, so the identifier stays even though the taxonomy code cannot.
  it("a generic Error is a 500 that leaks no internal message but still identifies the request", () => {
    const body = bodyFrom(new Error("raw internal detail"));

    expect(body).toEqual({
      type: "about:blank",
      title: "INTERNAL_SERVER_ERROR",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: "internal server error",
      request_id: REQUEST_ID,
    });
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

    // NAMED DEVIATION, not an oversight. api-specification.md §2's table runs
    // 400…507 and contains NO code for "we did not model this", so an
    // unexpected 5xx has no taxonomy member to carry and its body omits
    // `error` — which problemDetailsSchema, being `.strict()` with `error`
    // required, therefore rejects. This test PINS that deviation rather than
    // leaving it invisible: it goes red the moment the 5xx body starts
    // conforming, which is exactly when the follow-up story (an
    // `internal_error` taxonomy code) lands and this waiver should be
    // deleted rather than quietly outliving its reason.
    it("an unexpected 5xx deliberately does NOT satisfy it — §2 has no code for an unmodelled error", () => {
      const body = bodyFrom(new Error("boom"));
      expect(body.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body).not.toHaveProperty("error");
      expect(
        problemDetailsSchema.safeParse(body).success,
        "if this is now true, §2 gained a code for an unmodelled 5xx — delete this waiver",
      ).toBe(false);
    });
  });
});
